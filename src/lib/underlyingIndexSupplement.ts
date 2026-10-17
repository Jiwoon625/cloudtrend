import { z } from "zod";
import type { MarketDataset } from "./engine/dataset";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "유효한 관측일이 아닙니다.");
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const observation = z.tuple([
  date,
  z.number().finite().positive().nullable(),
  z.string(),
  z.string(),
]);
export const underlyingIndexArtifactSchema = z
  .object({
    version: z.literal("underlying-index-diagnostic-v1"),
    usage: z.literal("diagnostic-only"),
    availableFrom: z.string().datetime({ offset: true }),
    cutoffDate: date,
    calendarKind: z.literal("observed-not-exchange-certified"),
    calendar: z.array(date).min(60).max(120),
    independentIndexIdVerified: z.literal(false),
    currencyAndMethodologyVerified: z.literal(false),
    sources: z
      .array(
        z
          .object({
            id: z.string().min(1),
            sha256: hash,
            uri: z.string().url(),
            capturedAt: z.string().datetime({ offset: true }).nullable(),
            provider: z.literal("KRX"),
            field: z.literal("OBJ_STKPRC_IDX"),
            minDate: date,
            maxDate: date,
          })
          .strict(),
      )
      .min(1)
      .max(100),
    symbols: z
      .array(
        z
          .object({
            symbol: z.string().regex(/^[0-9A-Z]{6}$/),
            name: z.string().min(1),
            historicalIndexNames: z.array(z.string().min(1)),
            observations: z.array(observation).max(120),
          })
          .strict(),
      )
      .min(1)
      .max(3000),
  })
  .strict();
export type UnderlyingIndexArtifact = z.infer<typeof underlyingIndexArtifactSchema>;
const positive = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;

export function parseUnderlyingIndexArtifact(value: unknown, now: string): UnderlyingIndexArtifact {
  if (!Number.isFinite(new Date(now).getTime()))
    throw new Error("현재 검증 시각이 유효하지 않습니다.");
  const artifact = underlyingIndexArtifactSchema.parse(value);
  if (new Date(artifact.availableFrom).getTime() > new Date(now).getTime())
    throw new Error("아직 적용 가능 시각이 되지 않은 지수 빈티지입니다.");
  if (artifact.cutoffDate > now.slice(0, 10)) throw new Error("미래 관측일은 허용하지 않습니다.");
  const dates = new Set(artifact.calendar);
  if (
    dates.size !== artifact.calendar.length ||
    [...dates].sort().join() !== artifact.calendar.join() ||
    artifact.calendar.at(-1) !== artifact.cutoffDate
  )
    throw new Error("관측 달력이 중복되거나 정렬되지 않았습니다.");
  const sources = new Map(artifact.sources.map((s) => [s.id, s]));
  if (sources.size !== artifact.sources.length) throw new Error("출처 식별자가 중복되었습니다.");
  for (const source of sources.values()) {
    if (source.minDate > source.maxDate || source.maxDate > artifact.cutoffDate)
      throw new Error("출처의 날짜 범위가 일치하지 않습니다.");
    if (
      source.capturedAt &&
      new Date(source.capturedAt).getTime() > new Date(artifact.availableFrom).getTime()
    )
      throw new Error("출처 생성 전 빈티지는 허용하지 않습니다.");
  }
  const symbols = new Set<string>();
  for (const series of artifact.symbols) {
    if (symbols.has(series.symbol)) throw new Error("종목 식별자가 중복되었습니다.");
    symbols.add(series.symbol);
    let previous = "";
    for (const [day, , , sourceId] of series.observations) {
      const source = sources.get(sourceId);
      if (
        !dates.has(day) ||
        day <= previous ||
        !source ||
        day < source.minDate ||
        day > source.maxDate
      )
        throw new Error("지수 관측일·중복 키·출처 범위가 일치하지 않습니다.");
      previous = day;
    }
  }
  return artifact;
}

export interface IndexDiagnosticRow {
  symbol: string;
  name: string;
  indexName: string | null;
  status: "compared" | "incomplete" | "quarantined" | "not-in-live-universe";
  issues: string[];
  activeMa60: number | null;
  diagnosticMa60: number | null;
  currentIndex: number | null;
  activeValidCount: number;
  combinedValidCount: number;
  supplementedObservations: number;
  priceRowsAbsent: number;
  overlapCompared: number;
  conflicts: string[];
  missingDates: string[];
  belowDiagnosticMa60: boolean | null;
  /** Always false: diagnosis is not a trading signal or a strategy eligibility decision. */
  strategyApplied: false;
}
export interface IndexDiagnosticReport {
  version: "underlying-index-diagnostic-v1";
  usage: "diagnostic-only";
  asOfDate: string;
  availableFrom: string;
  sourceCutoffDate: string;
  calendarKind: "observed-not-exchange-certified";
  window: string[];
  rows: IndexDiagnosticRow[];
  summary: {
    symbols: number;
    ma60Available: number;
    newlyAvailable: number;
    quarantined: number;
    incomplete: number;
    supplementedObservations: number;
  };
  limitations: string[];
}

/** Pure sidecar join. Never edits the dataset, synthesizes price rows or runs strategy engines. */
export function calculateIndexDiagnostics(
  ds: MarketDataset,
  artifact: UnderlyingIndexArtifact,
): IndexDiagnosticReport {
  if (ds.asOfDate < artifact.cutoffDate)
    throw new Error("과거 기준일에 새 지수 빈티지를 적용할 수 없습니다.");
  const window = [...new Set([...artifact.calendar, ...ds.tradeDates])]
    .filter((d) => d <= ds.asOfDate)
    .sort()
    .slice(-60);
  const bySymbol = new Map(artifact.symbols.map((s) => [s.symbol, s]));
  const live = ds.instruments.filter((i) => i.instrumentType === "ETF");
  const mean60 = (values: Array<number | null>) =>
    window.length === 60 && values.every(positive)
      ? values.reduce<number>((sum, n) => sum + n!, 0) / 60
      : null;
  const rows: IndexDiagnosticRow[] = live.map((inst) => {
    const candidate = bySymbol.get(inst.symbol);
    const bars = ds.observedBars?.[inst.symbol] ?? ds.bars[inst.symbol] ?? [];
    const active = new Map(
      bars.filter((b) => b.tradeDate <= ds.asOfDate).map((b) => [b.tradeDate, b]),
    );
    const indexByDate = new Map(candidate?.observations.map((o) => [o[0], o]) ?? []);
    const names = new Set(candidate?.historicalIndexNames ?? []);
    const issues: string[] = [];
    if (!candidate) issues.push("기존 원천에 해당 종목 없음");
    if (candidate && candidate.name !== inst.name) issues.push("현재 종목명과 원천 종목명 불일치");
    if (names.size !== 1) issues.push("기초지수명 누락 또는 과거 지수명 변경: 별도 검증 필요");
    const indexName = names.size === 1 ? [...names][0]! : null;
    if (candidate?.observations.some((o) => o[2] !== indexName))
      issues.push("관측별 기초지수명 불일치");
    const activeIdentity = bars.filter(
      (b) => indexByDate.has(b.tradeDate) && positive(b.etfUnderlyingIndexClose),
    );
    if (
      !activeIdentity.some(
        (b) => b.etfUnderlyingIndexSource === "KRX_ETF" && b.etfUnderlyingIndexName === indexName,
      )
    )
      issues.push("활성 KRX 기초지수명·출처 검증 불가");
    if (
      bars.some(
        (b) =>
          window.includes(b.tradeDate) &&
          positive(b.etfUnderlyingIndexClose) &&
          (b.etfUnderlyingIndexSource !== "KRX_ETF" || b.etfUnderlyingIndexName !== indexName),
      )
    )
      issues.push("계산 구간의 활성 기초지수명·출처 누락 또는 변경");
    const conflicts: string[] = [];
    let overlapCompared = 0;
    for (const [day, value] of candidate?.observations ?? []) {
      const existing = active.get(day)?.etfUnderlyingIndexClose;
      if (positive(existing) && positive(value)) {
        overlapCompared++;
        if (Math.abs(existing - value) > Math.max(1e-8, Math.abs(existing) * 1e-10))
          conflicts.push(day);
      }
    }
    if (
      bars.some(
        (b) =>
          indexByDate.has(b.tradeDate) &&
          b.etfUnderlyingIndexName &&
          b.etfUnderlyingIndexName.trim() !== indexName,
      )
    )
      issues.push("활성 입력의 기초지수명 불일치");
    if (conflicts.length) issues.push("기존 유효 기초지수값 충돌: 기존값 유지, 보강 격리");
    if (!overlapCompared) issues.push("활성 입력과 일치하는 중복 관측을 검증할 수 없음");
    const quarantine = issues.length > 0;
    let supplementedObservations = 0;
    const current = window.map((d) => {
      const value = active.get(d)?.etfUnderlyingIndexClose;
      return positive(value) ? value : null;
    });
    const values = window.map((day, i) => {
      if (positive(current[i])) return current[i]!;
      const value = indexByDate.get(day)?.[1];
      if (!quarantine && positive(value)) {
        supplementedObservations++;
        return value;
      }
      return null;
    });
    const diagnosticMa60 = quarantine ? null : mean60(values);
    const activeMa60 = mean60(current);
    const currentIndex = values.at(-1) ?? null;
    const missingDates = window.filter((_, i) => !positive(values[i]));
    return {
      symbol: inst.symbol,
      name: inst.name,
      indexName,
      status: quarantine ? "quarantined" : diagnosticMa60 === null ? "incomplete" : "compared",
      issues,
      activeMa60,
      diagnosticMa60,
      currentIndex,
      activeValidCount: current.filter(positive).length,
      combinedValidCount: values.filter(positive).length,
      supplementedObservations,
      priceRowsAbsent: window.filter((d) => !active.has(d)).length,
      overlapCompared,
      conflicts,
      missingDates,
      belowDiagnosticMa60:
        positive(currentIndex) && positive(diagnosticMa60) ? currentIndex < diagnosticMa60 : null,
      strategyApplied: false,
    };
  });
  for (const candidate of artifact.symbols)
    if (!live.some((i) => i.symbol === candidate.symbol))
      rows.push({
        symbol: candidate.symbol,
        name: candidate.name,
        indexName: null,
        status: "not-in-live-universe",
        issues: ["현재 ETF 입력 대상에 없어 추가하지 않음"],
        activeMa60: null,
        diagnosticMa60: null,
        currentIndex: null,
        activeValidCount: 0,
        combinedValidCount: 0,
        supplementedObservations: 0,
        priceRowsAbsent: 0,
        overlapCompared: 0,
        conflicts: [],
        missingDates: [],
        belowDiagnosticMa60: null,
        strategyApplied: false,
      });
  return {
    version: "underlying-index-diagnostic-v1",
    usage: "diagnostic-only",
    asOfDate: ds.asOfDate,
    availableFrom: artifact.availableFrom,
    sourceCutoffDate: artifact.cutoffDate,
    calendarKind: artifact.calendarKind,
    window,
    rows,
    summary: {
      symbols: live.length,
      ma60Available: rows.filter((r) => r.diagnosticMa60 !== null).length,
      newlyAvailable: rows.filter((r) => r.activeMa60 === null && r.diagnosticMa60 !== null).length,
      quarantined: rows.filter((r) => r.status === "quarantined").length,
      incomplete: rows.filter((r) => r.status === "incomplete").length,
      supplementedObservations: rows.reduce((sum, r) => sum + r.supplementedObservations, 0),
    },
    limitations: [
      "독립 기초지수 ID·통화·산식은 인증되지 않았습니다. 진단 참고값이며 전략 적격·매매신호가 아닙니다.",
      "관측일 기준 60개입니다. 공식 거래소 달력의 연속 세션 인증이 아닙니다.",
      "가격·거래량·NAV·원천·기존 스크리닝·Shadow·실제 원장은 수정하지 않습니다.",
      "새 빈티지는 과거 거래 의사결정에 사용할 수 없습니다. 모델 연결과 미래 신호는 별도 검토 대상입니다.",
    ],
  };
}
