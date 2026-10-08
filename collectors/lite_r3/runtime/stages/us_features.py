if RUN_US_MARKET:
    _us_begin_stage('features')
    _us_require_stage('collection')
    # ===== 8. 전략 원자 피처 계산 =====
    screening_seed = seed.loc[~seed.ticker.isin(globals().get('candidate_scoring_holds', {}))].copy()
    px=combined[combined.date.le(AS_OF_DATE) & combined.symbol.isin(screening_seed.ticker)].copy()
    for c in ['open','high','low','close','volume']:
        px[c]=pd.to_numeric(px[c],errors='coerce')
    # Align observations to SPY sessions so gaps cannot count as active trading days.
    sessions=sorted(px.loc[px.symbol.eq('SPY'),'date'].unique())
    aligned=[]
    for symbol, frame in px.groupby('symbol'):
        first_date=frame.date.min()
        frame=frame.set_index('date').reindex([d for d in sessions if d>=first_date])
        frame.index.name='date'
        frame['symbol']=symbol
        aligned.append(frame.reset_index())
    px=pd.concat(aligned,ignore_index=True).sort_values(['symbol','date'])
    del aligned  # no longer keep one DataFrame per symbol in memory
    g=px.groupby('symbol',group_keys=False)
    px['ret1']=g['close'].pct_change(fill_method=None)
    px['ret120']=g['close'].pct_change(120,fill_method=None)
    px['ret252']=g['close'].pct_change(252,fill_method=None)
    px['dollar_volume']=px['close']*px['volume']
    px['adv20_usd']=g['dollar_volume'].transform(lambda s:s.rolling(20,min_periods=20).mean())
    px['amihud_raw']=px['ret1'].abs()/px['dollar_volume'].replace(0,np.nan)
    px['amihud20']=g['amihud_raw'].transform(lambda s:s.rolling(20,min_periods=20).mean())
    px['vol20_avg']=g['volume'].transform(lambda s:s.rolling(20,min_periods=20).mean())
    px['relvol1_20']=px['volume']/px['vol20_avg']-1
    px['tenkan9']=(g['high'].transform(lambda s:s.rolling(9,min_periods=9).max())+g['low'].transform(lambda s:s.rolling(9,min_periods=9).min()))/2
    px['kijun26']=(g['high'].transform(lambda s:s.rolling(26,min_periods=26).max())+g['low'].transform(lambda s:s.rolling(26,min_periods=26).min()))/2
    px['ichimoku_tk_gap']=px['tenkan9']/px['kijun26']-1
    px['active20']=g['volume'].transform(lambda s:s.gt(0).rolling(20,min_periods=20).sum()).ge(20)

    # beta60_spy: 종목 일수익률과 SPY 일수익률의 최근 60개 공통 관측 cov/var
    del g  # release old frame reference before merge creates a new frame
    spy=px[px.symbol.eq('SPY')][['date','ret1']].rename(columns={'ret1':'spy_ret1'})
    px=px.merge(spy,on='date',how='left')
    # Per-symbol Series rolling yields the same 60-session beta without copying
    # or concatenating the full feature table for every symbol.
    _beta = np.full(len(px), np.nan, dtype='float64')
    _ret_col, _spy_col = px['ret1'], px['spy_ret1']
    for _row_positions in px.groupby('symbol',sort=False).indices.values():
        _ix = np.asarray(_row_positions,dtype=np.intp)
        _r, _s = _ret_col.iloc[_ix], _spy_col.iloc[_ix]
        _cov = _r.rolling(60,min_periods=50).cov(_s)
        _var = _s.rolling(60,min_periods=50).var()
        _beta[_ix] = (_cov / _var.replace(0,np.nan)).to_numpy()
    px['beta60_spy'] = _beta
    del _beta, _ret_col, _spy_col, _row_positions, _ix, _r, _s, _cov, _var

    latest_date=AS_OF_DATE
    if px.loc[px.symbol.eq('SPY'),'date'].max() != latest_date: raise RuntimeError('SPY is stale')
    snap=px[px.date.eq(latest_date)].copy()
    # 마스터 보강
    mcols=['symbol','name','englishName','market','securityType','status','currency','sharesOutstanding','isCommonShare','sector']
    meta=master[[c for c in mcols if c in master.columns]].copy()
    snap=snap.merge(meta,on='symbol',how='left',suffixes=('','_master'))
    if 'currency_master' in snap: snap['currency']=snap['currency_master'].fillna(snap['currency'])
    snap['shares_outstanding']=pd.to_numeric(snap.get('sharesOutstanding'),errors='coerce')
    snap['market_cap']=snap['close']*snap['shares_outstanding']
    snap['toss_tradable']=snap['status'].astype(str).str.upper().eq('ACTIVE')
    snap['is_common_share']=snap['isCommonShare'].fillna(False).map(truthy) & snap.symbol.ne('SPY')
    # Provider ACTIVE flags can lag completed exchange corporate actions.
    # VERIFIED_LIFECYCLE_EVENTS is defined in the US settings cell and reused by collector QA.
    def apply_verified_lifecycle(snapshot, expected_symbols, as_of_date, events, provider_gaps):
        _validated = _validate_lifecycle_events(events, as_of_date)
        applied=[]
        for event in events:
            if event['symbol'] not in _validated: continue
            if event['symbol']=='SPY' or not event.get('source_url'):
                raise ValueError('Lifecycle event requires an evidence URL and cannot exempt SPY')
            mask=snapshot.symbol.eq(event['symbol'])
            if mask.any():
                snapshot.loc[mask,'status']=event['status']
                snapshot.loc[mask,'toss_tradable']=False
                snapshot.loc[mask,'active20']=False
                # Preserve issuer/status, never expose OTC/stale prices as executable exchange OHLC.
                _blocked_values = ['open','high','low','close','volume','dollar_volume','market_cap',
                                   'ret120','ret252','beta60_spy','ichimoku_tk_gap','relvol1_20','adv20_usd','amihud20']
                snapshot.loc[mask, [column for column in _blocked_values if column in snapshot.columns]] = np.nan
            # A verified effective event exempts the symbol even when no as-of row exists.
            applied.append(dict(event))
        lifecycle_exempt={event['symbol'] for event in applied}
        provider_gap_exempt=set(provider_gaps)
        if 'SPY' in provider_gap_exempt:
            raise RuntimeError('SPY cannot be provider-gap quarantined')
        missing=set(expected_symbols)-set(snapshot.loc[snapshot.close.gt(0),'symbol'])-lifecycle_exempt-provider_gap_exempt
        if missing:
            raise RuntimeError(
                'Missing confirmed-session bars after collector QA: '
                f'{sorted(missing)[:20]}. These are neither verified lifecycle nor provider-gap quarantine symbols.'
            )
        present_quarantined=provider_gap_exempt & set(snapshot.loc[snapshot.close.gt(0),'symbol'])
        if present_quarantined:
            raise RuntimeError(f'Provider-gap symbols unexpectedly have current bars: {sorted(present_quarantined)}')
        return applied
    lifecycle_events=apply_verified_lifecycle(
        snap, screening_seed.ticker, AS_OF_DATE, VERIFIED_LIFECYCLE_EVENTS, provider_gap_symbols
    )
    print('Verified lifecycle exclusions (SUSPENDED / toss_tradable=False):', lifecycle_events)
    if provider_gap_symbols:
        print('Provider-gap quarantined for this session:', sorted(provider_gap_symbols))
    snap['name']=snap.get('englishName').fillna(snap.get('name')).fillna(snap['symbol'])
    print('latest date:',latest_date,'snapshot:',len(snap),'complete ret252:',snap.ret252.notna().sum())
    # 400-bar panel is no longer needed once snapshot features are calculated.
    # Only small seed/master/snapshot and upload inputs survive into later cells.
    for _ct_name in ('px','combined','spy','meta','screening_seed','frame'):
        globals().pop(_ct_name,None)
    import gc as _ct_gc
    _ct_gc.collect()

    _us_finish_stage('features')

else:
    print('SKIP: RUN_US_MARKET')
