if RUN_US_MARKET:
    _us_begin_stage('collection')
    _us_require_stage('master')
    # ===== 7. Adjusted 일봉 수집/증분 캐시 — V2 =====
    # 정상 일일 운용: 최근 15봉만 조회 → 기존 캐시에 merge
    # 예외: 신규/캐시 단절/adjusted 과거값 변경 종목만 400봉 full refresh
    from zoneinfo import ZoneInfo

    collection_started = time.monotonic()
    chart_requests_before = _chart_request_count

    now_utc = pd.Timestamp.now(tz='UTC')
    calendar_body, _ = toss_get('/api/v1/market-calendar/US', {'date': now_utc.tz_convert('America/New_York').date().isoformat()})
    calendar_days = list(calendar_body['result'].values())
    closed = [d for d in calendar_days if d.get('regularMarket') and pd.Timestamp(d['regularMarket']['endTime']) + pd.Timedelta(minutes=30) <= now_utc]
    if not closed: raise RuntimeError('No confirmed US regular-session close')
    AS_OF_DATE = max(d['date'] for d in closed)
    asof_calendar, _ = toss_get('/api/v1/market-calendar/US', {'date': AS_OF_DATE})
    PREVIOUS_SESSION = asof_calendar['result']['previousBusinessDay']['date']
    candidate_history_starts = {
        row['ticker']: row['history_start_date']
        for row in seed.to_dict('records') if row.get('history_start_date')
    }
    not_effective = {symbol for symbol, start in candidate_history_starts.items() if start > AS_OF_DATE}
    candidate_quarantine.update({symbol: 'before_corporate_action_effective_session' for symbol in not_effective})
    if not_effective:
        seed = seed.loc[~seed.ticker.isin(not_effective)].copy()
        master = master.loc[~master.symbol.isin(not_effective)].copy()
        print('Candidates waiting for effective session:', sorted(not_effective))
    def _guard_history_rows(symbol, rows):
        start = candidate_history_starts.get(symbol)
        return [row for row in rows if not start or str(row.get('date', ''))[:10] >= start]
    def _guard_history_frame(frame):
        if frame.empty: return frame
        starts = frame.symbol.map(candidate_history_starts).fillna('')
        return frame.loc[starts.eq('') | frame.date.ge(starts)].copy()
    CHECKPOINT_DIR = BASE_DIR / 'checkpoints' / AS_OF_DATE
    CHECKPOINT_DIR.mkdir(parents=True, exist_ok=True)

    def _validate_lifecycle_events(events, as_of_date):
        from datetime import date as _lifecycle_date
        from urllib.parse import urlparse as _lifecycle_urlparse
        import re as _lifecycle_re
        exempt=set()
        cutoff = _lifecycle_date.fromisoformat(as_of_date)
        for event in events:
            symbol=str(event.get('symbol','')).upper().strip()
            effective=str(event.get('effective_date',''))
            evidence=_lifecycle_urlparse(str(event.get('source_url','')))
            if (not symbol or symbol == 'SPY' or evidence.scheme != 'https'
                    or not evidence.netloc or event.get('status') != 'SUSPENDED'):
                raise ValueError('Lifecycle requires symbol, SUSPENDED status and HTTPS evidence; SPY cannot be exempt')
            if not _lifecycle_re.fullmatch(r'\d{4}-\d{2}-\d{2}', effective):
                raise ValueError(f'Invalid lifecycle effective date: {symbol}')
            effective_date = _lifecycle_date.fromisoformat(effective)
            if effective_date > cutoff:
                continue
            expected = str(event.get('identity_name_contains') or '').strip()
            current = master.loc[master.symbol.eq(symbol)]
            if expected and not current.empty:
                names = current['englishName'].dropna().astype(str).tolist()
                if len(current) != 1 or not any(
                    _normalized_issuer_name(expected) in _normalized_issuer_name(name) for name in names
                ):
                    raise RuntimeError(f'Lifecycle issuer identity changed/unverified: {symbol}; manual review required')
            exempt.add(symbol)
        return exempt

    lifecycle_exempt_symbols = _validate_lifecycle_events(VERIFIED_LIFECYCLE_EVENTS, AS_OF_DATE)
    print('Confirmed session:', AS_OF_DATE)
    if lifecycle_exempt_symbols:
        print('Verified lifecycle exclusions (no current price fabricated):', sorted(lifecycle_exempt_symbols))
        for _event in VERIFIED_LIFECYCLE_EVENTS:
            if _event['symbol'] in lifecycle_exempt_symbols:
                print(_event['symbol'], _event['status'], _event['effective_date'], _event['reason'], _event['source_url'])

    def parse_candles(symbol, body):
        from datetime import date as _candle_date
        if not isinstance(body,dict):
            raise RuntimeError('Malformed candle response: expected object')
        result = body.get('result', body.get('data', body))
        for envelope in (body,result):
            if isinstance(envelope,dict) and (envelope.get('error') or envelope.get('errors')
                    or envelope.get('errorCode') or envelope.get('success') is False):
                raise RuntimeError('Provider candle response reported an error')
        if isinstance(result, dict) and ('candles' in result or 'items' in result):
            candles = result.get('candles', result.get('items'))
        elif isinstance(result, list): candles = result
        else: raise RuntimeError('Malformed candle response: missing candle list')
        if not isinstance(candles,list):
            raise RuntimeError('Malformed candle response: candles must be a list')
        out=[]
        for x in candles:
            if not isinstance(x,dict):
                raise RuntimeError('Malformed candle response: expected candle object')
            ts = x.get('timestamp') or x.get('date')
            try:
                candle_date=_candle_date.fromisoformat(str(ts)[:10]).isoformat()
                close=float(x.get('closePrice',x.get('close')))
                if not np.isfinite(close): raise ValueError('non-finite close')
            except (TypeError,ValueError):
                raise RuntimeError('Malformed candle response: invalid candle date/close') from None
            out.append({
                'symbol':symbol,
                'date':candle_date,
                'open':pd.to_numeric(x.get('openPrice',x.get('open')),errors='coerce'),
                'high':pd.to_numeric(x.get('highPrice',x.get('high')),errors='coerce'),
                'low':pd.to_numeric(x.get('lowPrice',x.get('low')),errors='coerce'),
                'close':close,
                'volume':pd.to_numeric(x.get('volume'),errors='coerce'),
                'currency':x.get('currency'),
            })
        next_before = result.get('nextBefore') if isinstance(result,dict) else None
        return _guard_history_rows(symbol, out),next_before

    def fetch_history(symbol, full=False):
        need = INITIAL_BARS if full else INCREMENTAL_BARS
        rows=[]; before=None; seen=set()
        while len(rows)<need:
            # V2: 증분 운용은 count 자체도 15로 낮춰 응답 payload를 줄입니다.
            request_count = min(200, max(1, need-len(rows)))
            params={'symbol':symbol,'interval':'1d','count':request_count,'adjusted':'true'}
            if before: params['before']=before
            body,_=toss_get('/api/v1/candles',params,chart=True)
            part,next_before=parse_candles(symbol,body)
            if not part: break
            unique = [r for r in part if r['date'] not in seen and r['date'] <= AS_OF_DATE]
            rows.extend(unique)
            seen.update(r['date'] for r in unique)
            if not next_before or next_before==before: break
            before=next_before
        return rows[:need]

    candle_cols = ['open','high','low','close','volume']

    def latest_positive_bar_date(rows):
        latest=None
        for row in rows or []:
            try:
                close=float(row.get('close'))
            except (TypeError, ValueError):
                continue
            if not np.isfinite(close) or close <= 0:
                continue
            date=str(row.get('date',''))[:10]
            if date and (latest is None or date > latest):
                latest=date
        return latest

    class LatestPriceUnconfirmed(RuntimeError):
        """A successful candle response did not establish a positive current bar.

        Only this local QA outcome is quarantinable. HTTP, authentication,
        timeout, malformed-response and unexpected failures must still stop.
        """
        def __init__(self, message, rows):
            super().__init__(message)
            self.latest_bar_date = latest_positive_bar_date(rows)

    def confirmed_session_covered(symbol, rows):
        return symbol in lifecycle_exempt_symbols or latest_positive_bar_date(rows) == AS_OF_DATE

    if CACHE_PATH.exists() and (not FORCE_FULL_REFRESH or lifecycle_exempt_symbols):
        old = pd.read_parquet(CACHE_PATH)
        old['symbol']=old['symbol'].astype(str).str.upper()
        old['date']=old['date'].astype(str).str.slice(0,10)
        if FORCE_FULL_REFRESH:
            # Effective lifecycle symbols make no candle request, so preserve their
            # raw history only. All other symbols still start from a fresh base.
            old=old.loc[old.symbol.isin(lifecycle_exempt_symbols)].copy()
        old = _guard_history_frame(old)
        old=old.drop_duplicates(['symbol','date'],keep='last').sort_values(['symbol','date']).reset_index(drop=True)
        counts=old.groupby('symbol').size().to_dict()
        _valid_cached_close=pd.to_numeric(old['close'],errors='coerce')
        last_dates=old.loc[np.isfinite(_valid_cached_close) & _valid_cached_close.gt(0) & old.date.le(AS_OF_DATE)].groupby('symbol')['date'].max().to_dict()
        del _valid_cached_close
        # 비교에는 최근 구간만 필요하므로 작은 lookup만 메모리에 둡니다.
        recent_old=old.groupby('symbol',group_keys=False).tail(max(INCREMENTAL_BARS+2,20))
        old_recent_by_symbol={sym:frame.copy() for sym,frame in recent_old.groupby('symbol')}
    else:
        old = pd.DataFrame(columns=['symbol','date','open','high','low','close','volume','currency'])
        counts={}
        last_dates={}
        old_recent_by_symbol={}

    symbols=seed.ticker.tolist()
    collected=[]; failures=[]
    price_unconfirmed_evidence={}
    full_refresh_symbols=set()
    refresh_reasons={}
    mode_counts={
        'cache_current':0,
        'verified_lifecycle_excluded':0,
        'incremental':0,
        'full_new_or_forced':0,
        'full_adjustment_changed':0,
        'full_no_overlap':0,
        'stale_checkpoint_rejected':0,
    }

    def needs_full_refresh(sym, fresh_rows):
        prior = old_recent_by_symbol.get(sym)
        if prior is None or prior.empty:
            return True, 'new_or_missing_cache'
        fresh = pd.DataFrame(fresh_rows)
        if fresh.empty:
            return True, 'empty_incremental'
        common = fresh.merge(prior[['date',*candle_cols]], on='date', how='inner', suffixes=('_new','_old'))
        if common.empty:
            return True, 'no_overlap'
        for col in candle_cols:
            newv=pd.to_numeric(common[f'{col}_new'],errors='coerce').to_numpy(dtype=float)
            oldv=pd.to_numeric(common[f'{col}_old'],errors='coerce').to_numpy(dtype=float)
            same=np.isclose(newv,oldv,rtol=ADJUST_COMPARE_RTOL,atol=ADJUST_COMPARE_ATOL,equal_nan=True)
            if not bool(np.all(same)):
                return True, f'adjusted_{col}_changed'
        return False, None

    def write_checkpoint(path, rows, mode, reason=None):
        payload={
            'version':CHECKPOINT_VERSION,
            'asOfDate':AS_OF_DATE,
            'latestBarDate':latest_positive_bar_date(rows),
            'mode':mode,
            'reason':reason,
            'rows':rows,
        }
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(payload, allow_nan=False, default=lambda value: value.item()))
        tmp.replace(path)

    def task(sym):
        checkpoint = CHECKPOINT_DIR / (sym + '.json')
        stale_checkpoint_rejected=False
        try:
            if sym in lifecycle_exempt_symbols:
                return sym, [], None, 'verified_lifecycle_excluded', 'verified_exchange_lifecycle', False, False, None
            # 같은 기준일 재실행은 실제 캐시에 당일 확정봉이 있으면 API를 다시 호출하지 않습니다.
            # lifecycle 예외는 확인된 중단/상장폐지 등으로 당일 봉이 없어도 허용합니다.
            if not FORCE_FULL_REFRESH and last_dates.get(sym) == AS_OF_DATE:
                return sym, [], None, 'cache_current', None, False, False, None

            # 중간 중단 후 재실행 시 checkpoint를 재사용하되, 현재 확정세션까지 포함하는지 반드시 검증합니다.
            if checkpoint.exists() and not FORCE_FULL_REFRESH:
                saved = json.loads(checkpoint.read_text())
                if isinstance(saved,dict) and isinstance(saved.get('rows'),list):
                    rows=saved['rows']
                    saved_mode=str(saved.get('mode') or 'incremental')
                    saved_reason=saved.get('reason')
                    saved_asof=str(saved.get('asOfDate') or '')[:10]
                elif isinstance(saved,list):
                    # V1 legacy checkpoint 호환. 내용 검증 후에만 재사용합니다.
                    rows=saved
                    saved_mode='full_new_or_forced' if len(rows)>INCREMENTAL_BARS else 'incremental'
                    saved_reason='legacy_checkpoint'
                    saved_asof=''
                else:
                    rows=[]
                    saved_mode='invalid'
                    saved_reason='invalid_checkpoint'
                    saved_asof=''

                rows = _guard_history_rows(sym, rows)
                if rows and (not saved_asof or saved_asof == AS_OF_DATE) and confirmed_session_covered(sym, rows):
                    return sym, rows, None, saved_mode, saved_reason, True, False, None

                # 오래된/불완전 checkpoint 원문을 보존한 뒤 live API로 재조회합니다.
                stale_checkpoint_rejected=True
                try:
                    rejected_raw=checkpoint.read_bytes()
                    rejected_dir=CHECKPOINT_DIR/'rejected'/sym
                    rejected_dir.mkdir(parents=True,exist_ok=True)
                    _CT_US_ARCHIVE['_ua_write_once'](rejected_dir/(hashlib.sha256(rejected_raw).hexdigest()+'.json'),rejected_raw)
                    checkpoint.unlink()
                except FileNotFoundError:
                    pass

            if FORCE_FULL_REFRESH or counts.get(sym,0) == 0:
                rows = fetch_history(sym, full=True)
                if not rows: raise LatestPriceUnconfirmed('empty candle history', rows)
                if not confirmed_session_covered(sym, rows):
                    latest=latest_positive_bar_date(rows)
                    raise LatestPriceUnconfirmed(f'latest candle {latest or "NONE"} < confirmed session {AS_OF_DATE}', rows)
                reason='forced' if FORCE_FULL_REFRESH else 'new_or_missing_cache'
                write_checkpoint(checkpoint, rows, 'full_new_or_forced', reason)
                return sym, rows, None, 'full_new_or_forced', reason, False, stale_checkpoint_rejected, None

            incremental = fetch_history(sym, full=False)
            if not incremental: raise LatestPriceUnconfirmed('empty incremental candle history', incremental)
            if not confirmed_session_covered(sym, incremental):
                # API 전파 지연 가능성을 고려해 작은 최신-window 요청을 한 번 더 확인합니다.
                time.sleep(0.25)
                retry_rows = fetch_history(sym, full=False)
                if latest_positive_bar_date(retry_rows) and latest_positive_bar_date(retry_rows) > (latest_positive_bar_date(incremental) or ''):
                    incremental = retry_rows
                if not confirmed_session_covered(sym, incremental):
                    latest=latest_positive_bar_date(incremental)
                    raise LatestPriceUnconfirmed(f'latest candle {latest or "NONE"} < confirmed session {AS_OF_DATE}', incremental)

            full_needed, reason = needs_full_refresh(sym, incremental)
            if full_needed:
                rows = fetch_history(sym, full=True)
                if not rows: raise RuntimeError('empty full-refresh candle history after current incremental; history QA failed')
                if not confirmed_session_covered(sym, rows):
                    latest=latest_positive_bar_date(rows)
                    raise RuntimeError(f'full refresh latest candle {latest or "NONE"} < confirmed session {AS_OF_DATE}; history QA failed after current incremental')
                mode = 'full_no_overlap' if reason == 'no_overlap' else 'full_adjustment_changed'
                write_checkpoint(checkpoint, rows, mode, reason)
                return sym, rows, None, mode, reason, False, stale_checkpoint_rejected, None

            write_checkpoint(checkpoint, incremental, 'incremental', None)
            return sym, incremental, None, 'incremental', None, False, stale_checkpoint_rejected, None
        except Exception as e:
            return sym, [], type(e).__name__ + ': ' + str(e), None, None, False, stale_checkpoint_rejected, (
                {'reason':'latest_price_unconfirmed', 'providerLatestBarDate':e.latest_bar_date}
                if isinstance(e, LatestPriceUnconfirmed) else None
            )

    checkpoint_reuse_count=0
    stale_checkpoint_rejected_count=0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs=[ex.submit(task,s) for s in symbols]
        for f in tqdm(as_completed(futs), total=len(futs), desc='daily candles v2'):
            sym, rows, err, mode, reason, checkpoint_reused, stale_checkpoint_rejected, price_issue=f.result()
            if stale_checkpoint_rejected:
                stale_checkpoint_rejected_count+=1
            if err:
                failures.append((sym,err))
                if price_issue is not None:
                    price_unconfirmed_evidence[sym]=price_issue
                continue
            if checkpoint_reused:
                checkpoint_reuse_count+=1
            if mode in mode_counts:
                mode_counts[mode]+=1
            if mode and mode.startswith('full_'):
                full_refresh_symbols.add(sym)
                refresh_reasons[sym]=reason
            if rows:
                collected.extend(rows)

    # Future objects retain their candle payloads; collected already owns these rows.
    for _ct_name in ('futs', 'f'):
        globals().pop(_ct_name, None)

    # A successful provider response may lack a confirmed bar for one symbol.
    # Record that limited knowledge, regardless of how old its last bar is.
    # Do not infer suspension/corporate actions or fabricate a current price.
    # A valid prior cache bar is still required; do not broaden archive eligibility.
    # All unexpected/systemic failures and the aggregate cap still fail closed.
    provider_gap_failures=[]
    unhandled_failures=[]
    provider_gap_latest_dates={}
    provider_gap_reasons={}
    for sym, err in failures:
        issue=price_unconfirmed_evidence.get(sym)
        cached_last=last_dates.get(sym)
        latest=max(filter(None,[cached_last,(issue or {}).get('providerLatestBarDate')]),default=None)
        gap_days=(pd.Timestamp(AS_OF_DATE)-pd.Timestamp(latest)).days if latest else None
        eligible=(issue is not None and sym != 'SPY' and sym not in lifecycle_exempt_symbols
                  and bool(cached_last) and gap_days is not None and gap_days > 0)
        if eligible:
            provider_gap_failures.append((sym,err))
            provider_gap_latest_dates[sym]=latest
            provider_gap_reasons[sym]={
                **issue, 'cachedLatestBarDate':cached_last, 'latestBarDate':latest,
                'confirmedSessionDate':AS_OF_DATE, 'gapCalendarDays':gap_days,
                'error':err, 'classification':'UNCONFIRMED_PRICE',
            }
        else:
            unhandled_failures.append((sym,err))

    provider_gap_limit_exceeded=len(provider_gap_failures) > MAX_PROVIDER_GAP_SYMBOLS
    if provider_gap_limit_exceeded:
        unhandled_failures.extend(provider_gap_failures)
        provider_gap_failures=[]
        provider_gap_latest_dates={}
        provider_gap_reasons={}
    provider_gap_symbols={sym for sym,_ in provider_gap_failures}

    if candidate_quarantine:
        seed = seed.loc[~seed.ticker.isin(candidate_quarantine)].copy()
        master = master.loc[~master.symbol.isin(candidate_quarantine)].copy()
        symbols = seed.ticker.tolist()
        print('Candidate identity/history holds:', candidate_quarantine)
    # Keep daily saved seed/master consistent with actually collected candidates.
    seed.to_csv(seed_path, index=False)
    master.to_parquet(MASTER_PATH, index=False)
    new=pd.DataFrame(collected)
    if not new.empty:
        new['symbol']=new['symbol'].astype(str).str.upper()
        new['date']=new['date'].astype(str).str.slice(0,10)

    # full refresh 종목은 adjusted history 전체를 교체하고,
    # incremental 종목은 기존 캐시에 최근 봉만 upsert합니다.
    base = old[~old.symbol.isin(full_refresh_symbols)].copy() if full_refresh_symbols else old.copy()
    combined=pd.concat([base,new],ignore_index=True) if not new.empty else base
    # Combined frame is the only remaining copy needed for sort/rolling features.
    for _ct_name in ('base','old','new','collected','recent_old',
                     'old_recent_by_symbol','counts','last_dates'):
        globals().pop(_ct_name,None)
    import gc as _ct_gc
    _ct_gc.collect()
    combined=combined.dropna(subset=['symbol','date','close']).drop_duplicates(['symbol','date'],keep='last')
    combined=combined.sort_values(['symbol','date']).reset_index(drop=True)
    # Keep verified lifecycle raw history even after the provider drops its ACTIVE flag.
    # Other out-of-roster symbols retain the existing removal/full-refresh-on-return policy.
    combined=combined[combined.symbol.isin(set(symbols) | lifecycle_exempt_symbols)].copy()
    # rolling feature window가 무한히 커지지 않도록 최근 400봉만 유지합니다.
    combined=combined.groupby('symbol',group_keys=False).tail(CACHE_KEEP_BARS).reset_index(drop=True)
    # Keep verified post-event bars in cache, but do not invent an indicator history.
    candidate_scoring_holds = {}
    for symbol, start in candidate_history_starts.items():
        if symbol not in symbols: continue
        valid = combined.loc[combined.symbol.eq(symbol) & combined.close.gt(0)]
        if len(valid) < 253:
            candidate_scoring_holds[symbol] = {
                'reason': 'unverified_pre_event_history_and_insufficient_post_event_lookback',
                'postEventBars': int(len(valid)), 'minimumBars': 253, 'historyStartDate': start,
            }
    if candidate_scoring_holds:
        print('Score held; other symbols continue through upload:', candidate_scoring_holds)
    combined.to_parquet(CACHE_PATH,index=False,compression='zstd')
    _US_CACHE_ROW_COUNT = len(combined)

    chart_requests_used = _chart_request_count-chart_requests_before
    elapsed_sec = time.monotonic()-collection_started
    baseline_full_requests = len(symbols)*math.ceil(INITIAL_BARS/200)
    diagnostics={
        'collectorVersion':COLLECTOR_VERSION,
        'asOfDate':AS_OF_DATE,
        'rosterIdentityGuardVersion':'issuer-start-v1',
        'guardedCandidateHistoryStarts':candidate_history_starts,
        'guardedCandidateQuarantine':candidate_quarantine,
        'guardedCandidateScoringHolds':candidate_scoring_holds,
        'totalSymbols':len(symbols),
        'initialBars':INITIAL_BARS,
        'incrementalBars':INCREMENTAL_BARS,
        'cacheKeepBars':CACHE_KEEP_BARS,
        'modeCounts':mode_counts,
        'checkpointReuseCount':checkpoint_reuse_count,
        'staleCheckpointRejectedCount':stale_checkpoint_rejected_count,
        'fullRefreshSymbols':len(full_refresh_symbols),
        'fullRefreshReasons':refresh_reasons,
        'verifiedLifecycleEvents':[dict(event) for event in VERIFIED_LIFECYCLE_EVENTS if event['symbol'] in lifecycle_exempt_symbols],
        'lifecycleExcludedSymbols':sorted(lifecycle_exempt_symbols & set(symbols)),
        'providerGapPolicyVersion':PROVIDER_GAP_POLICY_VERSION,
        'providerGapCount':len(provider_gap_symbols),
        'providerGapSymbols':sorted(provider_gap_symbols),
        'providerGapLatestBarDates':provider_gap_latest_dates,
        'providerGapDetails':provider_gap_failures,
        'providerGapReasons':provider_gap_reasons,
        'providerGapLimit':MAX_PROVIDER_GAP_SYMBOLS,
        'providerGapLimitExceeded':provider_gap_limit_exceeded,
        'failures':unhandled_failures,
        'rawFailures':failures,
        'chartRequestsUsed':chart_requests_used,
        'estimatedLegacyFullRequests':baseline_full_requests,
        'estimatedRequestsSavedVsLegacy':max(0,baseline_full_requests-chart_requests_used),
        'elapsedSeconds':round(elapsed_sec,1),
    }
    (BASE_DIR/'collection_diagnostics_latest.json').write_text(json.dumps(diagnostics,ensure_ascii=False,indent=2))

    print('cache rows:',len(combined),'symbols:',combined.symbol.nunique(),'raw failures:',len(failures),'unhandled:',len(unhandled_failures))
    print('collection modes:',mode_counts,'checkpoint reuse:',checkpoint_reuse_count,'stale checkpoint rejected:',stale_checkpoint_rejected_count)
    print('chart requests:',chart_requests_used,'/ legacy full-refresh baseline:',baseline_full_requests)
    print('elapsed sec:',round(elapsed_sec,1))
    if full_refresh_symbols:
        print('full refresh examples:',list(refresh_reasons.items())[:10])
    if provider_gap_symbols:
        print('latest-price-unconfirmed quarantine:',[(sym,provider_gap_latest_dates[sym]) for sym in sorted(provider_gap_symbols)])
        print('NOTE: quarantined symbols are omitted from this session only; no synthetic bar is created.')
    if unhandled_failures:
        print('unhandled failure examples:',unhandled_failures[:10])

    (BASE_DIR/'collection_failures.json').write_text(json.dumps(unhandled_failures))
    (BASE_DIR/'provider_gap_quarantine.json').write_text(json.dumps({
        'policyVersion':PROVIDER_GAP_POLICY_VERSION,
        'asOfDate':AS_OF_DATE,
        'symbols':sorted(provider_gap_symbols),
        'latestBarDates':provider_gap_latest_dates,
        'details':provider_gap_failures,
        'reasons':provider_gap_reasons,
        'limitExceeded':provider_gap_limit_exceeded,
    }, ensure_ascii=False, indent=2))

    # Date-scoped evidence is immutable; no extra full-history DataFrame copies.
    _date_evidence = {
        'version':'us-collection-evidence-v1', 'asOfDate':AS_OF_DATE,
        'previousSessionDate':PREVIOUS_SESSION, 'capturedAt':datetime.now(timezone.utc).isoformat(),
        'confirmedRegularClose':True, 'diagnostics':diagnostics,
        'calendar':asof_calendar, 'seedHash':'sha256:'+hashlib.sha256(seed_path.read_bytes()).hexdigest(),
        'masterHash':'sha256:'+hashlib.sha256(MASTER_PATH.read_bytes()).hexdigest(),
    }
    _evidence_raw=_CT_US_ARCHIVE['_ua_json'](_date_evidence)
    _evidence_folder=BASE_DIR/'dated_collection_evidence_v1'/AS_OF_DATE/hashlib.sha256(_evidence_raw).hexdigest()
    _CT_US_ARCHIVE['_ua_write_once'](_evidence_folder/'collection.json',_evidence_raw)
    _CT_US_ARCHIVE['_ua_write_once'](_evidence_folder/'seed.csv',seed_path.read_bytes())
    _CT_US_ARCHIVE['_ua_write_once'](_evidence_folder/'master.parquet',MASTER_PATH.read_bytes())

    if unhandled_failures:
        raise RuntimeError(
            f'{len(unhandled_failures)} symbols failed confirmed-session QA outside the provider-gap policy. '
            f'Examples: {unhandled_failures[:10]}.'
        )

    _us_finish_stage('collection')

else:
    print('SKIP: RUN_US_MARKET')
