if RUN_US_MARKET:
    # ===== 1. 사용자 설정 =====
    # v2.0.4 Lite r1: 실행 중 실패/부분 재실행 뒤 오래된 성공값의 게시를 차단합니다.
    from uuid import uuid4 as _us_uuid4
    _US_RUN_ID = _us_uuid4().hex
    _US_STAGE_ORDER = ('auth', 'seed', 'master', 'collection', 'features',
                       'diagnostics', 'snapshot', 'upload', 'archive', 'dispatch')
    _US_STAGE_RUN = {}
    _US_SNAPSHOT_READY = False
    _US_UPLOAD_VERIFIED = False
    _US_DISPATCH_STATUS = 'NOT_REQUESTED'
    _US_ARCHIVE_STATUS = None

    def _us_begin_stage(stage):
        global _US_SNAPSHOT_READY, _US_UPLOAD_VERIFIED, _US_DISPATCH_STATUS
        for name in _US_STAGE_ORDER[_US_STAGE_ORDER.index(stage):]:
            _US_STAGE_RUN.pop(name, None)
        if _US_STAGE_ORDER.index(stage) <= _US_STAGE_ORDER.index('snapshot'):
            _US_SNAPSHOT_READY = False
        if _US_STAGE_ORDER.index(stage) <= _US_STAGE_ORDER.index('upload'):
            _US_UPLOAD_VERIFIED = False
        _US_DISPATCH_STATUS = 'NOT_REQUESTED'

    def _us_require_stage(stage):
        if not _US_RUN_ID or _US_STAGE_RUN.get(stage) != _US_RUN_ID:
            raise RuntimeError(f'US {stage} 단계가 이번 실행에서 완료되지 않았습니다. 실패한 단계부터 순서대로 다시 실행하세요.')

    def _us_finish_stage(stage):
        _US_STAGE_RUN[stage] = _US_RUN_ID

    from pathlib import Path

    BASE_DIR = Path(globals()["US_BASE_DIR"])
    CACHE_PATH = BASE_DIR / 'us_toss_daily.parquet'
    MASTER_PATH = BASE_DIR / 'us_toss_master.parquet'
    OUTPUT_DIR = BASE_DIR / 'outputs'
    DATED_ARCHIVE_DIR = BASE_DIR / 'dated_atomic_archive_v1'

    # 전략 계산을 위해 최소 252일 + warm-up이 필요합니다.
    # V2: 최초/예외 종목만 400봉 full refresh, 정상 일일 운용은 최근 15봉만 조회합니다.
    INITIAL_BARS = 400
    INCREMENTAL_BARS = 15
    CACHE_KEEP_BARS = 400
    MAX_WORKERS = 8
    CHART_RPS = 12.0  # 공식 한도보다 보수적으로 시작. 실제 응답 rate-limit 헤더를 우선 확인하세요.

    # adjusted 데이터 소급변경 감지 기준. 가격/거래량은 API 숫자값 기준으로 사실상 동일해야 합니다.
    ADJUST_COMPARE_RTOL = 1e-10
    ADJUST_COMPARE_ATOL = 1e-10

    COLLECTOR_VERSION = 'integrated-2.0.4-lite-r4/us-incremental-2.0.4-r2'
    CHECKPOINT_VERSION = 3

    # 개별 종목의 provider candle gap은 가짜 봉을 만들지 않고 해당 세션에서만 quarantine합니다.
    # 공백 기간과 관계없이 최신 가격 미확인으로 기록하며, 소수 제한으로 대규모 장애를 숨기지 않습니다.
    MAX_PROVIDER_GAP_SYMBOLS = 10
    PROVIDER_GAP_POLICY_VERSION = 'latest-price-unconfirmed-quarantine-v2'

    # Provider ACTIVE flags can lag completed exchange corporate actions.
    # Only externally verified, effective-dated events may exempt a missing confirmed-session bar.
    VERIFIED_LIFECYCLE_EVENTS = [{
        'symbol':'TBPH', 'effective_date':'2026-09-24', 'status':'SUSPENDED',
        'source_url':'https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2026-668',
        'reason':'Merger closed 2026-09-23; Nasdaq suspension effective 2026-09-24',
    }]

    # 2026-10-08 확인: 소수 stale 종목을 임의 면제하지 않고 공식 공시로 확인한 lifecycle만 적용.
    VERIFIED_LIFECYCLE_EVENTS.extend([{'symbol': 'AMZE', 'effective_date': '2026-09-29', 'status': 'SUSPENDED', 'identity_name_contains': 'AMAZE', 'event_type': 'exchange_suspension_otc', 'source_url': 'https://ir.amaze.co/sec-filings/all-sec-filings/content/0001493152-26-045394/form8-k.htm', 'reason': 'NYSE American suspended trading on 2026-09-29; OTC quotation is outside the exchange screening universe.'}, {'symbol': 'GETY', 'effective_date': '2026-09-29', 'status': 'SUSPENDED', 'identity_name_contains': 'GETTY IMAGES', 'event_type': 'exchange_suspension_otc', 'source_url': 'https://www.sec.gov/Archives/edgar/data/1898496/000121390026105790/ea0307245-8k_getty.htm', 'reason': 'NYSE suspended trading on 2026-09-29; OTC trading began 2026-09-30 and is outside the exchange screening universe.'}, {'symbol': 'GBTG', 'effective_date': '2026-09-29', 'status': 'SUSPENDED', 'identity_name_contains': 'GLOBAL BUSINESS TRAVEL', 'event_type': 'acquisition_completed', 'source_url': 'https://www.sec.gov/Archives/edgar/data/1820872/000114036126037931/ef20082602_8k.htm', 'reason': 'Take-private merger completed 2026-09-29; NYSE trading suspended before that session opened.'}])

    # 수집 후보는 reference/us_collection_universe_v1.csv에서 관리합니다.
    # strict PIT를 만들지 않으며, 앞으로의 일별 스크리닝 대상만 고정/갱신합니다.
    VERIFIED_LIFECYCLE_EVENTS.append({'symbol':'WBD','effective_date':'2026-10-06','status':'SUSPENDED',
        'source_url':'https://www.nasdaqtrader.com/TraderNews.aspx?id=ECA2026-710',
        'reason':'Nasdaq suspension effective 2026-10-06; last trading day 2026-10-05.'})

    FORCE_FULL_REFRESH = bool(globals().get("FORCE_FULL_REFRESH", False))
    DISPATCH_GITHUB_AFTER_UPLOAD = bool(globals().get("DISPATCH_GITHUB_AFTER_UPLOAD", True))
    GITHUB_REPO = 'Jiwoon625/cloudtrend'
    GITHUB_WORKFLOW = 'us-prospective-screening.yml'

    BASE_DIR, CACHE_PATH

    BASE_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if (DATED_ARCHIVE_DIR/'active_replay.json').exists():
        _pending_api = _CT_US_ARCHIVE['UsArchiveApi'](SUPABASE_URL,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_USER_ID,GITHUB_TOKEN,requests)
        _CT_US_ARCHIVE['check_pending_us_publication'](root=DATED_ARCHIVE_DIR,api=_pending_api)

else:
    print('SKIP: RUN_US_MARKET')
