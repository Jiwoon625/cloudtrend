import type { etfPartialEvidence } from "@/lib/etfPartialEvidence";

const value = (number: number | null, missing = "산정 불가") =>
  number === null ? missing : number.toLocaleString("ko-KR", { maximumFractionDigits: 2 });

/** Shared read-only explanation; it never supplies actionable entry/exit state. */
export function EtfAssessmentDetails({
  evidence,
}: {
  evidence: ReturnType<typeof etfPartialEvidence>;
}) {
  return (
    <div className="space-y-1 whitespace-normal text-xs" aria-label="ETF 부분 판단 근거">
      <p className="font-medium">
        {evidence.krxPending
          ? "KRX 자료 대기 · M0·진입·청산 확정 보류"
          : !evidence.current
            ? "기준일 자료 미확인 · 재계산 필요"
            : evidence.score === null
              ? "일부 항목 미확인 · M0 산정 불가"
              : `M0 ${value(evidence.score)}/100`}
      </p>
      <p>
        기술 {value(evidence.technical)}/62.5 · Priority {value(evidence.priority)}/7.5
      </p>
      <p>
        Health {value(evidence.health)}/15 · 환경 {value(evidence.environment)}/15
      </p>
      <p>
        기초지수 {value(evidence.underlyingClose, "미확인")} / MA60{" "}
        {value(evidence.underlyingMa60, "미확인")}
      </p>
      <p>
        {evidence.underlyingJudgment === "below_ma60"
          ? "관측 근거: 기초지수 MA60 하회"
          : evidence.underlyingJudgment === "above_ma60"
            ? "관측 근거: 기초지수 MA60 이상"
            : "기초지수 MA60 판단 미확인"}
      </p>
      <p className="text-muted-foreground">{evidence.provenanceLabel}</p>
    </div>
  );
}
