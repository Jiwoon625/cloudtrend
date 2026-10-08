# Daily helper modules only; no collection or past reconstruction runs here.
_CT_KR_CALLBACK = {'__name__': 'cloudtrend_kr_callback', 'EXPECTED_SUPABASE_URL': EXPECTED_SUPABASE_URL,
                   'KR_CLAIM_DIRECTORY': str(KR_CLAIM_DIRECTORY)}
_CT_RUNTIME_EXEC('helpers/kr_callback.py', _CT_KR_CALLBACK)
_CT_US_ARCHIVE = {'__name__': 'cloudtrend_us_archive', 'EXPECTED_SUPABASE_URL': EXPECTED_SUPABASE_URL}
_CT_RUNTIME_EXEC('helpers/us_archive.py', _CT_US_ARCHIVE)
bind_kr_publication_receipt = _CT_KR_CALLBACK['bind_kr_publication_receipt']
if RUN_KR_MARKET:
    _kr_setup_line = "PUBLISH_CONTEXT = setup_publish() if AUTO_PUBLISH_TO_CLOUDTREND else None"
    import hashlib
    _kr_publisher_original = _kr_steps["step_05.py"]
    if hashlib.sha256(_kr_publisher_original.encode()).hexdigest() != '678e5694285cd20069767e5388bc5e4b2c30955dd18bd552e2bfd4df5d3f2ca4':
            raise RuntimeError("검토한 원본 게시 runtime이 아닙니다.")
    _kr_publisher_source = _CT_RUNTIME_TEXT("helpers/kr_publisher.py")
    _kr_publisher_source = _CT_KR_CALLBACK['patch_kr_publisher_source'](_kr_publisher_source)
    if _kr_publisher_source.count(_kr_setup_line) != 1:
            raise RuntimeError("검증된 게시 runtime 구조가 달라졌습니다. 임의 실행하지 않습니다.")
    exec(compile(_kr_publisher_source.replace(_kr_setup_line, "# setup deferred for progress instrumentation"),
                     str(_kr_bundle_path)+"/step_05.py", "exec"), globals(), globals())
    _CT_RUNTIME_EXEC("helpers/kr_progress.py", globals())
    _CT_RUNTIME_EXEC("helpers/kr_supply_readiness.py", globals())
    _CT_RUNTIME_EXEC("helpers/kr_schema.py", globals())
    install_publish_schema_v204(globals())
    install_publish_progress(globals())
    _CT_KR_CALLBACK['install_kr_publish_screening_callback'](globals())
    install_supply_readiness(globals())
    PUBLISH_CONTEXT = setup_publish() if AUTO_PUBLISH_TO_CLOUDTREND else None
