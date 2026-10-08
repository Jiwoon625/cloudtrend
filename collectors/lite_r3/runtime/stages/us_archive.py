# Current source was already preserved before HTTP upload.
if RUN_US_MARKET:
    _us_begin_stage('archive')
    _us_require_stage('upload')
    if not _US_UPLOAD_VERIFIED or not _US_DAILY_ARCHIVE_SOURCE:
        raise RuntimeError('이번 실행의 업로드 검증과 날짜별 원본 보존이 필요합니다.')
    if _US_DAILY_ARCHIVE_SOURCE['date'] != AS_OF_DATE or _US_DAILY_ARCHIVE_SOURCE['dataHash'] != data_hash:
        raise RuntimeError('이번 실행의 날짜별 원본이 일치하지 않습니다.')
    _US_ARCHIVE_STATUS = {'runId':_US_RUN_ID, 'status':'ATOMIC_CHAIN_READY', 'dates':[AS_OF_DATE]}
    _previous_by_date = {AS_OF_DATE: PREVIOUS_SESSION}
    _us_finish_stage('archive')
else:
    print('SKIP: RUN_US_MARKET')
