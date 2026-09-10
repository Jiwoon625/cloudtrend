import { useState } from "react";
import type { StrategyValidation } from "@/lib/engine/strategyValidation";
const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const num = (v: number | null) => (v === null ? "—" : v.toFixed(2));

export function StrategyValidationResults({
  validation,
  horizons,
}: {
  validation: StrategyValidation;
  horizons: number[];
}) {
  const [split, setSplit] = useState("ALL"),
    [market, setMarket] = useState("ALL");
  const [horizon, setHorizon] = useState(horizons.includes(30) ? 30 : (horizons[0] ?? 20));
  const selectors = [
    {
      label: "검증 구간",
      value: split,
      change: setSplit,
      options: [
        ["ALL", "전체"],
        ["OOS", "OOS"],
      ],
    },
    {
      label: "시장",
      value: market,
      change: setMarket,
      options: [
        ["ALL", "전체 시장"],
        ["KOSPI", "KOSPI"],
        ["KOSDAQ", "KOSDAQ"],
      ],
    },
  ];
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="space-y-2 border-b border-border bg-surface-strong p-3">
        <h2 className="text-sm font-semibold">제안 전략 검증 · 진입 필터와 청산 규칙 비교</h2>
        <p className="text-[11px] text-muted-foreground">
          전체 9.5점 기준 6·7·8점 진입과 4점 미만 청산을 비교하는 사전 정의 시나리오입니다. 예전
          100점 환산 전략과 동일한 종목을 선택한다는 뜻은 아닙니다.
        </p>
        <p className="text-[11px] text-muted-foreground">
          같은 종목은 한 번에 한 포지션만 보유합니다. 모든 진입은 신호 다음 거래일 시가, 점수 청산도
          하락 확인 다음 거래일 시가입니다. 손절가 아래로 시가 갭이 나면 손절가가 아닌 시가에
          체결합니다. 왕복 비용 {validation.roundTripCostBps}bps.
        </p>
        <div className="flex flex-wrap gap-3 text-[12px]" data-no-print>
          {selectors.map((s) => (
            <label key={s.label}>
              {s.label}{" "}
              <select
                aria-label={`전략 ${s.label}`}
                className="rounded border border-border bg-card p-1"
                value={s.value}
                onChange={(e) => s.change(e.target.value)}
              >
                {s.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label>
            최대 보유{" "}
            <select
              aria-label="전략 최대 보유기간"
              className="rounded border border-border bg-card p-1"
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value))}
            >
              {horizons.map((h) => (
                <option key={h} value={h}>
                  {h}거래일
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1150px] text-[11px]">
          <thead className="text-muted-foreground">
            <tr>
              {[
                "구간/시장",
                "최대 보유",
                "시나리오",
                "거래",
                "평균",
                "중앙",
                "승률",
                "평균 이익",
                "평균 손실",
                "손익비",
                "평균 보유",
                "손절 비율",
                "점수 청산",
              ].map((label) => (
                <th key={label} className="whitespace-nowrap px-2 py-2 text-right">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {validation.rows.map((r) => (
              <tr
                key={`${r.scenario}-${r.split}-${r.market}-${r.horizon}`}
                className={`border-t border-border/50 ${r.split === split && r.market === market && r.horizon === horizon ? "" : "hidden print:table-row"}`}
              >
                <td className="whitespace-nowrap px-2 py-1">
                  {r.split}/{r.market}
                </td>
                <td className="px-2 py-1">{r.horizon}D</td>
                <td className="whitespace-nowrap px-2 py-1">{r.label}</td>
                <td className="num px-2 py-1 text-right">{r.trades.toLocaleString()}</td>
                <td className="num px-2 py-1 text-right">{pct(r.avgReturn)}</td>
                <td className="num px-2 py-1 text-right">{pct(r.medianReturn)}</td>
                <td className="num px-2 py-1 text-right">{pct(r.winRate)}</td>
                <td className="num px-2 py-1 text-right">{pct(r.avgWin)}</td>
                <td className="num px-2 py-1 text-right">{pct(r.avgLoss)}</td>
                <td className="num px-2 py-1 text-right">{num(r.payoff)}</td>
                <td className="num px-2 py-1 text-right">{num(r.averageHoldingDays)}일</td>
                <td className="num px-2 py-1 text-right">{pct(r.stopRate)}</td>
                <td className="num px-2 py-1 text-right">{pct(r.scoreExitRate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border p-3 text-[11px] text-muted-foreground">
        이 표는 종목별 순차 거래의 성과입니다. 종목 간 동시 자금배분·거래정지·호가 부족을 재현한
        계좌 수익률은 아닙니다. 일봉 저가로 손절 체결을 가정하므로 실제 체결과 다를 수 있습니다.
        초기부터 고득점인 종목은 State에 포함되고 Onset에서는 제외됩니다. 미래 보유기간이 모두
        확보된 진입만 비교하며, OOS는 전체 시뮬레이션 중 해당 구간 진입 거래입니다. 표본이 적거나
        OOS에서 재현되지 않는 조합을 최적 전략으로 단정하지 마세요. PDF에는 전체
        구간·시장·보유기간을 저장합니다.
      </p>
    </section>
  );
}
