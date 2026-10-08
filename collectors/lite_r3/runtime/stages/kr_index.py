if RUN_KR_MARKET:
    _SCREENING_DF_RUN_ID = None
    require_screening_ready('index')
    validate_screening_enrichment(non_index_df)

    # ============================================================
    # 6. KOSPI/KOSDAQ 지수 — Toss 일봉 + 실제 시장 투자자 매매대금
    # ============================================================

    def build_index_frame(symbol, name):
        candles = cached_frame(
            "toss_index_candles",
            symbol,
            lambda: get_candles_frame(symbol, TARGET_COUNT, True),
        )
        if candles.empty:
            return pd.DataFrame()

        flow = cached_frame(
            "toss_index_flow",
            symbol,
            lambda: get_market_investor_flow_frame(symbol, FLOW_COUNT),
        )
        df = merge_on_date(candles, [flow])
        df.insert(0, "symbol", symbol)
        df.insert(1, "name", name)
        df.insert(2, "market", "INDEX")
        df.insert(3, "securityType", "INDEX")
        df["priceSource"] = "TOSS_MARKET_INDICATOR"
        df["tradingValue"] = 0.0
        df["tradingValueSource"] = "NOT_APPLICABLE_INDEX"
        df["marketCap"] = pd.NA
        df["listedShares"] = pd.NA
        df["marketCapSource"] = pd.NA
        df["investorValueSource"] = "TOSS_MARKET_INDICATOR_KRW"
        df["investorVolumeSource"] = pd.NA
        df["programTradeSource"] = pd.NA
        return df

    index_frames = []
    for symbol, name in [("KOSPI", "코스피"), ("KOSDAQ", "코스닥")]:
        try:
            f = build_index_frame(symbol, name)
            if not f.empty:
                index_frames.append(f)
        except Exception as e:
            add_error("index_build", symbol, None, e)

    index_symbols = {str(f['symbol'].iloc[0]) for f in index_frames if not f.empty}
    missing_index_symbols = sorted({'KOSPI', 'KOSDAQ'} - index_symbols)
    if missing_index_symbols:
        warnings.warn(f"시장지수 수집 실패: {missing_index_symbols}")
        if STRICT_ALL_SYMBOLS:
            raise RuntimeError(f"시장지수 누락: {missing_index_symbols}")

    df = pd.concat(
        [non_index_df] + index_frames,
        ignore_index=True,
        sort=False,
    )

    print(f"지수 포함 전체: {len(df):,}행 / {df['symbol'].nunique():,} symbols")
    _SCREENING_DF_RUN_ID = RUN_ID

else:
    print('SKIP: RUN_KR_MARKET')
