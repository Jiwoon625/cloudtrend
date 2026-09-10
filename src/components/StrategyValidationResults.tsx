import { useMemo, useState } from "react";
import type { StrategyValidation } from "@/lib/engine/strategyValidation";

const pct = (v: number | null) =>
  v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const num = (v: number | null) => (v === null ? "—" : v.toFixed(2));
const points = (v: number | null) =>
  v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}p`;

function SelectField({
  label,
  value,
  values,
  onChange,
  suffix = "",
}: {
  label: string;
  value: number;
  values: number[];
  onChange: (value: number) => void;
  suffix?: string;
}) {
  return (
    <label className="space-y-1">
      <span className="block text-[10px] text-muted-foreground">{label}</span>
      <select
        className="h-8 w-full rounded border border-border bg-card px-2 text-[12px]"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {values.map((option) => (
          <option key={option} value={option}>
            {option}{suffix}
          </option>
        ))}
      </select>
    </label>
  );
}

export function StrategyValidationResults({
  validation,
  horizons,
}: {
  validation: StrategyValidation;
  horizons: number[];
}) {
  const [split, setSplit] = useState<"ALL" | "OOS">("ALL");
  const [market, setMarket] = useState<"ALL" | "KOSPI" | "KOSDAQ">("ALL");
  const [entryThreshold, setEntryThreshold] = useState(60);
  const [maxHoldingDays, setMaxHoldingDays] = useState(30);
  const [upsideExitThreshold, setUpsideExitThreshold] = useState(80);
  const [downsideExitThreshold, setDownsideExitThreshold] = useState(60);

  const selected = useMemo(
    () =>
      validation.rows.find(
        (row) =>
          row.split === split &&
          row.market === market &&
          row.entryThreshold === entryThreshold &&
          row.maxHoldingDays === maxHoldingDays &&
          row.upsideExitThreshold === upsideExitThreshold &&
          row.downsideExitThreshold === downsideExitThreshold,
      ) ?? null,
    [
      validation.rows,
      split,
      market,
      entryThreshold,
      maxHoldingDays,
      upsideExitThreshold,
      downsideExitThreshold,
    ],
  );

  const comparableRows = useMemo(
    () =>
      validation.rows
        .filter((row) => row.split === split && row.market === market)
        .sort((a, b) => {
          const ar = a.avgReturn ?? -Infinity;
          const br = b.avgReturn ?? -Infinity;
          return br - ar;
        }),
    [validation.rows, split, market],
  );

  return (
    <section className="overflow-hidden rounded-lg border border-primary/30 bg-card">
      <header className="space-y-3 border-b border-border bg-primary/5 p-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">V6 매수·매도 전략 백테스트</h2>
            <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
              TRADE RULES
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            점수 배점은 기존 9.5점 원점수 체계를 그대로 사용하고 화면의 매매 기준만 0~100으로
            표시합니다. 60/70점 최초 상향 돌파를 종가에서 확인한 뒤 다음 거래일 시가에 진입합니다.
            상승·하락 점수 청산도 종가에서 확인하므로 다음 거래일 시가에 체결합니다.
          </p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-no-print>
          <SelectField
            label="매수 · Onset"
            value={entryThreshold}
            values={[60, 70]}
            suffix="점"
            onChange={setEntryThreshold}
          />
          <SelectField
            label="자동매도 · 최대 보유"
            value={maxHoldingDays}
            values={[20, 30, 40, 50]}
            suffix="거래일"
            onChange={setMaxHoldingDays}
          />
          <SelectField
            label="상승 매도 · 점수 상향 돌파"
            value={upsideExitThreshold}
            values={[80, 90]}
            suffix="점"
            onChange={setUpsideExitThreshold}
          />
          <SelectField
            label="하락 매도 · 점수 하향 이탈"
            value={downsideExitThreshold}
            values={[60, 50, 40, 30]}
            suffix="점"
            onChange={setDownsideExitThreshold}
          />
        </div>

        <div className="flex flex-wrap gap-3 text-[12px]" data-no-print>
          <label>
            검증 구간{" "}
            <select
              className="rounded border border-border bg-card p-1"
              value={split}
              onChange={(e) => setSplit(e.target.value as "ALL" | "OOS")}
            >
              <option value="ALL">전체</option>
              <option value="OOS">OOS</option>
            </select>
          </label>
          <label>
            시장{" "}
            <select
              className="rounded border border-border bg-card p-1"
              value={market}
              onChange={(e) => setMarket(e.target.value as "ALL" | "KOSPI" | "KOSDAQ")}
            >
              <option value="ALL">전체 시장</option>
              <option value="KOSPI">KOSPI</option>
              <option value="KOSDAQ">KOSDAQ</option>
            </select>
          </label>
        </div>

        <p className="text-[10px] text-muted-foreground">
          슬래시로 요청한 2 × 4 × 2 × 4 = 64개 매매 조합을 모두 사전 계산합니다. 위 선택값을 바꾸면
          해당 조합 결과를 즉시 비교할 수 있습니다. 기존 V5 forward horizon({horizons.join("/")}D)은
          아래 피처 진단용이며 V6 최대 보유기간과는 별도입니다. 왕복 비용 {validation.roundTripCostBps}bps.
        </p>
      </header>

      {selected ? (
        <div className="space-y-4 p-3">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ["거래 수", selected.trades.toLocaleString("ko-KR")],
              ["평균 수익률", pct(selected.avgReturn)],
              ["중앙 수익률", pct(selected.medianReturn)],
              ["승률", pct(selected.winRate)],
              ["평균 이익", pct(selected.avgWin)],
              ["평균 손실", pct(selected.avgLoss)],
              ["손익비", num(selected.payoff)],
              ["Profit Factor", num(selected.profitFactor)],
              ["평균 보유기간", selected.averageHoldingDays === null ? "—" : `${selected.averageHoldingDays.toFixed(1)}일`],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-border p-2">
                <p className="text-[10px] text-muted-foreground">{label}</p>
                <p className="num text-[13px] font-semibold">{value}</p>
              </div>
            ))}
          </div>

          <div className="grid gap-2 md:grid-cols-2">
            <div className="rounded-md border border-border p-3">
              <h3 className="mb-2 text-[12px] font-semibold">진입 시 기술점수 상승 속도</h3>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-[10px] text-muted-foreground">최근 5거래일 점수 변화</p>
                  <p className="num text-base font-semibold">{points(selected.avgScoreRise5d)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">최근 10거래일 점수 변화</p>
                  <p className="num text-base font-semibold">{points(selected.avgScoreRise10d)}</p>
                </div>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                진입 신호일 현재 0~100 기술점수에서 5/10거래일 전 점수를 뺀 평균 변화폭입니다.
              </p>
            </div>

            <div className="rounded-md border border-border p-3">
              <h3 className="mb-2 text-[12px] font-semibold">매도 사유 구성</h3>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <p className="text-[10px] text-muted-foreground">기간 만료</p>
                  <p className="num font-semibold">{pct(selected.timeExitRate)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">상승 목표</p>
                  <p className="num font-semibold">{pct(selected.upsideExitRate)}</p>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">모멘텀 하락</p>
                  <p className="num font-semibold">{pct(selected.downsideExitRate)}</p>
                </div>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-[11px]">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left">선택 전략</th>
                  <th className="px-2 py-1.5 text-right">거래</th>
                  <th className="px-2 py-1.5 text-right">평균</th>
                  <th className="px-2 py-1.5 text-right">중앙</th>
                  <th className="px-2 py-1.5 text-right">승률</th>
                  <th className="px-2 py-1.5 text-right">손익비</th>
                  <th className="px-2 py-1.5 text-right">평균 보유</th>
                  <th className="px-2 py-1.5 text-right">5D 상승</th>
                  <th className="px-2 py-1.5 text-right">10D 상승</th>
                  <th className="px-2 py-1.5 text-right">기간/상승/하락 매도</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-border">
                  <td className="whitespace-nowrap px-2 py-2 font-medium">{selected.label}</td>
                  <td className="num px-2 py-2 text-right">{selected.trades.toLocaleString("ko-KR")}</td>
                  <td className="num px-2 py-2 text-right font-semibold">{pct(selected.avgReturn)}</td>
                  <td className="num px-2 py-2 text-right">{pct(selected.medianReturn)}</td>
                  <td className="num px-2 py-2 text-right">{pct(selected.winRate)}</td>
                  <td className="num px-2 py-2 text-right">{num(selected.payoff)}</td>
                  <td className="num px-2 py-2 text-right">
                    {selected.averageHoldingDays === null ? "—" : `${selected.averageHoldingDays.toFixed(1)}D`}
                  </td>
                  <td className="num px-2 py-2 text-right">{points(selected.avgScoreRise5d)}</td>
                  <td className="num px-2 py-2 text-right">{points(selected.avgScoreRise10d)}</td>
                  <td className="num whitespace-nowrap px-2 py-2 text-right">
                    {pct(selected.timeExitRate)} / {pct(selected.upsideExitRate)} / {pct(selected.downsideExitRate)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <details data-no-print>
            <summary className="cursor-pointer text-[11px] font-medium text-primary">
              같은 구간·시장의 64개 전략 수익률 순위 보기
            </summary>
            <div className="mt-2 max-h-[360px] overflow-auto rounded border border-border">
              <table className="w-full min-w-[760px] text-[10px]">
                <thead className="sticky top-0 bg-surface-strong text-muted-foreground">
                  <tr>
                    <th className="px-2 py-1 text-left">전략</th>
                    <th className="px-2 py-1 text-right">거래</th>
                    <th className="px-2 py-1 text-right">평균</th>
                    <th className="px-2 py-1 text-right">중앙</th>
                    <th className="px-2 py-1 text-right">승률</th>
                    <th className="px-2 py-1 text-right">손익비</th>
                  </tr>
                </thead>
                <tbody>
                  {comparableRows.map((row) => (
                    <tr key={`${row.split}-${row.market}-${row.scenario}`} className="border-t border-border/50">
                      <td className="whitespace-nowrap px-2 py-1">{row.label}</td>
                      <td className="num px-2 py-1 text-right">{row.trades.toLocaleString("ko-KR")}</td>
                      <td className="num px-2 py-1 text-right">{pct(row.avgReturn)}</td>
                      <td className="num px-2 py-1 text-right">{pct(row.medianReturn)}</td>
                      <td className="num px-2 py-1 text-right">{pct(row.winRate)}</td>
                      <td className="num px-2 py-1 text-right">{num(row.payoff)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      ) : (
        <p className="p-4 text-[12px] text-muted-foreground">선택 조합의 결과가 없습니다.</p>
      )}

      <p className="border-t border-border p-3 text-[11px] leading-relaxed text-muted-foreground">
        동일 종목은 한 번에 한 포지션만 보유합니다. 최대 보유일까지 점수 기반 매도 사건이 없으면 해당
        거래일 종가로 자동매도합니다. 80/90점 상승 매도는 상향 돌파, 60/50/40/30점 하락 매도는
        하향 이탈일 때만 발생합니다. 신호일에 이미 선택한 상승 매도 점수를 넘은 종목은 신규 진입하지
        않습니다. 데이터 끝까지 최대 보유기간이 확보되지 않았고 조기 청산도 없었던 거래는 미완결로
        제외합니다. 이 결과는 종목별 거래 규칙 검증이며 계좌 전체 자금배분 시뮬레이션은 아닙니다.
      </p>
    </section>
  );
}
