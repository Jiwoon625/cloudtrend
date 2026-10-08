if RUN_US_MARKET:
    _us_begin_stage('master')
    _us_require_stage('seed')
    # ===== 6. Toss 종목 마스터 검증/보강 =====
    def chunks(values, n=200):
        values=list(values)
        for i in range(0,len(values),n): yield values[i:i+n]

    master_rows=[]
    for batch in tqdm(list(chunks(seed.ticker.tolist(), 200)), desc='stock master'):
        body,_ = toss_get('/api/v1/stocks', {'symbols': ','.join(batch)})
        result = body.get('result', body.get('data', body))
        if isinstance(result, dict): result = result.get('stocks', result.get('items', []))
        if not isinstance(result, list): result=[]
        master_rows.extend(result)
        time.sleep(0.22)  # STOCK group conservative pacing

    master = pd.DataFrame(master_rows)
    if master.empty:
        raise RuntimeError('Toss /api/v1/stocks 결과가 비었습니다. 허용 IP/토큰/응답 스키마를 확인하세요.')
    # response field aliases tolerant
    for col in ['symbol','name','englishName','market','securityType','status','currency','listDate','delistDate','sharesOutstanding','isCommonShare']:
        if col not in master.columns: master[col] = np.nan
    master['symbol'] = master['symbol'].astype(str).str.upper()
    master = master.drop_duplicates('symbol', keep='last')
    master = master.merge(seed.rename(columns={'ticker':'symbol','sectorCode':'sector'}), on='symbol', how='right')
    candidate_quarantine = dict(globals().get('candidate_roster_exclusions', {}))
    def _normalized_issuer_name(value):
        import re
        return ' '.join(re.sub(r'[^A-Z0-9]+', ' ', str(value).upper()).split())
    def _guard_candidate_master(master_frame, seed_frame):
        rejected = {}
        for row in seed_frame.to_dict('records'):
            expected = str(row.get('identity_name_contains') or '').strip()
            if not expected: continue
            symbol = row['ticker']
            match = master_frame.loc[master_frame.symbol.eq(symbol)]
            names = match.get('englishName', pd.Series(dtype=str)).dropna().astype(str).tolist()
            verified = len(match) == 1 and any(
                _normalized_issuer_name(expected) in _normalized_issuer_name(name) for name in names
            )
            if not verified:
                rejected[symbol] = 'provider_issuer_identity_unverified'
        return (master_frame.loc[~master_frame.symbol.isin(rejected)].copy(),
                seed_frame.loc[~seed_frame.ticker.isin(rejected)].copy(), rejected)
    master, seed, candidate_identity_rejections = _guard_candidate_master(master, seed)
    candidate_quarantine.update(candidate_identity_rejections)
    if candidate_quarantine:
        print('Guarded candidates held separately:', candidate_quarantine)
    master['status'] = master['status'].fillna('UNKNOWN')
    master['isCommonShare'] = master['isCommonShare'].fillna(False)
    if master.status.eq('UNKNOWN').any():
        raise RuntimeError('Incomplete master; retry before publishing')
    master.to_parquet(MASTER_PATH, index=False)
    print('master rows:', len(master), 'ACTIVE:', int(master.status.astype(str).str.upper().eq('ACTIVE').sum()))

    _us_finish_stage('master')

else:
    print('SKIP: RUN_US_MARKET')
