if RUN_US_MARKET:
    _us_begin_stage('dispatch')
    _us_require_stage('upload')
    _us_require_stage('archive')
    if not _US_UPLOAD_VERIFIED:
        raise RuntimeError('미국 업로드 검증이 필요합니다.')
    _us_api = _CT_US_ARCHIVE['UsArchiveApi'](SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_USER_ID, GITHUB_TOKEN, requests)
    if not DISPATCH_GITHUB_AFTER_UPLOAD:
        _US_DISPATCH_STATUS = 'DISABLED'
    else:
        try:
            _base = _us_api.common_base()
            _dates_to_run = [d for d in _US_ARCHIVE_STATUS['dates'] if d > _base]
            if _dates_to_run:
                _cursor = _dates_to_run[0]
                while _cursor > _base:
                    _receipt = json.loads((DATED_ARCHIVE_DIR / _cursor / 'source.json').read_text())
                    _prior_date = _receipt['previousSessionDate']
                    if _prior_date == _base:
                        break
                    if not _base < _prior_date < _cursor:
                        raise RuntimeError('보존된 거래일 순서가 맞지 않습니다.')
                    if len(_dates_to_run) >= 31:
                        raise RuntimeError('자동 복구 범위를 넘었습니다.')
                    _dates_to_run.insert(0, _prior_date)
                    _cursor = _prior_date
            if len(_dates_to_run) > 1:
                _request = _CT_US_ARCHIVE['publish_us_atomic_chain'](api=_us_api, root=DATED_ARCHIVE_DIR, dates=_dates_to_run, base_date=_base)
            elif _dates_to_run and _previous_by_date[_dates_to_run[0]] != _base:
                raise RuntimeError('선택 기간보다 앞선 누락 거래일이 있습니다. 날짜별 자료를 확인하세요.')
            else:
                _request = _CT_US_ARCHIVE['dispatch_us_once'](api=_us_api, root=DATED_ARCHIVE_DIR, fingerprint=data_hash[7:] + '_latest', inputs={'supabase_user_id': SUPABASE_USER_ID})
            _US_DISPATCH_STATUS = _request['status']
            print('미국 스크리닝 요청:', _US_DISPATCH_STATUS, '(요청 접수와 엔진 완료는 다릅니다)')
        except Exception as _error:
            _US_DISPATCH_STATUS = 'BLOCKED_REPLAY_PREFLIGHT'
            print('미국 날짜순 처리 사전 확인 중단:', type(_error).__name__)
            print('서버 날짜 또는 보존된 입력을 확인하세요. 자료/모델을 덮어쓰지 않았습니다.')
    _us_finish_stage('dispatch')
else:
    print('SKIP: RUN_US_MARKET')
