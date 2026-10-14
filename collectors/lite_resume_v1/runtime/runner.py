"""Resume orchestration around the pinned collector, with a private durable journal.

No credentials are serialized. Existing upload/dispatch receipts remain the
source of truth. This preview does not enable operational writes by default.
"""
import io
import json
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo
from .state import RunState, RunLock, atomic_write, canonical, digest
from .kr import enrich_dates, install_cache
from .us import gap_inventory

CONFIG = ('RUN_PLAN', 'RUN_US_EVENING', 'UNIVERSE_MODE', 'ETF_UNIVERSE_MODE',
          'COLLECTION_DAYS', 'KR_COLLECTION_DAYS', 'SCHEMA_REVIEW_DATE',
          'FORCE_FULL_REFRESH', 'COLLECT_TOSS_SHORT', 'COLLECT_TOSS_LENDING',
          'INPUT_REVISION', '_CT_RUNTIME_LOADED_SHA')
KR_BOOKS = ('KR_KOSPI', 'KR_KOSDAQ', 'KR_MIXED', 'KR_KOSPI_CONFIRM1_BEAR', 'ETF_V02')


def _clock(ns):
    return datetime.fromisoformat(ns['_CT_RUN_CLOCK']).astimezone(ZoneInfo('Asia/Seoul'))


def _json_frame(frame):
    # JSON records convert pandas null scalars without pickle/code execution.
    return json.loads(frame.to_json(orient='table', date_format='iso'))


def _freeze_api(ns, state, attribute=None):
    original = ns['toss_get'] if attribute is None else ns['client'].get
    def request(endpoint, *args, **kwargs):
        if endpoint not in ('/api/v1/stocks', '/api/v1/stocks/all', '/api/v1/exchange-rate'):
            return original(endpoint, *args, **kwargs)
        dependency = dict(endpoint=endpoint, args=args, kwargs=kwargs,
                          market='US' if attribute is None else 'KR')
        key = 'metadata-' + digest(canonical(dependency))[7:]
        saved = state.load_json(key, dependency)
        if saved is not None:
            return (saved['body'], {}) if attribute is None else saved['body']
        # Do not complete yesterday's partial current-roster snapshot using today's
        # current metadata. Already saved exact responses remain reusable.
        if datetime.now(ZoneInfo('Asia/Seoul')).date() != _clock(ns).date():
            raise RuntimeError('WAITING_INPUT: unsaved historical metadata cannot be filled from current /stocks')
        result = original(endpoint, *args, **kwargs)
        body = result[0] if attribute is None else result
        state.save_json(key, dependency, {'body': body,
                        'collectedAt': datetime.now(timezone.utc).isoformat(),
                        'effectiveAt': None, 'sourceVersion': digest(canonical(body))})
        return result
    if attribute is None:
        ns['toss_get'] = request
    else:
        ns['client'].get = request


def _kr_watermarks(ns):
    rows = {}
    for kind in KR_BOOKS:
        response = ns['requests'].get(ns['SUPABASE_URL'] + '/rest/v1/ledger_model_sessions',
            headers={'apikey': ns['SUPABASE_SERVICE_ROLE_KEY'],
                     'Authorization': 'Bearer ' + ns['SUPABASE_SERVICE_ROLE_KEY']},
            params={'user_id': 'eq.' + ns['SUPABASE_USER_ID'],
                    'series_id': 'eq.adopted-shadow-2026-10-12-v1:' + kind,
                    'select': 'session_date,state_hash', 'order': 'session_date.desc', 'limit': '1'}, timeout=30)
        response.raise_for_status()
        value = response.json()
        if not isinstance(value, list) or len(value) != 1:
            raise RuntimeError('Verified KR predecessor missing: ' + kind)
        rows[kind] = value[0]
    return rows


def _after(stage, ns, state):
    if stage == 'plan_init':
        ns['INTEGRATED_SLOT'], ns['RUN_KR_MARKET'], ns['RUN_US_MARKET'] = ns['resolve_integrated_run_plan'](ns['RUN_PLAN'], _clock(ns))
    if stage == 'common_init' and ns['RUN_KR_MARKET']:
        ns['_CT_KR_WATERMARKS'] = state.freeze('kr-watermarks', _kr_watermarks(ns))
    if stage == 'kr_setup' and ns['RUN_KR_MARKET']:
        # Reference date is exclusive, resolved once. Explicit original user dates
        # retain their meaning. Current clock must not move the run on restart.
        reference = state.freeze('kr-reference', {'reference': ns['SCHEMA_REVIEW_DATE']})
        ns['SCHEMA_REVIEW_DATE'] = reference['reference']
        ns['REFRESH_CACHE'] = bool(ns.get('FORCE_FULL_REFRESH', False))
    if stage == 'kr_runtime' and ns['RUN_KR_MARKET']:
        # Use in-memory copies of the verified ZIP. The private ZIP bytes are never
        # modified. These exact replacements fail closed on a different dependency.
        for name in ('step_07.py',):
            source = ns['_kr_steps'][name]
            source = source.replace('pd.Timestamp.now(tz="Asia/Seoul")', 'pd.Timestamp(_CT_RUN_CLOCK).tz_convert("Asia/Seoul")')
            ns['_kr_steps'][name] = source
    if stage == 'kr_connections' and ns['RUN_KR_MARKET']:
        original = ns['official_current_etfs']
        def etfs():
            saved = state.frozen('kr-etf-universe')
            if saved is not None:
                return saved
            if datetime.now(ZoneInfo('Asia/Seoul')).date() != _clock(ns).date():
                raise RuntimeError('WAITING_INPUT: saved ETF universe missing')
            return state.freeze('kr-etf-universe', original())
        ns['official_current_etfs'] = etfs
    if stage == 'kr_functions' and ns['RUN_KR_MARKET']:
        _freeze_api(ns, state, 'get')
    if stage == 'kr_universe' and ns['RUN_KR_MARKET']:
        ns['RUN_ID'] = state.plan['runId']
        ns['OUTPUT_ROOT'] = state.root / 'kr-outputs'
        ns['OUTPUT_ROOT'].mkdir(parents=True, exist_ok=True)
        actual = {'stocks': ns['STOCKS'], 'etfs': ns['ETFS']}
        if state.freeze('kr-universe', actual) != actual:
            raise RuntimeError('KR universe changed; saved execution cannot reuse it')
    if stage == 'kr_calendar' and ns['RUN_KR_MARKET']:
        # Fetch exchange-observed index sessions; never infer holidays from weekdays.
        target = ns['COLLECTION_CUTOFF_DATE']
        base = min(row['session_date'] for row in ns['_CT_KR_WATERMARKS'].values())
        probes = ns['_kr_supply_probes']['KOSPI']
        if base not in set(probes['date'].astype(str)):
            probes = ns['get_candles_frame']('KOSPI', 400, True)
        days = sorted(set(probes['date'].astype(str)))
        if base not in days:
            raise RuntimeError('KR calendar coverage insufficient; no dates silently omitted')
        needed = [day for day in days if max(base, '2026-10-11') < day <= target]
        frozen = state.freeze('kr-dates', {'dates': needed, 'target': target, 'calendar': days})
        if frozen['target'] != target or frozen['dates'] != needed:
            raise RuntimeError('Frozen KR target/calendar changed')
        ns['_CT_KR_REQUIRED_DATES'] = needed or [target]
        ns['TARGET_COUNT'] = max(ns['TARGET_COUNT'], len(needed))
        ns['FLOW_COUNT'] = max(ns['FLOW_COUNT'], len(needed))
        profile = {'profile': ns['RUN_PROFILE'], 'target': ns['TARGET_COUNT'],
                   'flow': ns['FLOW_COUNT'], 'backfill': sorted(ns['_CT_SUPPLY_BACKFILL_SYMBOLS']),
                   'dates': ns['_CT_KR_REQUIRED_DATES']}
        old = state.freeze('kr-collection-profile', profile)
        # A changed readiness query cannot silently alter checkpoint dependencies.
        ns['RUN_PROFILE'], ns['TARGET_COUNT'], ns['FLOW_COUNT'] = old['profile'], old['target'], old['flow']
        ns['_CT_SUPPLY_BACKFILL_SYMBOLS'] = set(old['backfill'])
        key = digest(canonical(old))[7:24]
        ns['RUN_CACHE_KEY'] = key
        ns['CACHE_ROOT'] = ns['LOCAL_WORK_ROOT'] / 'resume-v1' / state.plan['runId'] / key
        ns['CHECKPOINT_ROOT'] = state.root / 'kr-checkpoints' / key
        ns['CACHE_ROOT'].mkdir(parents=True, exist_ok=True)
        ns['CHECKPOINT_ROOT'].mkdir(parents=True, exist_ok=True)
        install_cache(ns, state)
    if stage == 'kr_enrichment_setup' and ns['RUN_KR_MARKET']:
        ns['apply_screening_latest_market_cap_batch'] = lambda frame: enrich_dates(frame, ns['_CT_KR_REQUIRED_DATES'], ns)
    if stage == 'us_setup' and ns['RUN_US_MARKET']:
        ns['_US_RUN_ID'] = state.plan['runId']
        ns['BASE_DIR'] = state.root / 'us-work'
        ns['BASE_DIR'].mkdir(parents=True, exist_ok=True)
        ns['OUTPUT_DIR'] = state.root / 'us-outputs'
        ns['OUTPUT_DIR'].mkdir(parents=True, exist_ok=True)
        # Current registered originals are restored by the existing frozen-source
        # path, never regenerated into the original VF outputs directory.
        ns['MASTER_PATH'] = state.root / 'us-master.parquet'
        original_cache = ns['CACHE_PATH']
        ns['CACHE_PATH'] = state.root / 'us-price.parquet'
        if original_cache.exists() and not ns['CACHE_PATH'].exists():
            atomic_write(ns['CACHE_PATH'], original_cache.read_bytes())
    if stage == 'us_auth' and ns['RUN_US_MARKET']:
        import pandas as pd
        clock = pd.Timestamp(ns['_CT_RUN_CLOCK'])
        query_day = clock.tz_convert('America/New_York').date().isoformat()
        calendar = state.frozen('us-calendar')
        if calendar is None:
            body, _ = ns['toss_get']('/api/v1/market-calendar/US', {'date': query_day})
            days = list(body['result'].values())
            closed = [d for d in days if d.get('regularMarket') and pd.Timestamp(d['regularMarket']['endTime']) + pd.Timedelta(minutes=30) <= clock]
            if not closed:
                raise RuntimeError('No verified closed US session')
            target = max(d['date'] for d in closed)
            asof, _ = ns['toss_get']('/api/v1/market-calendar/US', {'date': target})
            calendar = state.freeze('us-calendar', {'date': target, 'previous': asof['result']['previousBusinessDay']['date'], 'response': body})
        ns['_CT_US_CALENDAR'] = calendar
        _freeze_api(ns, state)
        original_calendar = ns['toss_get']
        def dated_get(endpoint, params=None, **kwargs):
            if endpoint == '/api/v1/market-calendar/US' and params == {'date': query_day}:
                return calendar['response'], {}
            return original_calendar(endpoint, params, **kwargs)
        ns['toss_get'] = dated_get
    if stage == 'us_auth' and ns['RUN_US_MARKET']:
        gap_inventory(ns, state)
    if stage == 'us_master' and ns['RUN_US_MARKET']:
        payload = {'seed': _json_frame(ns['seed']), 'master': _json_frame(ns['master']),
                   'rosterHash': ns['collection_universe_hash'], 'lifecycle': ns['VERIFIED_LIFECYCLE_EVENTS']}
        if state.freeze('us-input-identity', payload) != payload:
            raise RuntimeError('Universe/lifecycle identity changed; create a reviewed separate run')
        ns['_CT_US_INPUT_IDENTITY'] = digest(canonical(payload))


def run(ns):
    import cloudtrend_lite_r3_runtime as base
    from google.colab import drive
    if not Path('/content/drive/MyDrive').exists():
        drive.mount('/content/drive', force_remount=False)
    root = Path(ns['RESUME_ROOT'])
    config = {name: ns.get(name) for name in CONFIG}
    config['version'] = 'resume-v1'
    root.mkdir(parents=True, exist_ok=True)
    with RunLock(root):
        requested = str(ns.get('RESUME_RUN_ID') or '').strip()
        active = root / 'active.json'
        if requested == 'NEW':
            # Explicit user choice. Previous journal, checkpoints and receipts remain.
            run_id = uuid.uuid4().hex
            started = datetime.now(timezone.utc).isoformat()
        elif requested:
            run_id = requested
            started = None
        elif active.exists():
            run_id = json.loads(active.read_text())['runId']
            started = None
        else:
            run_id = uuid.uuid4().hex
            started = datetime.now(timezone.utc).isoformat()
        state = RunState(root, run_id, config, started_at=started)
        if requested == 'NEW' or not active.exists():
            atomic_write(active, canonical({'runId': run_id}))
        ns['_CT_RUN_CLOCK'] = state.plan['startedAt']
        ns['_CT_RESUME_STATE'] = state
        ns['RESUME_RUN_ID'] = run_id
        operational = bool(ns.get('ALLOW_OPERATIONAL_WRITES', False))
        ns['AUTO_PUBLISH_TO_CLOUDTREND'] = operational
        ns['DISPATCH_GITHUB_AFTER_UPLOAD'] = operational
        print('실행 ID:', run_id, '/ 고정 시작시각:', state.plan['startedAt'])
        print('운영 업로드·요청:', '승인된 실행' if operational else '비활성 — 로컬/Drive 준비만')
        for stage in base.STAGES:
            if stage in ('kr_retry_saved', 'us_upload', 'us_archive', 'us_dispatch') and not operational:
                continue
            # A stopped run repeats deterministic setup; provider metadata and price
            # checkpoints are reused only with exact saved dependencies.
            if stage == 'us_snapshot' and ns.get('RUN_US_MARKET'):
                name = 'us_screening_input_' + ns['AS_OF_DATE'].replace('-', '') + '.csv'
                original = Path(ns['US_BASE_DIR']) / 'outputs' / name
                restored = ns['OUTPUT_DIR'] / name
                if original.exists() and not restored.exists():
                    atomic_write(restored, original.read_bytes())
            from importlib.resources import files
            override = files(__package__) / 'overrides' / (stage + '.py')
            if override.is_file():
                ns['_CT_RUNTIME_TEXT'], ns['_CT_RUNTIME_EXEC'] = base._text, base._execute
                exec(compile(override.read_text(), str(override), 'exec'), ns, ns)
            else:
                base.run_stage(stage, ns)
            _after(stage, ns, state)
            state.save_json('completed-' + stage, {'runtime': ns['_CT_RUNTIME_LOADED_SHA']},
                            {'stage': stage, 'finishedAt': datetime.now(timezone.utc).isoformat()})
        print('수집 단계 종료. 서버·Shadow·게시 완료는 별도 영수증 확인이 필요합니다.')
        # Keep active.json until a user selects a new plan. Completion of local
        # collection is not equivalent to publication or model completion.
