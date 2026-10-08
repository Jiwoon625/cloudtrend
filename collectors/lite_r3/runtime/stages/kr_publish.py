if RUN_KR_MARKET:
    publish_result = None
    require(globals().get('_SCREENING_DF_RUN_ID') == RUN_ID, '이번 실행 수집이 끝나지 않았습니다.')
    # 원본 CSV/manifest는 이미 Drive에 저장됨. Node 검증 전에 중복 메모리 제거.
    # 수집 재개용 체크포인트·manifest·등록 인증정보는 삭제하지 않습니다.
    import gc as _ct_gc
    for _ct_name in ('df', 'non_index_df', 'valid_frames', 'index_frames',
                     'symbol_frames', 'completed_map', 'missing_df'):
        globals().pop(_ct_name, None)
    _ct_gc.collect()
    if AUTO_PUBLISH_TO_CLOUDTREND:
        publish_result = publish_to_supabase(PUBLISH_CONTEXT, manifest_path, RUN_ID)
    else:
        print('자동 반영 OFF: Drive 저장만 완료했습니다.')

else:
    print('SKIP: RUN_KR_MARKET')
