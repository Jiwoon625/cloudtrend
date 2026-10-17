import type { AnalysisResult, ScreeningRow } from "./engine/pipeline";
import {
  ETF_MAPPING,
  isEtfStrategyAssetClass,
  type EtfStrategySnapshot,
} from "./engine/etfStrategy";
import { operationalIndexPoint, type OperationalIndexProvider } from "./operationalUnderlyingIndex";

export interface OperationalEtfReference {
  date: string;
  close: number | null;
  ma60: number | null;
  version: string;
  artifactSha256: string;
}
export type OperationalScreeningRow = ScreeningRow & {
  operationalEtfReference?: OperationalEtfReference;
};
export type OperationalEtfSnapshot = EtfStrategySnapshot & {
  underlyingIndexVersion?: string;
  underlyingIndexArtifactSha256?: string;
};
export type OperationalAnalysis = AnalysisResult & {
  operationalIndex?: {
    version: string;
    artifactSha256: string;
    asOfDate: string;
    availableFrom: string;
  };
};
/** Publication-only adapter. Frozen engines, M0, origin dates, and historical eligibility are untouched. */
export function withOperationalEtfMa60(
  base: AnalysisResult,
  provider: OperationalIndexProvider | undefined,
): OperationalAnalysis {
  if (!provider) return base;
  if (provider.asOfDate !== base.asOfDate)
    throw new Error("MA60 공급 기준일과 스크리닝 기준일 불일치");
  const rows = base.rows.map((baseRow) => {
    if (baseRow.instrument.instrumentType !== "ETF") return baseRow;
    const point = operationalIndexPoint(provider, baseRow.instrument.symbol, base.asOfDate);
    const row: OperationalScreeningRow = {
      ...baseRow,
      operationalEtfReference: {
        date: base.asOfDate,
        close: point?.close ?? null,
        ma60: point?.ma60 ?? null,
        version: provider.version,
        artifactSha256: provider.artifactSha256,
      },
    };
    const old = row.etfStrategy;
    if (
      !old ||
      !isEtfStrategyAssetClass(ETF_MAPPING[row.instrument.symbol]) ||
      row.instrument.isLeveraged ||
      row.instrument.isInverse
    )
      return row;
    const close = point?.close ?? null,
      ma60 = point?.ma60 ?? null;
    const s: OperationalEtfSnapshot = {
      ...old,
      underlyingClose: close,
      underlyingMa60: ma60,
      underlyingIndexVersion: provider.version,
      underlyingIndexArtifactSha256: provider.artifactSha256,
    };
    if (old.dataStatus !== "krx_batch_pending") {
      s.exit =
        close === null || ma60 === null || old.issues.includes("기준일 ETF 가격 없음")
          ? "DATA_UNAVAILABLE"
          : close < ma60
            ? "MA60"
            : null;
      // Preserve the original, independently established M0 crossing and confirmation date.
      if (
        old.confirmationDate === base.asOfDate &&
        old.originDate &&
        (old.entryState === "confirmed" || old.entryState === "rejected")
      ) {
        s.confirmationIssues = old.confirmationIssues.filter(
          (i) => i !== "확인일 기초지수·MA60 결측" && i !== "확인일 기초지수 MA60 하회",
        );
        if (close === null || ma60 === null) s.confirmationIssues.push("확인일 기초지수·MA60 결측");
        else if (close < ma60) s.confirmationIssues.push("확인일 기초지수 MA60 하회");
        s.entryState = s.confirmationIssues.length ? "rejected" : "confirmed";
        s.onset = s.entryState === "confirmed";
      }
    }
    const actionLabelText =
      s.dataStatus === "krx_batch_pending"
        ? "KRX 일괄 미수신 · 신호 판단 대기"
        : s.exit === "DATA_UNAVAILABLE"
          ? "기초지수 데이터 점검"
          : s.onset
            ? "하루 확인 완료 · 다음 거래일 시가 진입"
            : s.exit === "MA60"
              ? "보유 시 다음 시가 청산"
              : s.entryState === "pending"
                ? "Onset · 다음 거래일 종가 확인 대기"
                : s.entryState === "rejected"
                  ? "하루 확인 탈락 · 새 Onset 필요"
                  : "관찰";
    return { ...row, etfStrategy: s, actionLabelText } satisfies ScreeningRow;
  });
  return {
    ...base,
    rows,
    strategyVersion: `${base.strategyVersion} / ${provider.version}`,
    operationalIndex: {
      version: provider.version,
      artifactSha256: provider.artifactSha256,
      asOfDate: provider.asOfDate,
      availableFrom: provider.availableFrom,
    },
  };
}
