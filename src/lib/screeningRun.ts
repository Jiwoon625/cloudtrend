// "스크리닝 시작"을 눌렀는지 여부. 탭을 이동해도 대시보드 결과가 유지되도록 보관한다.
const KEY = "trendscore.screeningStarted.v1";

export function isScreeningStarted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setScreeningStarted(started: boolean) {
  if (typeof window === "undefined") return;
  try {
    if (started) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // 저장 실패는 무시
  }
}
