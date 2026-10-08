#@title C. 통합 실행 요약 — 실제 완료/게시 검증 기준
print('=' * 72)
print('CloudTrend 통합 실행 상태')
print('slot:', INTEGRATED_SLOT)
if RUN_KR_MARKET:
    _kr_receipt = globals().get('publish_result') or {}
    _kr_run = globals().get('RUN_ID')
    _kr_published = bool(_kr_run and _kr_receipt.get('runId') == _kr_run and _kr_receipt.get('status') == 'PUBLISHED')
    _kr_collected = bool(_kr_run and globals().get('_SCREENING_DF_RUN_ID') == _kr_run)
    print('KR:', '게시·재조회 검증 완료' if _kr_published else ('수집 완료 / 게시 미검증' if _kr_collected else '미완료'))
    print('KR effective as-of:', _kr_receipt.get('asOfDate') if _kr_published else globals().get('COLLECTION_CUTOFF_DATE'))
else:
    print('KR: SKIP')
if RUN_US_MARKET:
    _us_run = globals().get('_US_RUN_ID')
    _us_verified = bool(_us_run and globals().get('_US_STAGE_RUN', {}).get('upload') == _us_run
                        and globals().get('_US_UPLOAD_VERIFIED', False))
    print('US:', '업로드·재조회 검증 완료' if _us_verified else '미완료 / 이번 실행 업로드 미검증')
    if _us_verified:
        print('US as-of:', latest_date)
        print('US source:', out_path)
        print('US storage:', storage_path)
    print('US dispatch:', globals().get('_US_DISPATCH_STATUS', 'NOT_REQUESTED'))
    print('US 스크리닝 엔진 완료 여부: 별도 확인 필요')
else:
    print('US: SKIP')
print('=' * 72)

print('KR 자동 스크리닝 요청:', (globals().get('_KR_SCREENING_REQUEST') or {}).get('status','NOT_REQUESTED'))
print('US 날짜별 입력:', globals().get('_US_ARCHIVE_STATUS'))
