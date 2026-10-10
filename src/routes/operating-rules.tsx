import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/AppShell";
import { OperatingBacktestMetrics } from "@/components/OperatingBacktestMetrics";
import {
  OPERATING_RULES,
  OPERATING_RULES_VERSION,
  OPERATING_RULES_START,
  COMMON_EXECUTION_RULES,
} from "@/lib/operatingRules";
export const Route = createFileRoute("/operating-rules")({
  component: OperatingRules,
  head: () => ({ meta: [{ title: "운영규칙 | CloudTrend" }] }),
});
function RuleGroup({ role, detail }: { role: "운영" | "실험"; detail: boolean }) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {OPERATING_RULES.filter((r) => r.role === role).map((r) => (
        <article key={r.market} className="rounded-lg border bg-card p-4 space-y-2">
          <h3 className="font-semibold">{r.market}</h3>
          <p>{r.entry}</p>
          {detail ? (
            <>
              <p>
                <strong>확인:</strong> {r.confirmation}
              </p>
              <p>
                <strong>청산:</strong> {r.exit}
              </p>
              <p>
                <strong>배분:</strong> {r.allocation}
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">{r.exit}</p>
          )}
          {role === "운영" && !detail ? <OperatingBacktestMetrics market={r.market} /> : null}
        </article>
      ))}
    </div>
  );
}
function OperatingRules() {
  return (
    <AppShell>
      <main className="space-y-6 text-sm">
        <header>
          <h1 className="text-xl font-bold">운영규칙</h1>
          <p className="text-muted-foreground">
            {OPERATING_RULES_VERSION} · 적용 시작 {OPERATING_RULES_START} · 10월 9일 사용자 결정
          </p>
        </header>
        <section className="space-y-3">
          <h2 className="font-semibold">운영규칙 요약</h2>
          <RuleGroup role="운영" detail={false} />
          <article className="rounded-lg border bg-card p-4 space-y-2">
            <h3 className="font-semibold">한국 통합 백테스트 참고</h3>
            <OperatingBacktestMetrics market="한국 통합" />
          </article>
        </section>
        <section className="space-y-3">
          <h2 className="font-semibold">운영규칙 상세</h2>
          <RuleGroup role="운영" detail />
          <ul className="list-disc space-y-2 pl-5">
            {COMMON_EXECUTION_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </section>
        <section className="space-y-3">
          <h2 className="font-semibold">실험규칙 요약</h2>
          <RuleGroup role="실험" detail={false} />
        </section>
        <section className="space-y-3">
          <h2 className="font-semibold">실험규칙 상세</h2>
          <RuleGroup role="실험" detail />
          <p>
            장기 CM 자산배분 연구는 GitHub Actions와 비공개 결과 저장소에서 실행합니다. Colab은 필요
            시 수집·보조 연구에 사용합니다. 미완료 연구의 중간 순위를 최종 채택 결과로 표시하지
            않습니다.
          </p>
        </section>
      </main>
    </AppShell>
  );
}
