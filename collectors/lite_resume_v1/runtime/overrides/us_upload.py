if RUN_US_MARKET:
    _us_begin_stage('upload')
    _us_require_stage('snapshot')
    _US_UPLOAD_VERIFIED = False
    if not globals().get('_US_SNAPSHOT_READY', False):
        raise RuntimeError('US cell 10 did not complete; stop before upload and rerun corrected cell 10')
    if globals().get('_US_LIFECYCLE_DERIVATIVE'):
        _us_api = _CT_US_ARCHIVE['UsArchiveApi'](SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_USER_ID, GITHUB_TOKEN, requests)
        _before = _us_api.rows('us_screening_ingest', {'select':'as_of_date,data_hash,row_count,symbol_count'})
        if _before != [_registered]:
            raise RuntimeError('Registered source changed before reviewed upload; no dispatch')
        _US_DAILY_ARCHIVE_SOURCE = _CT_US_ARCHIVE['upload_us_lifecycle_derivative'](
            api=_us_api, correction=_US_LIFECYCLE_DERIVATIVE)
        if _us_api.rows('us_screening_ingest', {'select':'as_of_date,data_hash,row_count,symbol_count'}) != _before:
            raise RuntimeError('Registered source changed during reviewed upload; no dispatch')
        storage_path = _US_DAILY_ARCHIVE_SOURCE['storagePath']
        _US_UPLOAD_VERIFIED = True
        print('검토 파생자료 업로드·재조회 완료. 원본 ingest 유지; 파생자료 manifest로 스크리닝을 연결합니다.')
    else:
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
                'providerGapReasons':globals().get('provider_gap_reasons', {}),
                'screenedSymbolCount':int(out.symbol.nunique()),
                'marketCalendarOk':bool(market_calendar.get('ok')),
                'exchangeRateOk':bool(exchange_rate.get('ok')),
                'rankingOk':bool(ranking_amount.get('ok')),
            }
        }
        _US_DAILY_ARCHIVE_SOURCE = _CT_US_ARCHIVE['preserve_us_daily_before_upload'](
            raw=raw, payload=payload, root=DATED_ARCHIVE_DIR, user_id=SUPABASE_USER_ID)

        from cloudtrend_lite_resume_v1.http import create_verified
        _remote_url = f'{SUPABASE_URL}/storage/v1/object/authenticated/cloudtrend-data/{storage_path}'
        def _read_existing_upload():
            response = requests.get(_remote_url, headers=headers, timeout=120)
            if response.status_code == 404:
                return None
            response.raise_for_status()
            return response.content
        def _create_upload():
            response = requests.post(
                f'{SUPABASE_URL}/storage/v1/object/cloudtrend-data/{storage_path}',
                headers={**headers,'Content-Type':'text/csv','x-upsert':'false'},
                data=raw, timeout=120)
            response.raise_for_status()
        create_verified(read=_read_existing_upload, create=_create_upload, expected=raw)

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
            try:
                r=requests.post(
                    f'{SUPABASE_URL}/rest/v1/us_screening_ingest?on_conflict=user_id',
                    headers={**headers,'Content-Type':'application/json','Prefer':'resolution=merge-duplicates,return=representation'},
                    json=payload, timeout=60,
                )
                r.raise_for_status()
            except Exception:
                # Do not repeat POST. A successful exact pointer read is the only
                # evidence that an interrupted response was already committed.
                _reconcile = requests.get(f'{SUPABASE_URL}/rest/v1/us_screening_ingest',
                    headers=headers, params={'user_id':'eq.'+SUPABASE_USER_ID}, timeout=30)
                _reconcile.raise_for_status()
                _rows = _reconcile.json()
                if (len(_rows) != 1 or _rows[0].get('as_of_date') != latest_date
                        or _rows[0].get('data_hash') != data_hash):
                    raise RuntimeError('Ingest outcome unresolved; do not redispatch') from None
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
