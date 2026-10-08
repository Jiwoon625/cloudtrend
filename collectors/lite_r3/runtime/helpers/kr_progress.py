"""Observability-only wrappers for the hash-verified KR publisher runtime."""
def install_publish_progress(namespace, heartbeat_seconds=30.0, poll_seconds=0.2, terminate_grace_seconds=5.0):
    import functools
    import json
    import os
    import queue
    import re
    import signal
    import subprocess
    import threading
    import time
    from datetime import datetime, timezone
    from pathlib import Path

    ns = namespace
    if ns.get('_CT_PROGRESS_WRAPPED_PUBLISH') is ns.get('publish_to_supabase'):
        return
    if ns.get('_CT_PUBLISH_GROUP_CLEANUP_PENDING'):
        raise ns['PublishStopped']('이전 게시 프로세스 그룹의 종료 확인이 필요합니다. 중복 실행하지 않습니다.')
    active = ns.get('_CT_ACTIVE_PUBLISH_CHILD')
    if active is not None and active.poll() is None:
        raise ns['PublishStopped']('이전 게시 자식 프로세스가 아직 실행 중입니다. 중복 등록을 시작하지 않습니다.')
    state = {'session': None}
    output_lock = threading.RLock()
    labels = {
        'QA_PASSED': '로컬 검증 완료', 'REGISTERING': '원천 등록·활성화',
        'REGISTERED_PART': '원천 등록·재조회 완료', 'SYNCING_LEGACY': '웹 호환 자료 동기화',
        'PUBLISHED': '전체 게시 완료', 'STOPPED': '오류로 중단', 'INTERRUPTED': '사용자 중단',
    }

    def sanitize(value, env=None):
        secrets = dict((state.get('session') or {}).get('redactions', {}))
        secrets.update(env or {})
        text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', str(value))
        text = ''.join(c for c in text if c in '\n\t' or ord(c) >= 32)
        for name, value in secrets.items():
            if any(word in name.upper() for word in ('KEY', 'TOKEN', 'PASSWORD', 'SECRET')) and value:
                text = text.replace(str(value), '[REDACTED]')
                for part in str(value).splitlines():
                    if len(part) >= 4:
                        text = text.replace(part, '[REDACTED]')
        text = ns['redact_error'](text, secrets)
        text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
        text = ''.join(c for c in text if c in '\n\t' or ord(c) >= 32)
        return text.strip()

    def console_line(line):
        try:
            print(line, flush=True)
        except Exception:
            # A closed notebook output channel must not turn a successful write into failure.
            pass

    def emit(message, env=None, elapsed=None):
        session = state.get('session')
        elapsed = time.monotonic() - session['started'] if session else (elapsed or 0.0)
        safe = sanitize(message, env)
        lines = safe.splitlines() or ['']
        with output_lock:
            for item in lines:
                line = f'[게시 {elapsed:7.1f}초] {item}'
                console_line(line)
                if session and session.get('log_queue') is not None:
                    try:
                        session['log_queue'].put_nowait(line)
                    except queue.Full:
                        if not session.get('log_backpressure'):
                            session['log_backpressure'] = True
                            console_line('[게시 로그] Drive 기록 대기열이 가득 찼습니다. 일부 파일 로그는 생략하며 화면 출력과 게시 처리는 계속합니다.')

    def stage(message):
        if state.get('session'):
            state['session']['stage'] = message
        emit(message)

    def stop_owned_child(proc):
        """Terminate/reap only the group created here with start_new_session=True."""
        signal_ok = True
        def send(sig):
            nonlocal signal_ok
            try:
                os.killpg(proc.pid, sig)
            except ProcessLookupError:
                pass
            except OSError:
                signal_ok = False
        # The leader may have exited while one of its children still holds a pipe.
        # Signal the owned group, not merely the leader, in every cancellation path.
        send(signal.SIGTERM)
        try:
            proc.wait(timeout=terminate_grace_seconds)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            pass
        send(signal.SIGKILL)
        try:
            proc.wait(timeout=terminate_grace_seconds)
        except (subprocess.TimeoutExpired, KeyboardInterrupt):
            pass
        stopped = signal_ok and proc.poll() is not None
        ns['_CT_PUBLISH_GROUP_CLEANUP_PENDING'] = not stopped
        if state.get('session'):
            state['session']['child_stopped'] = stopped
        return stopped

    def run_private(args, cwd=None, env=None, timeout=600):
        prior = ns.get('_CT_ACTIVE_PUBLISH_CHILD')
        if ns.get('_CT_PUBLISH_GROUP_CLEANUP_PENDING') or (prior is not None and prior.poll() is None):
            raise ns['PublishStopped']('이전 게시 자식/프로세스 그룹 종료 확인 전에는 중복 실행하지 않습니다.')
        child_env = env or ns['clean_child_env']()
        started = time.monotonic()
        mode = child_env.get('CT_MODE', '')
        purpose = {'validate': '4/6 병합 파일 형식 검증', 'merge': '5/6 기존 원천 검증 후 등록·활성화',
                   'reuse': '6/6 등록 원천 재사용·웹 호환 자료 동기화'}.get(mode, '게시 도구 준비')
        stage(purpose)
        emit(f'최대 대기 {timeout}초. 진행률을 추정하지 않고 실제 출력과 경과 시간을 표시합니다.', elapsed=0)
        proc = None
        raw = {'stdout': [], 'stderr': []}
        events = queue.Queue()
        readers = []
        try:
            proc = subprocess.Popen(args, cwd=cwd, env=child_env, text=True,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=1, start_new_session=True)
            ns['_CT_ACTIVE_PUBLISH_CHILD'] = proc
            if state.get('session'):
                state['session']['child_stopped'] = False
            def pump(name, pipe):
                try:
                    # Keep a whole logical line, including a final line without newline,
                    # before redacting. Never print partial credential fragments.
                    for line in iter(pipe.readline, ''):
                        events.put((name, line))
                finally:
                    events.put((name, None))
            for name, pipe in [('stdout', proc.stdout), ('stderr', proc.stderr)]:
                t = threading.Thread(target=pump, args=(name, pipe), daemon=True)
                t.start(); readers.append(t)
            ended = set()
            next_heartbeat = started + heartbeat_seconds
            while len(ended) < 2 or proc.poll() is None:
                now = time.monotonic()
                if timeout is not None and now - started >= timeout:
                    stopped = stop_owned_child(proc)
                    raise ns['PublishStopped'](
                        f'등록 도구 시간 초과({timeout}초). 자식 종료 확인={stopped}. 원격 반영 여부를 재조회한 뒤 재시도하세요.')
                try:
                    name, line = events.get(timeout=poll_seconds)
                    if line is None:
                        ended.add(name)
                    else:
                        raw[name].append(line)
                        if line.strip():
                            emit(f'{purpose} | {name}: {line.rstrip()}', child_env,
                                 elapsed=time.monotonic() - started)
                except queue.Empty:
                    pass
                if state.get('session') is None and now >= next_heartbeat:
                    emit(f'{purpose} 진행 중 · 자식 경과 {now-started:.0f}초', child_env,
                         elapsed=now-started)
                    next_heartbeat = now + heartbeat_seconds
            code = proc.wait()
            if state.get('session'):
                state['session']['child_stopped'] = True
            stdout, stderr = ''.join(raw['stdout']), ''.join(raw['stderr'])
            if code != 0:
                detail = sanitize(stderr or stdout, child_env)
                if 'heap out of memory' in detail.lower() or code in (-6, -9, 134, 137):
                    detail = '등록 프로세스 메모리 부족/강제 종료. ' + detail
                raise ns['PublishStopped'](f'등록 도구 종료 코드 {code}: {detail or "상세 출력 없음"}')
            emit(f'{purpose} 완료 · 자식 경과 {time.monotonic()-started:.1f}초', child_env)
            return stdout  # Preserve exact PUBLISH_RESULT payload for the original parser.
        except KeyboardInterrupt:
            stopped = stop_owned_child(proc) if proc is not None else True
            emit(f'중단 요청 수신 · 실행한 자식 종료 확인={stopped}. 서버 반영 여부는 아직 확인하지 않았습니다.', child_env)
            raise
        except OSError:
            if proc is not None:
                stop_owned_child(proc)
            raise ns['PublishStopped']('등록 도구 실행 실패입니다. 원본과 영수증을 보존했습니다.') from None
        finally:
            if proc is not None:
                if proc.poll() is None:
                    stop_owned_child(proc)
                for t in readers:
                    t.join(timeout=0.5)
                if any(t.is_alive() for t in readers):
                    ns['_CT_PUBLISH_GROUP_CLEANUP_PENDING'] = True
                    if state.get('session'):
                        state['session']['child_stopped'] = False
                if (ns.get('_CT_ACTIVE_PUBLISH_CHILD') is proc and proc.poll() is not None
                        and not ns.get('_CT_PUBLISH_GROUP_CLEANUP_PENDING')):
                    ns['_CT_ACTIVE_PUBLISH_CHILD'] = None
                for t, pipe in zip(readers, (proc.stdout, proc.stderr)):
                    if pipe is not None and not t.is_alive():
                        try: pipe.close()
                        except OSError: pass

    ns['run_private'] = run_private
    for name, title in [
        ('local_qa', '1/6 manifest·원본 크기·해시·행수 검증'),
        ('source_registry', '활성 원천 등록 목록 확인'),
        ('prepare_period_merge', '2/6 기존 원천과 빈값 보존 병합'),
        ('write_publish_chunks', '3/6 게시 파일 준비'),
    ]:
        original = ns[name]
        def make_wrapper(original, title):
            @functools.wraps(original)
            def wrapped(*args, **kwargs):
                stage(title)
                started = time.monotonic()
                value = original(*args, **kwargs)
                emit(f'{title} 완료 · {time.monotonic()-started:.1f}초')
                return value
            return wrapped
        ns[name] = make_wrapper(original, title)

    original_publish = ns['publish_to_supabase']
    @functools.wraps(original_publish)
    def publish_with_progress(ctx, manifest_path, run_id):
        if state.get('session') is not None:
            raise ns['PublishStopped']('이미 게시 작업이 실행 중입니다. 중복 등록을 시작하지 않습니다.')
        if ns.get('_CT_PUBLISH_GROUP_CLEANUP_PENDING'):
            raise ns['PublishStopped']('이전 게시 프로세스 그룹의 종료 확인이 필요합니다. 중복 실행하지 않습니다.')
        active = ns.get('_CT_ACTIVE_PUBLISH_CHILD')
        if active is not None and active.poll() is None:
            raise ns['PublishStopped']('이전 게시 자식이 아직 실행 중입니다. 종료 확인 후 재시도하세요.')
        folder = Path(manifest_path).parent
        receipt_path = folder / 'publish_receipt.json'
        session = {'started': time.monotonic(), 'stage': '게시 시작', 'receipt_path': receipt_path,
                   'log_path': folder / 'publish_progress.log', 'redactions': {'SUPABASE_SERVICE_ROLE_KEY': ctx.get('key', '')},
                   'child_stopped': True}
        session['log_queue'] = queue.Queue(maxsize=1000)
        session['log_stop'] = threading.Event()
        def write_log():
            while not session['log_stop'].is_set() or not session['log_queue'].empty():
                try:
                    line = session['log_queue'].get(timeout=0.1)
                except queue.Empty:
                    continue
                try:
                    with session['log_path'].open('a', encoding='utf-8') as f:
                        f.write(line + '\n')
                except Exception:
                    if not session.get('log_failed'):
                        session['log_failed'] = True
                        console_line('[게시 로그] Drive 로그 저장이 지연/실패했습니다. 화면 출력과 원래 게시 처리는 계속합니다.')
        log_writer = threading.Thread(target=write_log, daemon=True)
        log_writer.start()
        state['session'] = session
        stop = threading.Event()
        try:
            initial_mtime = receipt_path.stat().st_mtime_ns
        except OSError:
            initial_mtime = None
        def watch():
            last_mtime, last_status = initial_mtime, None
            next_heartbeat = time.monotonic() + heartbeat_seconds
            while not stop.wait(min(1.0, heartbeat_seconds)):
                try:
                    stamp = receipt_path.stat().st_mtime_ns
                    if stamp != last_mtime:
                        receipt = json.loads(receipt_path.read_text(encoding='utf-8'))
                        if receipt.get('runId') == run_id:
                            status = receipt.get('status')
                            if status != last_status:
                                emit(f'영수증 상태: {labels.get(status, status)} ({status}) · 확인된 분할 파일 {len(receipt.get("parts", []))}개')
                                last_status = status
                        last_mtime = stamp
                except (OSError, ValueError, TypeError):
                    pass
                now = time.monotonic()
                if now >= next_heartbeat:
                    emit(f'진행 중: {session["stage"]} · 서버 완료 여부는 마지막 검증 결과로 확인합니다.')
                    next_heartbeat = now + heartbeat_seconds
        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        try:
            emit(f'게시 시작 · runId={run_id} · 로그: {session["log_path"]}')
            result = original_publish(ctx, manifest_path, run_id)
            emit(f'게시 함수 완료 · 영수증 {result.get("status", "확인 필요") if isinstance(result, dict) else "확인 필요"}')
            return result
        except KeyboardInterrupt:
            try:
                receipt = json.loads(receipt_path.read_text(encoding='utf-8')) if receipt_path.exists() else {'runId': run_id, 'parts': []}
                if receipt.get('runId') != run_id:
                    raise ValueError('다른 실행의 영수증은 변경하지 않습니다.')
                if receipt.get('status') == 'PUBLISHED':
                    emit('이미 PUBLISHED가 기록되어 있습니다. 완료 영수증은 중단 상태로 바꾸지 않습니다.')
                else:
                    receipt['interruptedStage'] = receipt.get('status', session['stage'])
                    receipt['status'] = 'INTERRUPTED'
                    receipt['interruptedAt'] = datetime.now(timezone.utc).isoformat()
                    receipt['childProcessStopped'] = bool(session['child_stopped'])
                    receipt['remoteStateVerifiedAfterInterrupt'] = False
                    receipt['resumeRequiresRegistryCheck'] = True
                    temp = receipt_path.with_name(receipt_path.name + '.progress.tmp')
                    temp.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding='utf-8')
                    temp.replace(receipt_path)
                    emit('INTERRUPTED 영수증 저장. 기존 parts·원본·체크포인트는 보존했습니다. 재개 전 서버 등록 상태를 확인하세요.')
            except (OSError, ValueError, TypeError):
                emit('중단 영수증 갱신을 확인하지 못했습니다. 기존 파일을 보존했으며 재개 전 상태 확인이 필요합니다.')
            raise
        except Exception as error:
            emit(f'게시 중단: {error}', session['redactions'])
            raise
        finally:
            stop.set(); watcher.join(timeout=2.0)
            session['log_stop'].set(); log_writer.join(timeout=2.0)
            if log_writer.is_alive():
                console_line('[게시 로그] 파일 로그 저장이 아직 지연 중입니다. 게시 결과는 영수증과 서버 조회로 확인하세요.')
            state['session'] = None

    ns['publish_to_supabase'] = publish_with_progress
    ns['_CT_PROGRESS_WRAPPED_PUBLISH'] = publish_with_progress
    ns['_CT_PUBLISH_PROGRESS_VERSION'] = 'sanitized-stream-v1'
    ns['_CT_PUBLISH_PROGRESS_SANITIZE'] = sanitize
    console_line('게시 진행 로그 준비 완료: 단계·30초 경과 안내·정제된 자식 출력·중단 영수증을 기록합니다.')
