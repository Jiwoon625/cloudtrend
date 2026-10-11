import { createFileRoute } from "@tanstack/react-router";
import { V8FormulaSection } from "@/components/V8FormulaSection";
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
            {OPERATING_RULES_VERSION} · 적용 시작 {OPERATING_RULES_START} · 신호 10월 9일 / 자산배분
            10월 11일 사용자 결정
          </p>
        </header>
        <section aria-label="실제·통합 자산배분 규칙" className="space-y-2 rounded border p-4">
          <h2 className="font-semibold">실제 S06 · 자산배분 Shadow</h2>
          <p>
            실제 총 배정계획 3,000만원: 한국 1,200만원 / ETF 600만원 / 미국 1,200만원. 배정계획
            자체로 실제 현금이 생기지 않습니다. 실제 보유·입출금·환전·미체결 예약을 같은 통화
            원장에서 확인합니다.
          </p>
          <p>
            한국·미국 신규 매수예산은 연초 시장별 자산을 30·20슬롯으로 나눕니다. ETF는 확인일 완료
            종가 기준 시장 보유자산과 귀속현금에 변동성 비중을 적용하며, 결측 평가액으로 새 수량을
            확정하지 않습니다.
          </p>
          <p>
            통합 Shadow는 각각 3,000만원입니다. O1 초기 한국/ETF/미국 각 1/3, S07은 60/20/20입니다.
            O1은 달력 전월 전달 진입신호가 있는 시장을 균등 배분하며 한 시장만 있으면 60%와
            현금40%입니다. 10월 첫 집계는 10/12부터의 부분월로 11월 목표에 반영합니다. 관측 누락은
            무신호와 구분합니다.
          </p>
          <p>
            O1 목표 0% 시장의 미체결 진입은 취소하고 예약 현금을 해제합니다. 유휴현금만 이동하며
            기존 보유는 강제매도하지 않습니다. 이 월별 전달 신호 방식은 원본 O1 연구의 독립
            참조·20세션 방식과 별도 운영 버전입니다.
          </p>
          <p>
            대시보드 조건 충족은 현금 부족에도 보존합니다. 실제 행동은 실제 체결 원장으로 판단하며
            Shadow 전용 보유는 실제 후보를 막지 않습니다. 수정가격과 별도로 모델 분배금 현금을 임의
            가산하지 않습니다.
          </p>
        </section>
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
        <V8FormulaSection />
      </main>
    </AppShell>
  );
}
