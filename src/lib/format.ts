// 한국 시장 관행 숫자 표기 유틸

export function formatWon(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "데이터 없음";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000_000)
    return `${(value / 1_000_000_000_000).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}조 원`;
  if (abs >= 100_000_000)
    return `${(value / 100_000_000).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}억 원`;
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

export function formatPrice(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

export function formatNumber(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("ko-KR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "데이터 없음";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "미집계";
  return value.toLocaleString("ko-KR");
}

export function formatKstDateTime(iso: string | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}
