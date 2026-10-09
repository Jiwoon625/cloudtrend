if RUN_US_MARKET:
    _us_begin_stage('features')
    _us_require_stage('collection')
    # ===== 8. 전략 원자 피처 계산 =====
    screening_seed = seed.loc[~seed.ticker.isin(globals().get('candidate_scoring_holds', {}))].copy()
    px=combined[combined.date.le(AS_OF_DATE) & combined.symbol.isin(screening_seed.ticker)].copy()
    px=_CT_COMPUTE_US_FEATURE_PANEL(px)

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
