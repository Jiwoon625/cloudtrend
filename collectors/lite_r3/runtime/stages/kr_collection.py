if RUN_KR_MARKET:
    publish_result = None
    #@title 자료 수집
    _kr_run_step("step_12.py", globals())

else:
    print('SKIP: RUN_KR_MARKET')
