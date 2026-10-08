#@title 1. 통합 실행 설정 — 보통 이 셀만 확인하고 "런타임 > 모두 실행"
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

# 요약에 이전 실행의 성공 상태가 남지 않도록 초기화합니다.
publish_result = None
_US_RUN_ID = None
_US_STAGE_RUN = {}
_US_SNAPSHOT_READY = False
_US_UPLOAD_VERIFIED = False
_US_DISPATCH_STATUS = 'NOT_REQUESTED'
_KR_SCREENING_REQUEST = None
_US_ARCHIVE_STATUS = None

# AUTO 권장:
# - 08:10 KST 전후 실행 → 한국 + 미국
# - 20:10 KST 전후 실행 → 한국만
RUN_PLAN = globals().get("RUN_PLAN", "AUTO")

# 미국은 20시 재수집 기본 OFF.
# 정규장 종료 후 확정 일봉이 이미 오전 실행에 반영되므로,
# 프리마켓 진단을 특별히 보존하려는 경우에만 True로 켭니다.
RUN_US_EVENING = bool(globals().get("RUN_US_EVENING", False))

_now_kst = datetime.now(ZoneInfo("Asia/Seoul"))

def resolve_integrated_run_plan(plan: str, now_kst: datetime):
    plan = str(plan).strip().upper()
    auto_slot = "MORNING" if now_kst.hour < 14 else "EVENING"

    if plan == "AUTO":
        slot = auto_slot
        run_kr = True
        run_us = (slot == "MORNING") or bool(RUN_US_EVENING)
    elif plan == "MORNING_BOTH":
        slot, run_kr, run_us = "MORNING", True, True
    elif plan == "EVENING_KR":
        slot, run_kr, run_us = "EVENING", True, bool(RUN_US_EVENING)
    elif plan == "KR_ONLY":
        slot, run_kr, run_us = auto_slot, True, False
    elif plan == "US_ONLY":
        slot, run_kr, run_us = "MORNING", False, True
    elif plan == "BOTH":
        slot, run_kr, run_us = auto_slot, True, True
    else:
        raise ValueError("RUN_PLAN 설정을 확인하세요.")
    return slot, run_kr, run_us

INTEGRATED_SLOT, RUN_KR_MARKET, RUN_US_MARKET = resolve_integrated_run_plan(RUN_PLAN, _now_kst)

print("=" * 72)
print("CloudTrend 통합 스크리닝 수집기")
print("현재 KST:", _now_kst.isoformat(timespec="seconds"))
print("실행 슬롯:", INTEGRATED_SLOT)
print("한국시장:", "RUN" if RUN_KR_MARKET else "SKIP")
print("미국시장:", "RUN" if RUN_US_MARKET else "SKIP")
if INTEGRATED_SLOT == "EVENING" and not RUN_US_MARKET:
    print("미국시장 저녁 재수집: OFF — 오전 확정 정규장 데이터만 운영에 사용")
print("=" * 72)

_US_DAILY_ARCHIVE_SOURCE = None
