if RUN_KR_MARKET:
    _SCREENING_ENRICHED_RUN_ID = None
    _SCREENING_DF_RUN_ID = None
    if globals().get('_SCREENING_COLLECTED_RUN_ID') != RUN_ID:
        raise RuntimeError('수집 셀이 정상 종료되지 않았습니다. 수집 셀부터 재실행하세요.')

    from pathlib import Path
    import pandas as pd

    # 체크포인트에서 정상 완료 데이터를 다시 불러와 메모리 데이터셋을 재구성합니다.
    # 여기서는 대형 중간 CSV를 저장하지 않습니다. 최종 CSV는 아래 저장/QA 셀에서만
    # 42MB 목표 / 45MB hard limit 규칙에 따라 분할 저장됩니다.
    completed_map = {normalize_symbol(f["symbol"].iloc[0]): f for f in symbol_frames if not f.empty}
    valid_frames = []

    for symbol, frame in completed_map.items():
        symbol = normalize_symbol(symbol)
        quality = _completion_quality(frame, symbol)
        if not quality["ok"]:
            print(f"검증 제외: {symbol} / {quality['reason']}")
            continue
        part = frame.copy()
        part["symbol"] = part["symbol"].astype(str).map(normalize_symbol)
        part["date"] = part["date"].astype(str)
        valid_frames.append(part)

    if not valid_frames:
        raise RuntimeError("체크포인트에서 저장 가능한 데이터를 찾지 못했습니다.")

    non_index_df = (
        pd.concat(valid_frames, ignore_index=True, sort=False)
        .sort_values(["symbol", "date"])
        .drop_duplicates(subset=["symbol", "date"], keep="last")
        .reset_index(drop=True)
    )

    saved_symbols = set(non_index_df["symbol"].dropna().astype(str).map(normalize_symbol))
    missing_symbols = [
        normalize_symbol(symbol)
        for symbol in ALL_SYMBOLS
        if normalize_symbol(symbol) not in saved_symbols
    ]

    print("=" * 70)
    print("체크포인트 재구성 완료 — 중간 대형 CSV는 저장하지 않습니다.")
    print(f"행수: {len(non_index_df):,}")
    print(f"종목수: {len(saved_symbols):,}")
    print(f"미완료 종목수: {len(missing_symbols):,}")
    print(f"미완료 앞 20개: {missing_symbols[:20]}")
    print("=" * 70)

    # 체크포인트 재구성 후 적용해야 최종 CSV에 SCREENING exact 보강값이 남습니다.
    # V3.1: 최신 KRX 시가총액을 먼저 채우고, 최근 30거래일 외국인 순매수금액을 보강합니다.
    non_index_df = apply_screening_latest_market_cap_batch(non_index_df.reset_index(drop=True))
    non_index_df = apply_screening_krx_foreign_batch(non_index_df.reset_index(drop=True))
    validate_screening_enrichment(non_index_df)
    _SCREENING_ENRICHED_RUN_ID = RUN_ID

else:
    print('SKIP: RUN_KR_MARKET')
