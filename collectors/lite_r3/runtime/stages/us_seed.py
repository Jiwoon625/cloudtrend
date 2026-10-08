if RUN_US_MARKET:
    _us_begin_stage('seed')
    _us_require_stage('auth')
    # ===== 5. Maintained collection roster + live Toss eligibility =====
    # Research mapping is frozen. Daily runs read only this small ticker/sector roster.
    COLLECTION_UNIVERSE = Path('/content/drive/MyDrive/CloudTrend/미국시장/reference/us_collection_universe_v1.csv')
    if not COLLECTION_UNIVERSE.exists():
        raise FileNotFoundError(f'Collection roster missing: {COLLECTION_UNIVERSE}')

    def truthy(s): return str(s).strip().lower() in {'true','1','y','yes','t'}

    def build_collection_seed(roster, listed_rows):
        required = {'ticker','sectorCode','role'}
        if not required.issubset(roster.columns):
            raise ValueError('Roster requires ticker, sectorCode, role')
        roster = roster.copy()
        for c in required:
            roster[c] = roster[c].astype(str).str.strip()
        roster['ticker'] = roster['ticker'].str.upper()
        if roster.empty or roster.ticker.duplicated().any() or not roster.ticker.str.match(r'^[A-Z0-9.\-]+$').all():
            raise ValueError('Empty, duplicate, or invalid roster ticker')
        if not roster.role.isin(['EQUITY','BENCHMARK']).all() or roster.sectorCode.eq('').any():
            raise ValueError('Invalid roster role or sector')
        benchmark = roster.loc[roster.role.eq('BENCHMARK')]
        if benchmark.ticker.tolist() != ['SPY'] or benchmark.sectorCode.tolist() != ['BENCHMARK']:
            raise ValueError('Exactly one SPY benchmark is required')
        safety_columns = ['identity_name_contains', 'history_start_date', 'predecessor_ticker']
        for col in safety_columns:
            if col not in roster.columns: roster[col] = ''
            roster[col] = roster[col].fillna('').astype(str).str.strip()
        # Both fields are mandatory together; malformed guarded candidates fail closed.
        guarded = roster.identity_name_contains.ne('') | roster.history_start_date.ne('')
        if (guarded & (roster.identity_name_contains.eq('') | ~roster.history_start_date.str.match(r'^\d{4}-\d{2}-\d{2}$'))).any():
            raise ValueError('Guarded candidate needs issuer name and ISO history start date')
        for value in roster.loc[guarded, 'history_start_date']:
            pd.Timestamp(value)
        benchmark = roster.loc[roster.role.eq('BENCHMARK')]
        seed_columns = ['ticker', 'sectorCode', *safety_columns]
        supported = {str(r.get('symbol','')).upper().strip() for r in listed_rows if truthy(r.get('isCommonShare',False))}
        equities = roster.loc[roster.role.eq('EQUITY') & roster.ticker.isin(supported), seed_columns]
        if equities.empty:
            raise RuntimeError('No live tradable equities; refusing an empty universe')
        return pd.concat([equities,benchmark[seed_columns]],ignore_index=True).sort_values('ticker').reset_index(drop=True)

    collection_roster = pd.read_csv(COLLECTION_UNIVERSE,dtype=str,keep_default_na=False)
    collection_universe_hash = 'sha256:' + hashlib.sha256(COLLECTION_UNIVERSE.read_bytes()).hexdigest()
    listed=[]
    for market in ['NYSE','NASDAQ','AMEX','US_ETC']:
        body,_=toss_get('/api/v1/stocks/all',{'market':market,'status':'ACTIVE','commonShare':'true'})
        result=body.get('result')
        if not isinstance(result,list) or (market != 'US_ETC' and not result):
            raise RuntimeError(f'Incomplete Toss universe response: {market}')
        listed.extend({**item,'market':market} for item in result)
        time.sleep(1.05)
    seed=build_collection_seed(collection_roster,listed)
    guarded_roster_symbols = set(collection_roster.loc[
        collection_roster.get('identity_name_contains', pd.Series('', index=collection_roster.index)).fillna('').ne(''), 'ticker'
    ])
    candidate_roster_exclusions = {
        symbol: 'not_in_live_active_common_share_response'
        for symbol in sorted(guarded_roster_symbols - set(seed.ticker))
    }
    if candidate_roster_exclusions:
        print('New candidates not currently eligible:', candidate_roster_exclusions)
    seed_path=BASE_DIR/'us_universe_seed.csv'
    seed.to_csv(seed_path,index=False)
    print('collection roster:',COLLECTION_UNIVERSE)
    print('roster candidates:',len(collection_roster),'live collection incl SPY:',len(seed))
    print('candidate-only / unsupported:',len(collection_roster)-len(seed))
    print('roster hash:',collection_universe_hash)

    _us_finish_stage('seed')

else:
    print('SKIP: RUN_US_MARKET')
