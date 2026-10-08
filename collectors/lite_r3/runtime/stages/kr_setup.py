if RUN_KR_MARKET:
    from datetime import datetime
    from zoneinfo import ZoneInfo
    #@title 1. 사용자 설정 — 대상과 기간을 설정한 뒤 모두 실행
    KRX_BACKEND = globals().get('KRX_BACKEND', 'OFFICIAL')
    MODE = globals().get('MODE', 'SCREENING')
    UNIVERSE_MODE = globals().get('UNIVERSE_MODE', 'ALL')
    ETF_UNIVERSE_MODE = globals().get('ETF_UNIVERSE_MODE', 'KRX_CURRENT')
    STOCK_CODES = globals().get('STOCK_CODES', None)
    ETF_CODES = globals().get('ETF_CODES', None)
    SCHEMA_REVIEW_DATE = globals().get('SCHEMA_REVIEW_DATE', None)
    EVENING_SAME_DAY_CUTOFF_HOUR = globals().get('EVENING_SAME_DAY_CUTOFF_HOUR', 20)
    ALLOW_RECENT_KRX_PUBLICATION_LAG = globals().get('ALLOW_RECENT_KRX_PUBLICATION_LAG', True)
    KRX_PUBLICATION_LAG_MAX_CALENDAR_DAYS = globals().get('KRX_PUBLICATION_LAG_MAX_CALENDAR_DAYS', 7)
    COLLECTION_DAYS = globals().get("KR_COLLECTION_DAYS", globals().get("COLLECTION_DAYS", 1))
    STRICT_ALL_SYMBOLS = globals().get('STRICT_ALL_SYMBOLS', False)
    REFRESH_CACHE = globals().get('REFRESH_CACHE', True)
    COLLECT_SEIBRO_ETF_FEE = globals().get('COLLECT_SEIBRO_ETF_FEE', False)
    ETF_ISIN_OVERRIDES = globals().get('ETF_ISIN_OVERRIDES', {})

    def resolve_collection_settings(universe, etf_universe, days, reference_date):
        from datetime import datetime, timedelta
        from zoneinfo import ZoneInfo
        universe = str(universe).strip().upper()
        etf_universe = str(etf_universe).strip().upper()
        if universe not in {"ALL", "STOCK_ONLY", "ETF_ONLY"}:
            raise ValueError("UNIVERSE_MODE: ALL / STOCK_ONLY / ETF_ONLY 중 선택하세요.")
        if etf_universe == "AUTO":
            etf_universe = "CURATED_150"
        if etf_universe not in {"CURATED_150", "HISTORICAL_422", "KRX_CURRENT"}:
            raise ValueError("ETF_UNIVERSE_MODE 설정을 확인하세요.")
        if days is not None and (isinstance(days, bool) or not isinstance(days, int) or days < 1):
            raise ValueError("COLLECTION_DAYS는 None 또는 1 이상의 정수여야 합니다.")
        now_kst = datetime.now(ZoneInfo("Asia/Seoul"))
        today = now_kst.date()
        if reference_date is None:
            reference_date = (today + timedelta(days=1)).isoformat() if INTEGRATED_SLOT == "EVENING" else today.isoformat()
        try:
            parsed = datetime.strptime(str(reference_date), "%Y-%m-%d").date()
        except ValueError as exc:
            raise ValueError("SCHEMA_REVIEW_DATE는 None 또는 YYYY-MM-DD 날짜입니다.") from exc
        if parsed > today + timedelta(days=1):
            raise ValueError("SCHEMA_REVIEW_DATE는 오늘 또는 내일까지 입력할 수 있습니다.")
        return MODE, universe, etf_universe, "SCREENING", parsed.isoformat()

    OFFICIAL_AUTO_DATE = SCHEMA_REVIEW_DATE is None
    MODE, UNIVERSE_MODE, ETF_UNIVERSE_MODE, COLLECTION_PROFILE, SCHEMA_REVIEW_DATE = resolve_collection_settings(
        UNIVERSE_MODE, ETF_UNIVERSE_MODE, COLLECTION_DAYS, SCHEMA_REVIEW_DATE)
    print(f"{MODE} / {UNIVERSE_MODE} / {COLLECTION_PROFILE} / ETF={ETF_UNIVERSE_MODE}")
    _AUTO_SAME_DAY_PREVIEW = bool(OFFICIAL_AUTO_DATE and INTEGRATED_SLOT == "EVENING")
    print(
        f"기준일 {SCHEMA_REVIEW_DATE} 미포함 / 거래일 수 {COLLECTION_DAYS or '모드 기본값'}"
        + (" / 저녁 당일장 포함 모드" if _AUTO_SAME_DAY_PREVIEW else "")
    )
    SHOW_DETAILED_QA = globals().get('SHOW_DETAILED_QA', False)
    COLLECT_TOSS_SHORT = globals().get('COLLECT_TOSS_SHORT', True)
    COLLECT_TOSS_LENDING = globals().get('COLLECT_TOSS_LENDING', True)
else:
    print('SKIP: RUN_KR_MARKET')
