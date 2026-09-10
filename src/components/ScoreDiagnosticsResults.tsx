import { useState } from "react";
import type { ScoreDiagnostics, ScoreDiagnosticRow } from "@/lib/engine/scoreDiagnostics";

const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const rate = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);

function DiagnosticTable({
  rows,
  split,
  horizon,
}: {
  rows: ScoreDiagnosticRow[];
  split: string;
  horizon: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[1050px] text-[11px]">
        <thead className="text-muted-foreground">
          <tr>
            {[
              "구간",
              "보유",
              "점수 / 진입 상태",
              "n",
              "평균",
              "시장초과",
              "중앙",
              "승률",
              "P5",
              "만기 −10%",
              "도중 −10%",
              "도중 −20%",
            ].map((label) => (
              <th key={label} className="whitespace-nowrap px-2 py-2 text-right">
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.split}-${r.horizon}-${r.threshold}-${r.label}`}
              className={`border-t border-border/50 ${r.split === split && r.horizon === horizon ? "" : "hidden print:table-row"}`}
            >
              <td className="px-2 py-1">{r.split}</td>
              <td className="px-2 py-1">{r.horizon}D</td>
              <td className="whitespace-nowrap px-2 py-1">
                {r.threshold === null ? `${r.label}점` : `${r.threshold}점+ · ${r.label}`}
              </td>
              <td className="num px-2 py-1 text-right">{r.count.toLocaleString()}</td>
              <td className="num px-2 py-1 text-right">{pct(r.avgReturn)}</td>
              <td
                className="num px-2 py-1 text-right"
                title={`벤치마크 일치 표본 ${r.benchmarkCount}건`}
              >
                {pct(r.excessReturn)}
                <small className="block text-muted-foreground">
                  n={r.benchmarkCount.toLocaleString()}
                </small>
              </td>
              <td className="num px-2 py-1 text-right">{pct(r.medianReturn)}</td>
              <td className="num px-2 py-1 text-right">{rate(r.winRate)}</td>
              <td className="num px-2 py-1 text-right">{pct(r.p5)}</td>
              <td className="num px-2 py-1 text-right">{rate(r.loss10Rate)}</td>
              <td
                className="num px-2 py-1 text-right"
                title={`저가 경로 완전 표본 ${r.pathCount}건`}
              >
                {rate(r.drawdown10Rate)}
                <small className="block text-muted-foreground">
                  n={r.pathCount.toLocaleString()}
                </small>
              </td>
              <td className="num px-2 py-1 text-right">{rate(r.drawdown20Rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScoreDiagnosticsResults({
  diagnostics,
  horizons,
}: {
  diagnostics: ScoreDiagnostics;
  horizons: number[];
}) {
  const [split, setSplit] = useState("ALL");
  const [horizon, setHorizon] = useState(horizons.includes(30) ? 30 : (horizons[0] ?? 20));
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <header className="space-y-2 border-b border-border bg-surface-strong p-3">
        <h2 className="text-sm font-semibold">9.5점 기술점수 · 일별 미래성과와 고점 매수 위험</h2>
        <p className="text-[11px] text-muted-foreground">
          52주 포함 전체 7개 항목의 기본 배점을 고정합니다. 다음 거래일 시가 진입 → 보유 h번째
          거래일 종가 청산. 왕복 비용 {diagnostics.roundTripCostBps}bps.
        </p>
        <p className="text-[11px] text-muted-foreground">
          점수 계산 가능 {diagnostics.validScoreDays.toLocaleString()}일 · 자료 부족{" "}
          {diagnostics.missingScoreDays.toLocaleString()}일 · 최초{" "}
          {diagnostics.firstScoreDate ?? "없음"} · OOS 시작 {diagnostics.oosStart ?? "없음"}
        </p>
        <div className="flex flex-wrap gap-3 text-[12px]" data-no-print>
          <label>
            기간{" "}
            <select
              aria-label="점수 분석 기간"
              className="rounded border border-border bg-card p-1"
              value={split}
              onChange={(e) => setSplit(e.target.value)}
            >
              <option value="ALL">전체</option>
              <option value="OOS">OOS</option>
            </select>
          </label>
          <label>
            보유기간{" "}
            <select
              aria-label="점수 분석 보유기간"
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
        <p className="text-[11px] text-muted-foreground">
          P5는 만기 수익률 하위 5% 경계입니다. ‘도중 −10%/−20%’는 진입가 대비 해당 하락폭을 저가가
          한 번이라도 기록한 비율이며 실제 손절 수익률이 아닙니다. 시장초과와 경로 분석은 각각 유효
          표본 수를 표시합니다.
        </p>
      </header>
      <h3 className="px-3 py-2 text-[12px] font-semibold">점수 구간별 미래성과</h3>
      <DiagnosticTable
        rows={diagnostics.rows.filter((r) => r.kind === "BAND")}
        split={split}
        horizon={horizon}
      />
      <h3 className="border-t border-border px-3 py-2 text-[12px] font-semibold">
        신규 돌파와 지속 상태 비교
      </h3>
      <p className="px-3 pb-2 text-[11px] text-muted-foreground">
        매 거래일 기준으로 신규 돌파와 연속 유지일수를 판정합니다. 최초 유효 점수가 이미 기준
        이상이거나 자료 공백 뒤 시작된 고득점은 ‘시작 불명’으로 분리합니다. 기준 미만으로 내려갔다가
        다시 돌파하면 새로운 에피소드입니다.
      </p>
      <DiagnosticTable
        rows={diagnostics.rows.filter((r) => r.kind === "STATE")}
        split={split}
        horizon={horizon}
      />
      <p className="border-t border-border p-3 text-[11px] text-muted-foreground">
        반복·중첩 관측이 포함된 기술통계이며 실제 포트폴리오 성과가 아닙니다. OOS는 시간순 마지막
        구간의 진단용 구분으로, 해당 결과를 가중치 선택에 사용했다면 독립 검증이 아닙니다. PDF에는
        모든 보유기간과 전체/OOS를 출력합니다. 미래 보유기간이 끝나지 않은 표본은 제외합니다.
      </p>
    </section>
  );
}
