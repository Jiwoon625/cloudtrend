if RUN_KR_MARKET:
    RETRY_SAVED_UPLOAD = bool(globals().get("RETRY_SAVED_UPLOAD", False))
    SAVED_MANIFEST = globals().get("SAVED_MANIFEST", "")
    if RETRY_SAVED_UPLOAD:
        require(bool(SAVED_MANIFEST.strip()), '재시도할 manifest 경로를 입력하세요.')
        require(globals().get('PUBLISH_CONTEXT') is not None, 'Supabase 직접 등록 준비 셀을 먼저 실행하세요.')
        saved = json.loads(Path(SAVED_MANIFEST).read_text(encoding='utf-8'))
        publish_result = publish_to_supabase(PUBLISH_CONTEXT, SAVED_MANIFEST, saved['runId'])

else:
    print('SKIP: RUN_KR_MARKET')
