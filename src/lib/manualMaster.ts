// Manual master: current aggregate values only; no execution ledger.
export const masterColumns = [
  ["symbol", "종목코드"],
  ["name", "종목명"],
  ["listing", "시장"],
  ["assetType", "종목구분"],
  ["currency", "통화"],
  ["quantity", "보유수량"],
  ["averageKrw", "보유주식 평단가"],
  ["amountKrw", "보유금액"],
  ["buyQuantity", "총매입수량"],
  ["buyAmount", "총매입금액"],
  ["sellQuantity", "총매도수량"],
  ["sellAmount", "총매도금액"],
  ["sellCost", "매도원가"],
  ["realized", "실현손익"],
  ["dividends", "배당/분배금 수익"],
  ["fees", "수수료/제세금"],
  ["start", "보유시작일"],
  ["lastSell", "최근매도일"],
] as const;
export type MasterKey = (typeof masterColumns)[number][0];
export type MasterRow = Record<MasterKey, string>;
export type MasterSnapshot = {
  revision: number;
  asOf: string;
  rows: MasterRow[];
  savedAt: string;
  reviewStatus: "pending" | "confirmed";
};
export const newMasterRow = (): MasterRow => ({
  symbol: "",
  name: "",
  listing: "KOSPI",
  assetType: "주식",
  currency: "KRW",
  quantity: "",
  averageKrw: "",
  amountKrw: "",
  buyQuantity: "",
  buyAmount: "",
  sellQuantity: "",
  sellAmount: "",
  sellCost: "",
  realized: "",
  dividends: "",
  fees: "",
  start: "",
  lastSell: "",
});
export const masterIdentity = (r: MasterRow) => (r.listing === "미국" ? "US:" : "KR:") + r.symbol;
export const strategyMarket = (r: MasterRow) =>
  r.listing === "미국" ? "US" : r.assetType === "ETF" ? "ETF" : r.listing;
const numericKeys = [
  "quantity",
  "averageKrw",
  "amountKrw",
  "buyQuantity",
  "buyAmount",
  "sellQuantity",
  "sellAmount",
  "sellCost",
  "realized",
  "dividends",
  "fees",
] as const;
export function validMasterDay(s: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(s) &&
    Number.isFinite(Date.parse(s + "T00:00:00Z")) &&
    new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s
  );
}
export function masterToday(now = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function parseMasterNumber(input: string, allowNegative = false): string {
  const s = input.trim();
  if (!s) return "";
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,12})?$/.test(s))
    throw new Error("숫자 형식을 확인하세요.");
  const n = s.replaceAll(",", "");
  if (
    !Number.isFinite(Number(n)) ||
    Math.abs(Number(n)) > 1e15 ||
    (!allowNegative && Number(n) < 0)
  )
    throw new Error("숫자 범위를 확인하세요.");
  return n;
}
export function validateMasterRows(
  input: unknown,
  asOf: string,
  today = masterToday(),
): MasterRow[] {
  if (!validMasterDay(asOf) || asOf > today) throw new Error("보유현황 기준일을 확인하세요.");
  if (!Array.isArray(input) || !input.length || input.length > 2000)
    throw new Error("종목마스터는 1~2,000행이어야 합니다. 빈 데이터로 교체할 수 없습니다.");
  const seen = new Set<string>();
  return input.map((raw, i) => {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("행 형식 오류");
      const row = newMasterRow();
      for (const [key] of masterColumns) {
        const v = (raw as Record<string, unknown>)[key];
        if (typeof v !== "string" || v.length > 240) throw new Error(key + " 입력값 오류");
        row[key] = v.trim();
      }
      if (
        !row.name ||
        !["KOSPI", "KOSDAQ", "미국"].includes(row.listing) ||
        !["주식", "ETF"].includes(row.assetType)
      )
        throw new Error("종목명·시장·종목구분 확인");
      if (
        row.listing === "미국"
          ? row.currency !== "USD" || !/^[A-Z0-9][A-Z0-9.-]{0,19}$/.test(row.symbol)
          : row.currency !== "KRW" || !/^[0-9A-Z]{6}$/.test(row.symbol)
      )
        throw new Error("종목코드·거래통화 확인 (국내 앞자리 0 보존)");
      const id = masterIdentity(row);
      if (seen.has(id)) throw new Error("중복 종목");
      seen.add(id);
      for (const key of numericKeys) row[key] = parseMasterNumber(row[key], key === "realized");
      if (row.quantity === "") throw new Error("보유수량은 필수입니다. 미보유는 0으로 입력하세요.");
      const held = Number(row.quantity) > 0;
      if (
        held &&
        (!row.averageKrw ||
          Number(row.averageKrw) <= 0 ||
          !row.amountKrw ||
          Number(row.amountKrw) <= 0 ||
          !row.start)
      )
        throw new Error("보유종목의 원화 평단가·보유금액·보유시작일 필요");
      if (
        !held &&
        ((row.amountKrw !== "" && Number(row.amountKrw) !== 0) ||
          (row.averageKrw !== "" && Number(row.averageKrw) !== 0))
      )
        throw new Error("미보유 종목의 보유금액·평단가는 0 또는 공란이어야 합니다.");
      for (const key of ["start", "lastSell"] as const)
        if (row[key] && (!validMasterDay(row[key]) || row[key] > asOf))
          throw new Error("보유/매도 날짜 확인");
      return row;
    } catch (e) {
      throw new Error(i + 1 + "행: " + (e instanceof Error ? e.message : String(e)));
    }
  });
}
export function applyMasterPaste(
  current: MasterRow[],
  text: string,
  firstRow: number,
  firstColumn: number,
): MasterRow[] {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n$/, "").split("\n");
  if (!text.trim() || lines.length > 2000 || firstRow < 0 || firstColumn < 0)
    throw new Error("붙여넣기 범위 오류");
  const cells = lines.map((line) => line.split("\t"));
  const header = cells[0]?.map((v) => v.trim().replace(/\s*\(원\)$/, "")) ?? [];
  const byTitle = new Map<string, MasterKey>(masterColumns.map(([k, t]) => [t, k]));
  const hasHeader = header.includes("종목코드") && header.includes("종목명");
  const keys: (MasterKey | null)[] = hasHeader
    ? header.map(
        (h) =>
          byTitle.get(h) ??
          (h === "사람" || h === "거래내역"
            ? null
            : (() => {
                throw new Error("알 수 없는 열: " + h);
              })()),
      )
    : masterColumns.slice(firstColumn).map(([k]) => k);
  if (hasHeader && new Set(keys.filter(Boolean)).size !== keys.filter(Boolean).length)
    throw new Error("중복 열");
  const data = hasHeader ? cells.slice(1) : cells;
  if (!data.length) throw new Error("붙여넣을 데이터가 없습니다.");
  const out = current.map((r) => ({ ...r }));
  if (firstRow + data.length > 2000) throw new Error("2,000행 초과");
  data.forEach((values, i) => {
    if (values.length > keys.length || (hasHeader && values.length !== keys.length))
      throw new Error("붙여넣기 열 개수 불일치");
    const at = firstRow + i;
    const row = { ...(out[at] ?? newMasterRow()) };
    values.forEach((value, j) => {
      const key = keys[j];
      if (key) row[key] = value.trim();
    });
    out[at] = row;
  });
  return out;
}
export function masterChanges(previous: MasterRow[], next: MasterRow[]) {
  const old = new Map(previous.map((r) => [masterIdentity(r), r]));
  const keys = new Set(next.map(masterIdentity));
  const removed = previous.filter((r) => !keys.has(masterIdentity(r)));
  const added = next.filter((r) => !old.has(masterIdentity(r)));
  const changed = next.filter((r) => {
    const p = old.get(masterIdentity(r));
    return p && masterColumns.some(([k]) => p[k] !== r[k]);
  });
  const closed = changed.filter(
    (r) => Number(r.quantity) === 0 && Number(old.get(masterIdentity(r))?.quantity) > 0,
  );
  return { removed, added, changed, closed };
}
export function masterPositionProjection(rows: MasterRow[]) {
  return {
    positions: rows
      .filter((r) => Number(r.quantity) > 0)
      .map((r) => ({
        market: strategyMarket(r),
        symbol: r.symbol,
        name: r.name,
        shares: Number(r.quantity),
        firstEntryDate: r.start,
        averageKrw: Number(r.averageKrw),
      })),
    recentSells: rows
      .filter((r) => r.lastSell)
      .map((r) => ({ market: strategyMarket(r), symbol: r.symbol, date: r.lastSell })),
  };
}
