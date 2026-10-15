import type { NewActualPosition } from "./newActualPortfolio";

/** Shared trust boundary for actual holding alerts, never strategy/model exits. */
export type ActualPriceExitEvidence = Pick<
  NonNullable<NewActualPosition["priceExit"]>,
  "reason" | "signalDate" | "threshold" | "status" | "auditStatus"
>;
export function isActionableActualPriceExit(
  exit: ActualPriceExitEvidence | null | undefined,
): exit is ActualPriceExitEvidence & { reason: "K4" | "E4"; signalDate: string } {
  return !!(
    exit &&
    (exit.reason === "K4" || exit.reason === "E4") &&
    exit.signalDate &&
    exit.threshold &&
    (exit.auditStatus === "VERIFIED" || exit.auditStatus === "LATCHED")
  );
}
export function actualPriceExitStatus(exit: ActualPriceExitEvidence | null | undefined): string {
  if (!exit) return "손절 기준가격 확인 대기";
  if (
    !isActionableActualPriceExit(exit) &&
    (exit.reason || exit.signalDate || /청산 대기|다음 거래/.test(exit.status))
  )
    return "가격청산 근거 확인 대기";
  return exit.status;
}
