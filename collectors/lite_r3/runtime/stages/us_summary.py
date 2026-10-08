if RUN_US_MARKET:
    # ===== 13. 실행 요약: 셀 도달과 업로드/엔진 완료를 구분 =====
    _us_verified = bool(globals().get('_US_RUN_ID') and globals().get('_US_UPLOAD_VERIFIED', False) and
                        globals().get('_US_STAGE_RUN', {}).get('upload') == globals().get('_US_RUN_ID'))
    print('=== US 업로드 재조회 검증 완료 ===' if _us_verified else '=== US 미완료: 이번 실행 업로드 검증 없음 ===')
    print('이번 실행 완료 단계:', [stage for stage, token in globals().get('_US_STAGE_RUN', {}).items()
                                   if token == globals().get('_US_RUN_ID')])
    print('Candidate identity/history holds:', globals().get('candidate_quarantine', {}))
    print('Candidate scoring holds:', globals().get('candidate_scoring_holds', {}))
    print('공식 lifecycle 제외:', sorted(globals().get('lifecycle_exempt_symbols', set())))
    print('Provider gap 일시 제외:', sorted(globals().get('provider_gap_symbols', set())))
    if _us_verified:
        print('as-of:', latest_date, 'snapshot rows:', len(out))
        print('Supabase:', storage_path, 'data hash:', data_hash)
    else:
        print('실패한 단계부터 순서대로 재실행하세요. 이전 실행의 경로·해시는 완료 증거로 표시하지 않습니다.')
    print('GitHub dispatch:', globals().get('_US_DISPATCH_STATUS', 'NOT_REQUESTED'))
    print('스크리닝 완료 여부는 GitHub 실행 결과와 CloudTrend 결과 기준일을 별도로 확인해야 합니다.')
else:
    print('SKIP: RUN_US_MARKET')
