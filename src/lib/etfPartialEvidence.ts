import { ETF_MAPPING, ETF_POLICY, isEtfStrategyAssetClass } from "./engine/etfStrategy";
import type { ScreeningRow } from "./engine/pipeline";

type EvidenceRow = Pick<ScreeningRow, "instrument" | "snapshot" | "etfStrategy">;
const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const positive = (value: unknown): value is number => finite(value) && value > 0;
const score = (value: unknown) => (finite(value) && value >= 0 && value <= 100 ? value : null);
const nonnegative = (value: unknown) => (finite(value) && value >= 0 ? value : null);
const dated = (value: unknown): value is string =>
  typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

/** Presentation only: never fills missing inputs or changes strategy/order eligibility. */
export function etfPartialEvidence(row: EvidenceRow, asOfDate: string) {
  const s = row.etfStrategy;
  const current =
    s?.version === ETF_POLICY.version &&
    dated(s.date) &&
    s.date === asOfDate &&
    row.snapshot.tradeDate === asOfDate &&
    ["ready", "incomplete", "krx_batch_pending"].includes(s.dataStatus);
  const krxPending = current && s?.dataStatus === "krx_batch_pending";
  const issues = s?.issues ?? [];
  const priceAvailable =
    current && positive(row.snapshot.close) && !issues.includes("기준일 ETF 가격 없음");
  const previousDate =
    current && dated(s?.previousDate) && s.previousDate < asOfDate ? s.previousDate : null;
  const technical =
    priceAvailable &&
    !issues.includes("기술점수 이력 부족") &&
    !issues.includes("수정주가 출처·120일 이력 확인 필요")
      ? score(s?.technical)
      : null;
  const priority =
    priceAvailable && s?.region && !issues.includes("벤치마크 수익률 없음")
      ? score(s.priority)
      : null;
  const health =
    current && !krxPending && !issues.includes("KRX 시총·20일 거래대금 필요")
      ? score(s?.health)
      : null;
  const environment =
    current &&
    !issues.includes("환경점수 데이터 없음") &&
    (s?.environmentSource === "stock_sector" ||
      (previousDate !== null &&
        (s?.environmentSource === "peer_mix_lag1" || s?.environmentSource === "own_index_lag1")))
      ? score(s?.environment)
      : null;
  const underlyingClose = current && positive(s?.underlyingClose) ? s.underlyingClose : null;
  const underlyingMa60 = current && positive(s?.underlyingMa60) ? s.underlyingMa60 : null;
  const underlyingJudgment =
    underlyingClose === null || underlyingMa60 === null
      ? ("unconfirmed" as const)
      : underlyingClose < underlyingMa60
        ? ("below_ma60" as const)
        : ("above_ma60" as const);
  const mapping = ETF_MAPPING[row.instrument.symbol];
  return {
    current,
    krxPending,
    isStrategyTarget:
      isEtfStrategyAssetClass(mapping) && !row.instrument.isLeveraged && !row.instrument.isInverse,
    score:
      !krxPending && [technical, priority, health, environment].every((value) => value !== null)
        ? score(s?.score)
        : null,
    previousScore: previousDate ? score(s?.previousScore) : null,
    previousDate,
    technical: technical === null ? null : technical * 0.625,
    priority: priority === null ? null : priority * 0.075,
    health: health === null ? null : health * 0.15,
    environment: environment === null ? null : environment * 0.15,
    annualVolatility: priceAvailable ? nonnegative(s?.annualVolatility) : null,
    entryWeight: current && !krxPending && s?.eligible ? nonnegative(s.entryWeight) : null,
    averageTradingValue20: current && !krxPending ? nonnegative(s?.averageTradingValue20) : null,
    underlyingClose,
    underlyingMa60,
    underlyingJudgment,
    provenanceLabel: current
      ? `${asOfDate} 저장 근거`
      : `기준일·전략 출처 미확인${s?.date ? ` · 저장 기준일 ${s.date}` : ""} · 재계산 필요`,
  };
}
