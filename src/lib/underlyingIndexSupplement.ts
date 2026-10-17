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
const approvedPreferenceSchema = z
  .object({
    version: z.literal("user-selected-supplement-v1"),
    approvedAt: z.string().datetime({ offset: true }),
    basis: z.literal("user-selected-vintage-not-official-finality"),
    originalArtifactSha256: hash,
    expectedSourceSetDigest: hash,
    expectedDatasetSha256: hash,
    expectedAsOfDate: date,
    symbols: z
      .array(z.string().regex(/^[0-9A-Z]{6}$/))
      .min(1)
      .max(3000),
    entries: z
      .array(
        z
          .object({
            symbol: z.string().regex(/^[0-9A-Z]{6}$/),
            date,
            expectedActiveValue: z.number().finite().positive(),
            selectedValue: z.number().finite().positive(),
            indexName: z.string().min(1),
            activeProvider: z.literal("KRX_ETF"),
            supplementSourceId: z.string().min(1),
            supplementSourceSha256: hash,
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict();

export const underlyingIndexArtifactSchema = z
  .object({
    approvedPreference: approvedPreferenceSchema.optional(),
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
  const preference = artifact.approvedPreference;
  if (preference) {
    if (
      new Date(preference.approvedAt).getTime() > new Date(artifact.availableFrom).getTime() ||
      preference.expectedAsOfDate !== artifact.cutoffDate
    )
      throw new Error("승인 시각·기준일이 전용 빈티지와 다릅니다.");
    const keys = new Set<string>();
    const approvedSymbols = new Set(preference.symbols);
    const entrySymbols = new Set(preference.entries.map((e) => e.symbol));
    if (
      approvedSymbols.size !== preference.symbols.length ||
      approvedSymbols.size !== entrySymbols.size ||
      [...entrySymbols].some((symbol) => !approvedSymbols.has(symbol))
    )
      throw new Error("승인 종목 목록이 중복되거나 대응값과 다릅니다.");
    for (const entry of preference.entries) {
      const key = `${entry.symbol}:${entry.date}`;
      const candidate = artifact.symbols
        .find((s) => s.symbol === entry.symbol)
        ?.observations.find((o) => o[0] === entry.date);
      if (
        keys.has(key) ||
        !candidate ||
        candidate[1] !== entry.selectedValue ||
        candidate[2] !== entry.indexName ||
        candidate[3] !== entry.supplementSourceId ||
        sources.get(candidate[3])?.sha256 !== entry.supplementSourceSha256 ||
        entry.expectedActiveValue === entry.selectedValue
      )
        throw new Error("승인 대응값·출처·날짜가 검증자료와 다릅니다.");
      keys.add(key);
    }
  }
  return artifact;
}

/**
 * Compare parsed, hash-verified vintages. Approval may select exact observation values,
 * but cannot silently change provenance, identities, calendar, coverage or other values.
 */
export function validateUnderlyingIndexPreferenceDelta(
  artifact: UnderlyingIndexArtifact,
  original: UnderlyingIndexArtifact,
): void {
  const preference = artifact.approvedPreference;
  if (!preference || original.approvedPreference)
    throw new Error("승인 빈티지는 승인 전 원본 자료와 비교해야 합니다.");
  if (new Date(artifact.availableFrom) < new Date(original.availableFrom))
    throw new Error("승인 빈티지의 적용 시각을 원본보다 앞당길 수 없습니다.");
  const expected = structuredClone(original);
  expected.availableFrom = artifact.availableFrom;
  expected.approvedPreference = preference;
  const seriesBySymbol = new Map(expected.symbols.map((series) => [series.symbol, series]));
  for (const entry of preference.entries) {
    const observation = seriesBySymbol
      .get(entry.symbol)
      ?.observations.find((row) => row[0] === entry.date);
    if (!observation) throw new Error("승인 대응값이 원본 지수 관측에 없습니다.");
    observation[1] = entry.selectedValue;
  }
  // Schema parsing fixes object-key order while retaining array order and all strict fields.
  if (
    JSON.stringify(underlyingIndexArtifactSchema.parse(artifact)) !==
    JSON.stringify(underlyingIndexArtifactSchema.parse(expected))
  )
    throw new Error("승인된 대응값·승인 정보 외에 원본 지수 자료가 변경되었습니다.");
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
  approvedPreferenceDates: string[];
  userSelectedVintage: boolean;
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
    approvedPreferenceSymbols: number;
    approvedPreferenceObservations: number;
  };
  limitations: string[];
}

/** Pure sidecar join. Never edits the dataset, synthesizes price rows or runs strategy engines. */
export function calculateIndexDiagnostics(
  ds: MarketDataset,
  artifact: UnderlyingIndexArtifact,
  context?: { sourceSetDigest: string; datasetSha256: string; now: string },
): IndexDiagnosticReport {
  if (ds.asOfDate < artifact.cutoffDate)
    throw new Error("과거 기준일에 새 지수 빈티지를 적용할 수 없습니다.");
  const preference = artifact.approvedPreference;
  const preferred = new Map<string, number>();
  if (preference) {
    if (
      !context ||
      context.sourceSetDigest !== preference.expectedSourceSetDigest ||
      context.datasetSha256 !== preference.expectedDatasetSha256 ||
      ds.asOfDate !== preference.expectedAsOfDate ||
      !Number.isFinite(new Date(context.now).getTime()) ||
      new Date(context.now) < new Date(artifact.availableFrom)
    )
      throw new Error("활성 원천·기준일·해시가 승인 범위와 달라 보강값 우선 적용을 중단했습니다.");
    for (const entry of preference.entries) {
      const bars = ds.observedBars?.[entry.symbol] ?? ds.bars[entry.symbol] ?? [];
      const active = bars.find((b) => b.tradeDate === entry.date);
      if (
        active?.etfUnderlyingIndexClose !== entry.expectedActiveValue ||
        active.etfUnderlyingIndexName !== entry.indexName ||
        active.etfUnderlyingIndexSource !== entry.activeProvider
      )
        throw new Error("활성 지수 대응값·이름·출처가 승인 이후 달라졌습니다.");
      preferred.set(`${entry.symbol}:${entry.date}`, entry.selectedValue);
    }
  }
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
    // Historical names describe the entire archive, not the retained observation interval.
    // Validate every retained observation and overlapping active row instead of joining old TR/PR regimes.
    const names = new Set(candidate?.observations.map((o) => o[2]).filter(Boolean) ?? []);
    const issues: string[] = [];
    if (!candidate) issues.push("기존 원천에 해당 종목 없음");
    if (candidate && candidate.name !== inst.name) issues.push("현재 종목명과 원천 종목명 불일치");
    if (names.size !== 1) issues.push("현행 관측 구간 기초지수명 누락 또는 변경: 별도 검증 필요");
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
      activeIdentity.some(
        (b) => b.etfUnderlyingIndexSource !== "KRX_ETF" || b.etfUnderlyingIndexName !== indexName,
      )
    )
      issues.push("보강 중복 관측의 활성 기초지수명·출처 누락 또는 변경");
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
    if (conflicts.some((d) => !preferred.has(`${inst.symbol}:${d}`)))
      issues.push("기존 유효 기초지수값 충돌: 기존값 유지, 보강 격리");
    if (!overlapCompared) issues.push("활성 입력과 일치하는 중복 관측을 검증할 수 없음");
    const quarantine = issues.length > 0;
    let supplementedObservations = 0;
    const approvedPreferenceDates: string[] = [];
    const current = window.map((d) => {
      const value = active.get(d)?.etfUnderlyingIndexClose;
      return positive(value) ? value : null;
    });
    const values = window.map((day, i) => {
      const selected = preferred.get(`${inst.symbol}:${day}`);
      if (!quarantine && positive(selected)) {
        approvedPreferenceDates.push(day);
        return selected;
      }
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
      approvedPreferenceDates,
      userSelectedVintage: approvedPreferenceDates.length > 0 && !quarantine,
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
        approvedPreferenceDates: [],
        userSelectedVintage: false,
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
      approvedPreferenceSymbols: rows.filter((r) => r.userSelectedVintage).length,
      approvedPreferenceObservations: rows
        .filter((r) => r.userSelectedVintage)
        .reduce((n, r) => n + r.approvedPreferenceDates.length, 0),
    },
    limitations: [
      "사용자 선택 보강 빈티지는 승인된 충돌값만 전용 MA60 계산에 우선합니다. 기존 활성값·충돌 이력은 보존하며 공식 최종값·공표시각·하루 지연·PIT 인증이 아닙니다. 실제 매매신호에는 반영하지 않습니다.",
      "독립 기초지수 ID·통화·산식은 인증되지 않았습니다. 진단 참고값이며 전략 적격·매매신호가 아닙니다.",
      "관측일 기준 60개입니다. 공식 거래소 달력의 연속 세션 인증이 아닙니다.",
      "가격·거래량·NAV·원천·기존 스크리닝·Shadow·실제 원장은 수정하지 않습니다.",
      "새 빈티지는 과거 거래 의사결정에 사용할 수 없습니다. 모델 연결과 미래 신호는 별도 검토 대상입니다.",
    ],
  };
}
