import { validDate } from "./ledger/date";
import type { MarketDataset } from "./engine/dataset";
import { STRATEGY_VERSION } from "./engine/scoring";
import { ETF_POLICY } from "./engine/etfStrategy";
import { kospiPolicyVersionAt } from "./engine/kospiEntryConfirmation";

/** Mirrors pipeline's identity only. No analysis/scoring is executed to inspect data quality. */
export const dataStatusStrategyVersion = (date: string) =>
  `${STRATEGY_VERSION} / ${ETF_POLICY.version} / ${kospiPolicyVersionAt(date)}`;

export function dataStatusVolatility(
  dataset: Pick<MarketDataset, "asOfDate" | "vkospiObservations"> &
    Partial<Pick<MarketDataset, "isLive">>,
) {
  const matches = dataset.vkospiObservations?.filter((r) => r.date === dataset.asOfDate) ?? [];
  const observation = matches[0];
  if (
    !validDate(dataset.asOfDate) ||
    dataset.vkospiObservations?.some((r) => !validDate(r.date)) ||
    matches.length !== 1 ||
    !observation ||
    ![
      "VKOSPI",
      "REALIZED_VOLATILITY_KOSPI",
      "REALIZED_VOLATILITY_KOSPI_KOSDAQ_70_30",
      "MOCK_VKOSPI",
    ].includes(observation.source) ||
    (dataset.isLive && observation.source === "MOCK_VKOSPI") ||
    observation.value === null ||
    !Number.isFinite(observation.value) ||
    observation.issues?.length
  )
    return { source: "UNCONFIRMED", date: dataset.asOfDate, label: "기준일 원본·대체 자료 미확인" };
  const label =
    observation.source === "VKOSPI"
      ? "원본 VKOSPI 관측"
      : observation.source === "MOCK_VKOSPI"
        ? "합성 VKOSPI · 실자료 아님"
        : observation.source === "REALIZED_VOLATILITY_KOSPI_KOSDAQ_70_30"
          ? "실현변동성 대체 · KOSPI/KOSDAQ 70/30"
          : "실현변동성 대체 · KOSPI";
  return { source: observation.source, date: observation.date, label };
}
