if RUN_US_MARKET:
    _us_begin_stage('upload')
    _us_require_stage('snapshot')
    _US_UPLOAD_VERIFIED = False
    if not globals().get('_US_SNAPSHOT_READY', False):
        raise RuntimeError('US cell 10 did not complete; stop before upload and rerun corrected cell 10')
    # ===== 11. Supabase private Storage + ingest pointer 업로드 =====
    assert SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY and SUPABASE_USER_ID
    storage_path=f'{SUPABASE_USER_ID}/source/us-screening/{latest_date}/{data_hash.split(":")[1]}.csv'
    headers={
        'Authorization':f'Bearer {SUPABASE_SERVICE_ROLE_KEY}',
        'apikey':SUPABASE_SERVICE_ROLE_KEY,
    }
    payload={
        'user_id':SUPABASE_USER_ID,
        'as_of_date':latest_date,
        'storage_bucket':'cloudtrend-data',
        'storage_path':storage_path,
        'row_count':int(len(out)),
        'symbol_count':int(out.symbol.nunique()),
        'data_hash':data_hash,
        'schema_version':'us-prospective-v1',
        'source_provider':'TOSS_OPEN_API',
        'collected_at':datetime.now(timezone.utc).isoformat(),
        'metadata':{
            'notebook':'cloudtrend자료수집_v2.0.4_lite_r3.ipynb',
            'cachePath':str(CACHE_PATH),
            'masterPath':str(MASTER_PATH),
            'mappingVersion':'20260927_r2',
            'collectionUniverseVersion':'1',
            'collectionUniversePath':str(COLLECTION_UNIVERSE),
            'collectionUniverseHash':collection_universe_hash,
            'failedSymbols':len(unhandled_failures),
            'sourceCoverageComplete':not bool(provider_gap_symbols or unhandled_failures or globals().get('candidate_scoring_holds') or globals().get('candidate_quarantine')),
            'sourceCoveragePolicy':'verified-lifecycle-and-explicit-quarantine-v1',
            'unresolvedProviderGapCount':len(provider_gap_symbols),
            'previousSessionDate':PREVIOUS_SESSION,
            'confirmedRegularClose':True,
            'collectorVersion':COLLECTOR_VERSION,
            'rosterIdentityGuardVersion':'issuer-start-v1',
            'guardedCandidateQuarantine':globals().get('candidate_quarantine', {}),
            'guardedCandidateScoringHolds':globals().get('candidate_scoring_holds', {}),
            'verifiedLifecycleEvents':lifecycle_events,
            'lifecycleExcludedSymbols':sorted(lifecycle_exempt_symbols & set(seed.ticker)),
            'providerGapPolicyVersion':PROVIDER_GAP_POLICY_VERSION,
            'providerGapCount':len(provider_gap_symbols),
            'providerGapSymbols':sorted(provider_gap_symbols),
            'providerGapLatestBarDates':provider_gap_latest_dates,
            'screenedSymbolCount':int(out.symbol.nunique()),
            'marketCalendarOk':bool(market_calendar.get('ok')),
            'exchangeRateOk':bool(exchange_rate.get('ok')),
            'rankingOk':bool(ranking_amount.get('ok')),
        }
    }
    _US_DAILY_ARCHIVE_SOURCE = _CT_US_ARCHIVE['preserve_us_daily_before_upload'](
        raw=raw, payload=payload, root=DATED_ARCHIVE_DIR, user_id=SUPABASE_USER_ID)

    up=requests.post(
        f'{SUPABASE_URL}/storage/v1/object/cloudtrend-data/{storage_path}',
        headers={**headers,'Content-Type':'text/csv','x-upsert':'false'},
        data=raw, timeout=120,
    )
    if up.status_code>=300 and up.status_code not in (400,409):
        raise RuntimeError(f'Supabase Storage upload failed {up.status_code}: {up.text[:1000]}')

    readback=requests.get(f'{SUPABASE_URL}/storage/v1/object/authenticated/cloudtrend-data/{storage_path}',headers=headers,timeout=120)
    readback.raise_for_status()
    assert hashlib.sha256(readback.content).hexdigest() == data_hash.split(':')[1], 'Storage hash mismatch'
    import io
    verified=pd.read_csv(io.BytesIO(readback.content))
    assert len(verified)==len(out) and verified.symbol.nunique()==len(out) and verified.date.eq(latest_date).all()
    prior=requests.get(f'{SUPABASE_URL}/rest/v1/us_screening_ingest',headers=headers,params={'user_id':'eq.'+SUPABASE_USER_ID,'select':'as_of_date,data_hash'},timeout=30)
    prior.raise_for_status()
    if prior.json():
        existing=prior.json()[0]
        if existing['as_of_date']>latest_date or (existing['as_of_date']==latest_date and existing['data_hash']!=data_hash):
            raise RuntimeError('Existing date/hash is immutable; source saved separately for QA')

    if not prior.json() or existing['as_of_date'] < latest_date:
        r=requests.post(
            f'{SUPABASE_URL}/rest/v1/us_screening_ingest?on_conflict=user_id',
            headers={**headers,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=representation'},
            json=payload, timeout=60,
        )
        if r.status_code>=300: raise RuntimeError(f'ingest upsert failed {r.status_code}: {r.text}')
    else:
        print('Daily source already registered; preserving original collection metadata')
    print('Supabase upload OK:',storage_path)

    check=requests.get(f'{SUPABASE_URL}/rest/v1/us_screening_ingest',headers=headers,params={'user_id':'eq.'+SUPABASE_USER_ID},timeout=30)
    check.raise_for_status()
    assert check.json()[0]['data_hash']==data_hash
    _US_UPLOAD_VERIFIED = True
    print('Storage + ingest read-back verified')

    _us_finish_stage('upload')

else:
    print('SKIP: RUN_US_MARKET')
