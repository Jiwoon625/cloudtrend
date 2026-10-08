import type { StockAssessmentDisplay } from "@/lib/stockAssessmentDisplay";

export function StockAssessmentDetails({ assessment }: { assessment: StockAssessmentDisplay }) {
  return (
    <div className="space-y-1 text-[11px] leading-relaxed" aria-label="계산된 조건별 판단">
      {assessment.conditions.map((condition) => (
        <p key={condition}>{condition}</p>
      ))}
      <p>{assessment.exit}</p>
      {assessment.failed.length ? (
        <p className="text-down">확인된 미충족: {assessment.failed.join(" · ")}</p>
      ) : null}
      {assessment.pending.length ? (
        <p className="text-warn">자료 확인 대기: {assessment.pending.join(" · ")}</p>
      ) : null}
      <p className="font-medium">{assessment.finalEntry}</p>
    </div>
  );
}
