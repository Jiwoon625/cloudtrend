import type { MarketDataset } from "./engine/dataset";
import type { UnderlyingIndexArtifact } from "./underlyingIndexSupplement";
import { UNDERLYING_INDEX_RELEASE } from "./underlyingIndexSupplementRelease";

export const OPERATIONAL_INDEX_VERSION = "etf-ma60-approved-base-20261019-v1";
export const OPERATIONAL_INDEX_START = "2026-10-19";
export interface OperationalIndexPoint {
  date: string;
  close: number | null;
  ma60: number | null;
}
export interface OperationalIndexRow {
  indexName: string | null;
  issues: string[];
  observations: OperationalIndexPoint[];
  status: "ready" | "incomplete" | "quarantined";
}
export interface OperationalIndexProvider {
  version: string;
  artifactSha256: string;
  asOfDate: string;
  availableFrom: string;
  rows: Record<string, OperationalIndexRow>;
}
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-8, Math.abs(a) * 1e-10);
/** Immutable approved historical base plus validated dated KRX append-only observations.
 * No dataset mutation, no M0 score input substitution, no implicit date shift or NAV fallback.
 * Exact old-value exceptions are bounded to the approved symbol/date/value triples.
 */
export function buildOperationalIndexProvider(
  ds: MarketDataset,
  artifact: UnderlyingIndexArtifact,
  now: string,
  options: { dryRunAtCutoff?: boolean } = {},
): OperationalIndexProvider | undefined {
  if (ds.asOfDate < (options.dryRunAtCutoff ? artifact.cutoffDate : OPERATIONAL_INDEX_START))
    return undefined;
  if (!Number.isFinite(Date.parse(now)) || Date.parse(now) < Date.parse(artifact.availableFrom))
    throw new Error("운영 MA60 빈티지 적용 가능 시각 이전입니다.");
  if (artifact.cutoffDate !== UNDERLYING_INDEX_RELEASE.cutoffDate)
    throw new Error("승인된 MA60 과거 기준일이 다릅니다.");
  const calendar = [...new Set([...artifact.calendar, ...ds.tradeDates])]
    .filter((d) => d <= ds.asOfDate)
    .sort();
  const approved = new Map(
    artifact.approvedPreference?.entries.map((e) => [`${e.symbol}:${e.date}`, e]) ?? [],
  );
  const candidates = new Map(artifact.symbols.map((s) => [s.symbol, s]));
  const rows: OperationalIndexProvider["rows"] = {};
  for (const inst of ds.instruments.filter((i) => i.instrumentType === "ETF")) {
    const candidate = candidates.get(inst.symbol);
    const issues: string[] = [];
    const names = new Set(candidate?.observations.map((o) => o[2]).filter(Boolean));
    const indexName = names.size === 1 ? [...names][0]! : null;
    if (!candidate || candidate.name !== inst.name || !indexName)
      issues.push("승인 기초지수 종목·이름 대응 확인 필요");
    const historical = new Map(candidate?.observations.map((o) => [o[0], o]) ?? []);
    const active = new Map(
      (ds.observedBars?.[inst.symbol] ?? ds.bars[inst.symbol] ?? [])
        .filter((b) => b.tradeDate <= ds.asOfDate)
        .map((b) => [b.tradeDate, b]),
    );
    let overlaps = 0;
    for (const [date, bar] of active) {
      const value = bar.etfUnderlyingIndexClose;
      if (!positive(value) || date < (artifact.calendar[0] ?? "")) continue;
      if (bar.etfUnderlyingIndexSource !== "KRX_ETF" || bar.etfUnderlyingIndexName !== indexName)
        issues.push(`${date}: 기초지수 출처·정체성 변경`);
      const old = historical.get(date);
      if (old && positive(old[1])) {
        overlaps++;
        if (!same(value, old[1])) {
          const approval = approved.get(`${inst.symbol}:${date}`);
          if (
            !approval ||
            !same(value, approval.expectedActiveValue) ||
            old[1] !== approval.selectedValue ||
            old[2] !== approval.indexName
          )
            issues.push(`${date}: 승인되지 않은 과거 지수값 충돌`);
        }
      }
    }
    if (!overlaps) issues.push("활성 입력과 승인 기초지수의 중복 검증 불가");
    const values = calendar.map((date) => {
      const old = historical.get(date);
      // Pinned historical vintage stays immutable. New daily values require explicit KRX identity.
      if (old) return positive(old[1]) ? old[1] : null;
      const bar = active.get(date);
      return bar?.etfUnderlyingIndexSource === "KRX_ETF" &&
        bar.etfUnderlyingIndexName === indexName &&
        positive(bar.etfUnderlyingIndexClose)
        ? bar.etfUnderlyingIndexClose
        : null;
    });
    const observations = calendar.map((date, i) => {
      const window = values.slice(i - 59, i + 1);
      const ma60 =
        i >= 59 && window.length === 60 && window.every(positive)
          ? window.reduce<number>((s, v) => s + v!, 0) / 60
          : null;
      return { date, close: issues.length ? null : values[i]!, ma60: issues.length ? null : ma60 };
    });
    rows[inst.symbol] = {
      indexName,
      issues: [...new Set(issues)],
      observations,
      status: issues.length
        ? "quarantined"
        : observations.at(-1)?.ma60 == null
          ? "incomplete"
          : "ready",
    };
  }
  return {
    version: OPERATIONAL_INDEX_VERSION,
    artifactSha256: UNDERLYING_INDEX_RELEASE.sha256,
    asOfDate: ds.asOfDate,
    availableFrom: artifact.availableFrom,
    rows,
  };
}
export function operationalIndexPoint(
  provider: OperationalIndexProvider | undefined,
  symbol: string,
  date: string,
) {
  const row = provider?.rows[symbol];
  if (!row || row.status === "quarantined") return undefined;
  const matches = row.observations.filter((p) => p.date === date);
  return matches.length === 1 ? matches[0] : undefined;
}
