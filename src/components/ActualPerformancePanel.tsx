import { decimal, format } from "@/lib/ledger/decimal";
import {
  actualPerformanceView,
  type ActualPerformanceSeries,
  type ActualPerformanceView,
} from "@/lib/ledger/actualPerformance";

const displayDecimal = (value: string) => {
  const [whole, fraction] = format(decimal(value)).split(".");
  return `${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
};
const amount = (value: string | null, currency: string | null) =>
  value === null ? "미확정" : `${displayDecimal(value)} ${currency ?? ""}`;
export function ActualPerformancePanel({
  series,
  loading = false,
  error = null,
}: {
  series?: ActualPerformanceSeries | undefined;
  loading?: boolean;
  error?: unknown;
}) {
  let view: ActualPerformanceView | null = null;
  let invalid = false;
  try {
    view = actualPerformanceView(series);
  } catch {
    invalid = true;
  }
  return (
    <section className="mb-4 rounded-lg border bg-card p-4" aria-label="10월 12일 이후 실제 성과">
      <h2 className="font-semibold">실제 포트폴리오 · 2026-10-12 신규 운용분 성과</h2>
      {error || invalid ? (
        <p role="alert" className="mt-2 text-sm text-warn">
          실제 성과 기준자료를 확인하지 못했습니다. 기존 원장 손익으로 대체하지 않습니다.
        </p>
      ) : loading ? (
        <p role="status" className="mt-2 text-sm">
          실제 성과 기준자료 확인 중…
        </p>
      ) : view?.status === "PENDING_BASELINE" ? (
        <div className="mt-2 text-sm">
          <p role="status" className="font-medium">
            준비 중 · 배정 현금 확정 대기
          </p>
          <p className="mt-1 text-muted-foreground">
            보유종목 없이 시작하며 실제로 배정한 현금만 기준점으로 확정합니다. 기존 보유·거래는
            보존하고 새 구간에서는 제외합니다. 새 구간의 손익·수익률·평가자산은 아직 미확정입니다.
          </p>
        </div>
      ) : view ? (
        <div className="mt-3">
          <p role="status" className="text-sm">
            {view.status === "WAITING_OBSERVATION"
              ? "기준점 확정 · 첫 일별 평가 대기"
              : view.status === "INCOMPLETE"
                ? "일별 자료 대조 필요 · 미확정 항목 있음"
                : "대조된 일별 성과"}
          </p>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-4">
            {[
              ["시작 배정 현금", amount(view.baselineNav, view.baseCurrency)],
              ["최근 평가자산", amount(view.latestNav, view.baseCurrency)],
              ["외부 입출금 조정 손익", amount(view.totalPnl, view.baseCurrency)],
              [
                "새 구간 수익률",
                view.returnPercent === null ? "미확정" : `${displayDecimal(view.returnPercent)}%`,
              ],
            ].map(([title, value]) => (
              <div key={title}>
                <dt className="text-muted-foreground">{title}</dt>
                <dd className="num mt-1 font-medium">{value}</dd>
              </div>
            ))}
          </dl>
          {view.points.length ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-xs">
                <caption className="mb-2 text-left">
                  새 구간 일별 평가 기록 · {view.baseCurrency}
                </caption>
                <thead>
                  <tr>
                    {["평가일", "평가자산", "순외부입출금", "구간손익", "상태"].map((t) => (
                      <th className="p-2" key={t}>
                        {t}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.points.map((p) => (
                    <tr className="border-t" key={p.date}>
                      <td className="p-2">{p.date}</td>
                      <td className="p-2">{amount(p.nav, view.baseCurrency)}</td>
                      <td className="p-2">{amount(p.netExternalFlow, view.baseCurrency)}</td>
                      <td className="p-2">{amount(p.pnl, view.baseCurrency)}</td>
                      <td className="p-2">{p.issues.length ? "대조 필요" : "확정"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      ) : null}
      {series?.baseline?.betaArchive && !invalid && !error ? (
        <details className="mt-3 rounded border p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            베타 종료 요약 · {series.baseline.betaArchive.asOfDate}
          </summary>
          <dl className="mt-2 grid gap-2 sm:grid-cols-2">
            {Object.entries(series.baseline.betaArchive.summaries).map(([label, value]) => (
              <div key={label}>
                <dt className="text-muted-foreground">{label}</dt>
                <dd>{value ?? "미확정"}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-muted-foreground">
            시작 기준점 대조 때 보관한 기존 성과 요약입니다. 원본 거래는 계속 보존됩니다.
          </p>
        </details>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        기존 실제 보유·거래·취득원가는 유지하되 새 성과에는 포함하지 않습니다. 10/12 이후 신규
        운용분만 계산하고 공용현금 중 실제 배정한 부분만 한 번 포함합니다. 기존 보유 매도대금을 새
        구간에 배정하면 외부입금으로 처리하며 투자수익으로 계산하지 않습니다.
      </p>
      {view?.status !== "PENDING_BASELINE" ? (
        <p className="mt-1 text-xs text-muted-foreground">
          외부 입출금은 증빙된 기초·기말 시점으로 조정합니다. 장중 시점이 미확정이면 수익률을
          표시하지 않습니다. 자산군별 배분 수익률은 배분기준 확정 후 별도로 계산합니다.
        </p>
      ) : null}
    </section>
  );
}
