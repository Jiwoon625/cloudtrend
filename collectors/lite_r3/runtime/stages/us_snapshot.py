# Fail closed if a prior run left values in this Colab runtime.
_US_SNAPSHOT_READY = False
_US_UPLOAD_VERIFIED = False
if RUN_US_MARKET:
    _us_begin_stage('snapshot')
    _us_require_stage('diagnostics')
    # ===== 10. Supabase용 atomic screening snapshot 생성 =====
    cols={
        'date':'date','symbol':'symbol','name':'name','market':'market','sector':'sector','securityType':'security_type','status':'status','currency':'currency',
        'open':'open','high':'high','low':'low','close':'close','volume':'volume','dollar_volume':'dollar_volume','shares_outstanding':'shares_outstanding','market_cap':'market_cap',
        'ret120':'ret120','ret252':'ret252','beta60_spy':'beta60_spy','ichimoku_tk_gap':'ichimoku_tk_gap','relvol1_20':'relvol1_20','adv20_usd':'adv20_usd','amihud20':'amihud20',
        'active20':'active20','toss_tradable':'toss_tradable','is_common_share':'is_common_share','fx_usdkrw':'fx_usdkrw'
    }
    out=snap[[c for c in cols if c in snap.columns]].rename(columns=cols).copy()
    # SPY는 benchmark용으로 포함. 엔진은 SPY를 종목 후보에서는 제외합니다.
    out=out.sort_values('symbol').reset_index(drop=True)
    out_path=OUTPUT_DIR/f'us_screening_input_{latest_date.replace("-","")}.csv'
    out=out.replace([np.inf,-np.inf],np.nan)
    assert out.symbol.is_unique and out.date.eq(AS_OF_DATE).all()
    _current_spy = out.loc[out.symbol.eq('SPY'),'close']
    assert len(_current_spy) == 1 and _current_spy.gt(0).all(), 'Exactly one positive current SPY bar is required'
    # Registered same-day bytes are immutable, even if live eligibility changes later.
    # Read the pointer before comparing today's live universe with an older frozen source.
    assert SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and SUPABASE_USER_ID
    _pointer_headers = {
        'Authorization': f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
    }
    _pointer_response = requests.get(
        f'{SUPABASE_URL}/rest/v1/us_screening_ingest',
        headers=_pointer_headers,
        params={'user_id': 'eq.' + SUPABASE_USER_ID,
                'select': 'as_of_date,data_hash,row_count,symbol_count'},
        timeout=30,
    )
    _pointer_response.raise_for_status()
    _pointer_rows = _pointer_response.json()
    if not isinstance(_pointer_rows, list) or len(_pointer_rows) > 1:
        raise RuntimeError('Unexpected ingest pointer response; no source was changed')
    _registered = _pointer_rows[0] if _pointer_rows else None
    if _registered and _registered['as_of_date'] > latest_date:
        raise RuntimeError('Registered source is newer than this session; no source was changed')
    _registered_same_day = bool(_registered and _registered['as_of_date'] == latest_date)
    if _registered_same_day and not out_path.exists():
        raise RuntimeError('Registered same-day source is missing locally. Restore the registered original; do not regenerate it')

    if out_path.exists():
        _frozen_raw = out_path.read_bytes()
        _frozen_hash = 'sha256:' + hashlib.sha256(_frozen_raw).hexdigest()
        frozen = pd.read_csv(out_path, dtype={'symbol': str, 'date': str})
        if frozen.empty or not frozen.symbol.is_unique or not frozen.date.eq(AS_OF_DATE).all():
            raise RuntimeError('Frozen source has invalid date or duplicate symbols; no source was changed')
        _spy = frozen.loc[frozen.symbol.eq('SPY'), 'close']
        if len(_spy) != 1 or not _spy.gt(0).all():
            raise RuntimeError('Frozen source has no valid SPY benchmark; no source was changed')
        if _registered_same_day:
            if _frozen_hash != _registered['data_hash']:
                raise RuntimeError('Frozen source hash differs from registered immutable source; no source was changed')
            if len(frozen) != _registered['row_count'] or frozen.symbol.nunique() != _registered['symbol_count']:
                raise RuntimeError('Frozen source counts differ from registered source; no source was changed')
        # A frozen source never silently restores ACTIVE/price-bearing lifecycle rows.
        # The sole exception reuses registered bytes behind an already published WBD review.
        _lifecycle_conflicts = []
        _reviewed_exclusions = set()
        for _event in lifecycle_events:
            _held = frozen.loc[frozen.symbol.eq(_event['symbol'])]
            if _held.empty:
                continue  # metadata-only exclusion is supported
            _status_ok = 'status' in _held and _held.status.astype(str).str.upper().eq('SUSPENDED').all()
            _tradable_ok = 'toss_tradable' in _held and not _held.toss_tradable.map(truthy).any()
            _priced = any(pd.to_numeric(_held[_col], errors='coerce').notna().any()
                          for _col in ['open','high','low','close','volume'] if _col in _held)
            if not _status_ok or not _tradable_ok or _priced:
                _lifecycle_conflicts.append(_event)
        if _lifecycle_conflicts:
            if (not _registered_same_day or len(_lifecycle_conflicts) != 1
                    or _lifecycle_conflicts[0]['symbol'] != 'WBD'
                    or _lifecycle_conflicts[0].get('status') != 'SUSPENDED'
                    or _lifecycle_conflicts[0].get('effective_date') != '2026-10-06'
                    or latest_date < '2026-10-06'):
                raise RuntimeError('Frozen source conflicts with verified lifecycle exclusion: '
                                   + ', '.join(event['symbol'] for event in _lifecycle_conflicts)
                                   + '; original preserved for correction review')
            # Reuse requires the original local archive too; never mint a newly labelled
            # atomic descriptor from ACTIVE raw rows and today's exclusion metadata.
            try:
                _review_archive = json.loads((DATED_ARCHIVE_DIR/latest_date/'source.json').read_text(encoding='utf-8'))
                _review_archive_matches = (
                    _review_archive['date'] == latest_date
                    and _review_archive['dataHash'] == _frozen_hash
                    and _review_archive['pit']['kind'] == 'ATOMIC_DATED_SNAPSHOT'
                )
            except (OSError, ValueError, TypeError, KeyError):
                _review_archive_matches = False
            if not _review_archive_matches:
                raise RuntimeError('WBD 등록 원본의 날짜별 보존 기록이 없거나 일치하지 않습니다: '
                                   '원본을 보존하고 업로드를 중단했습니다.')
            # One small authenticated read only on this exact reviewed same-day conflict.
            # Do not fetch or substitute derived CSV bytes, or alter ingest/replay evidence.
            try:
                _review_response = requests.get(
                    f'{SUPABASE_URL}/storage/v1/object/authenticated/cloudtrend-data/'
                    f'{SUPABASE_USER_ID}/cache/us-screening/summary-v1.json',
                    headers={**_pointer_headers, 'Cache-Control': 'no-cache'}, timeout=30,
                )
            except requests.exceptions.Timeout:
                raise RuntimeError('WBD 검토 게시 근거 조회 시간 초과(timeout): 원본을 보존하고 업로드를 중단했습니다.') from None
            except requests.exceptions.RequestException:
                raise RuntimeError('WBD 검토 게시 근거 조회 연결 오류: 원본을 보존하고 업로드를 중단했습니다.') from None
            if _review_response.status_code != 200:
                raise RuntimeError(f'WBD 검토 게시 근거 조회 실패(HTTP {_review_response.status_code}): '
                                   '원본을 보존하고 업로드를 중단했습니다.')
            try:
                _review = _review_response.json()
                _review_metadata = _review['source']['metadata']
                _review_marker = _review_metadata['recoveryPublication']
                _review_quarantines = _review_metadata['quarantinedSymbols']
                _review_matches = (
                    _review['analysis']['date'] == latest_date
                    and _review_marker['version'] == 'us-recovery-publication-v1'
                    and _review_marker['sourceKind'] == 'REVIEWED_ATOMIC_QUARANTINE'
                    and _review_marker['originalDataHash'] == _frozen_hash
                    and _review_metadata['sourceCoverageComplete'] is False
                    and isinstance(_review_quarantines, list)
                    and 'WBD' in _review_quarantines
                )
            except (ValueError, TypeError, KeyError):
                _review_matches = False
            if not _review_matches:
                raise RuntimeError('WBD 검토 게시 근거의 날짜·원본 해시·제외 기록이 없거나 일치하지 않습니다: '
                                   '원본을 보존하고 업로드를 중단했습니다.')
            _reviewed_exclusions = {'WBD'}
            print('검토 게시된 WBD 제외 확인: 등록 원본 바이트 유지, 기존 검토 결과 재사용; sourceCoverageComplete=False')
        if _registered_same_day:
            # A known immutable source is authoritative; actual same-session price/feature
            # corrections still require review instead of being silently discarded.
            _common = sorted((set(frozen.symbol) & set(out.symbol)) - set(provider_gap_symbols) - _reviewed_exclusions)
            _stable_cols = ['open', 'high', 'low', 'close', 'volume', 'dollar_volume',
                            'ret120', 'ret252', 'beta60_spy', 'ichimoku_tk_gap',
                            'relvol1_20', 'adv20_usd', 'amihud20', 'active20']
            _changed = []
            _old_common = frozen.set_index('symbol').loc[_common]
            _new_common = out.set_index('symbol').loc[_common]
            for _col in _stable_cols:
                if _col not in _old_common or _col not in _new_common:
                    raise RuntimeError(f'Required source column missing: {_col}; registered source preserved')
                _old_values = pd.to_numeric(_old_common[_col], errors='raise').to_numpy(dtype=float)
                _new_values = pd.to_numeric(_new_common[_col], errors='raise').to_numpy(dtype=float)
                if not np.isclose(_old_values, _new_values, rtol=1e-10, atol=1e-10, equal_nan=True).all():
                    _changed.append(_col)
            if _changed:
                raise RuntimeError(f'Current same-session values differ in {_changed}; registered source preserved for correction review')
            print('Registered-only symbols:', sorted(set(frozen.symbol) - set(out.symbol)))
            print('Current-only symbols:', sorted(set(out.symbol) - set(frozen.symbol)))
            print('Reusing hash-verified registered daily source:', latest_date)
        elif set(frozen.symbol) != set(out.symbol):
            raise RuntimeError(
                f'Unregistered frozen source for {latest_date} differs from current QA. '
                'Review the symbol difference before any replacement; no source was changed'
            )
        else:
            print('Reusing frozen daily source')
        out = frozen
        raw = _frozen_raw
    else:
        # Newly frozen provider-gap rows must never remain tradable or scoreable.
        _provider_mask=out.symbol.isin(provider_gap_symbols)
        out.loc[_provider_mask,'toss_tradable']=False
        out.loc[_provider_mask,'active20']=False
        _blank_cols=['open','high','low','close','volume','dollar_volume','market_cap',
                     'ret120','ret252','beta60_spy','ichimoku_tk_gap','relvol1_20','adv20_usd','amihud20']
        out.loc[_provider_mask,[c for c in _blank_cols if c in out.columns]]=np.nan
        out.to_csv(out_path, index=False, lineterminator='\n')
        raw = out_path.read_bytes()
    data_hash = 'sha256:' + hashlib.sha256(raw).hexdigest()
    _US_SNAPSHOT_READY = True
    print('saved:',out_path,'rows:',len(out),'sha:',data_hash)
    display(out.head())

    _us_finish_stage('snapshot')

else:
    print('SKIP: RUN_US_MARKET')
