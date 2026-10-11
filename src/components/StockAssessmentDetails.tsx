import {
  isOperationalSignalDate,
  isOperationalSignalOrigin,
  BEFORE_OPERATIONAL_START,
  PRE_START_ORIGIN,
} from "@/lib/operationalSignalStart";
import type { StockAssessmentDisplay } from "@/lib/stockAssessmentDisplay";

export function StockAssessmentDetails({
  assessment,
  held = false,
  signalDate,
  originDate,
  entryNotice,
  formatText = (text) => text,
}: {
  assessment: StockAssessmentDisplay;
  held?: boolean;
  signalDate?: string | undefined;
  originDate?: string | null | undefined;
  entryNotice?: string | null | undefined;
  formatText?: ((text: string) => string) | undefined;
}) {
  const excluded =
    signalDate !== undefined
      ? !isOperationalSignalDate(signalDate)
        ? BEFORE_OPERATIONAL_START
        : originDate && !isOperationalSignalOrigin(signalDate, originDate)
          ? PRE_START_ORIGIN
          : null
      : null;
  return (
    <div className="space-y-1 text-[11px] leading-relaxed" aria-label="계산된 조건별 판단">
      {assessment.conditions.map((condition) => (
        <p key={condition}>{formatText(condition)}</p>
      ))}
      {held && (signalDate === undefined || isOperationalSignalDate(signalDate)) ? (
        <p>{formatText(assessment.exit)}</p>
      ) : null}
      {assessment.failed.length ? (
        <p className="text-down">확인된 미충족: {formatText(assessment.failed.join(" · "))}</p>
      ) : null}
      {assessment.pending.length ? (
        <p className="text-warn">자료 확인 대기: {formatText(assessment.pending.join(" · "))}</p>
      ) : null}
      <p className="font-medium">{formatText(entryNotice ?? excluded ?? assessment.finalEntry)}</p>
    </div>
  );
}
