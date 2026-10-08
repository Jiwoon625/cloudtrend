#@title 종목 목록과 수집 설정
if RUN_KR_MARKET:
    # 이력 판정은 실제 지수 거래일과 STOCKS가 확정된 다음 셀에서 수행합니다.
    _kr_settings_source = _kr_steps["step_07.py"]
    _kr_readiness_start = 'if COLLECTION_PROFILE == "SCREENING" and (COLLECT_TOSS_SHORT or COLLECT_TOSS_LENDING):'
    _kr_readiness_end = '# Official API does not provide individual security investor amounts.'
    if _kr_settings_source.count(_kr_readiness_start) != 1 or _kr_settings_source.count(_kr_readiness_end) != 1:
        raise RuntimeError("검증된 이력 판정 runtime 구조가 달라졌습니다.")
    _kr_start = _kr_settings_source.index(_kr_readiness_start)
    _kr_end = _kr_settings_source.index(_kr_readiness_end, _kr_start)
    _kr_settings_source = (_kr_settings_source[:_kr_start] +
        'print("Supply Risk: 실제 시장 거래일 확인 후 준비도와 수집 일수를 확정합니다.")\n\n' +
        _kr_settings_source[_kr_end:])
    exec(compile(_kr_settings_source, str(_kr_bundle_path)+"/step_07.py", "exec"), globals(), globals())
    _CT_SUPPLY_BASE_PROFILE = RUN_PROFILE
    _CT_SUPPLY_REQUESTED_TARGET, _CT_SUPPLY_REQUESTED_FLOW = TARGET_COUNT, FLOW_COUNT
else:
    print('SKIP: RUN_KR_MARKET')
