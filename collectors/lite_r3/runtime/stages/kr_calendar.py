#@title 실제 거래일 확인 · 주식별 Supply Risk 21일 이력 검증
if RUN_KR_MARKET:
    REQUESTED_CALENDAR_CUTOFF_DATE = COLLECTION_CUTOFF_DATE
    # 현재 거래일은 새로 수집하므로, 지수 22일 중 직전 21일을 이력 검증에 사용합니다.
    _kr_supply_probes = {}
    for _idx in ['KOSPI', 'KOSDAQ']:
        _kr_supply_probes[_idx] = get_candles_frame(_idx, SUPPLY_RISK_REQUIRED_OBSERVATIONS + 1, True)
    finalize_supply_readiness(_kr_supply_probes)
    install_supply_counts()
    print(f'조회 상한 {REQUESTED_CALENDAR_CUTOFF_DATE} → 실제 거래일 {COLLECTION_CUTOFF_DATE}')
    print(f'최종 수집 일수: 가격 {TARGET_COUNT} / 수급 {FLOW_COUNT}; 실행별 이력 판정은 manifest에 기록됩니다.')
else:
    print('SKIP: RUN_KR_MARKET')
