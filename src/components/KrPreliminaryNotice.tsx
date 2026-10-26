import type { KrScreeningPublication } from "@/lib/krScreeningPublication";

export function KrPreliminaryNotice({
  publication,
}: {
  publication?: KrScreeningPublication | undefined;
}) {
  if (publication?.phase !== "PRELIMINARY") return null;
  return (
    <div
      role="status"
      className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
    >
      <strong>PRELIMINARY · {publication.asOfDate} 예비 스크리닝</strong>
      <p>
        KRX 공표 대기 중입니다. 가격 기반 결과이며 미공표 항목은 판단 보류합니다.
        Shadow·통합배분·평가원장은 갱신하지 않습니다.
      </p>
    </div>
  );
}
