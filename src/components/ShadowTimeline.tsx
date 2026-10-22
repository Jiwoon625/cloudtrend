import { useState } from "react";
import type { OctoberShadowBookSummary } from "@/lib/octoberShadowSummary.server";
export function ShadowTimeline({
  book,
  period,
}: {
  book: OctoberShadowBookSummary;
  period?: { from: string; to: string } | undefined;
}) {
  const [localFrom, setFrom] = useState(""),
    [localTo, setTo] = useState("");
  const from = period?.from ?? localFrom,
    to = period?.to ?? localTo;
  const invalid = !!from && !!to && from > to;
  const days = (book.history ?? []).filter(
    (d) => (!from || d.date >= from) && (!to || d.date <= to),
  );
  const trades = (book.trades ?? []).filter(
    (d) => (!from || d.date >= from) && (!to || d.date <= to),
  );
  const values = days.flatMap((d) =>
    [d.nav, d.benchmark].filter((n): n is number => n !== null && Number.isFinite(n)),
  );
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const padding = min === max ? Math.max(Math.abs(min) * 0.01, 1) : (max - min) * 0.05;
  const lo = min - padding,
    hi = max + padding,
    range = hi - lo;
  const x = (index: number) => 105 + (index * 660) / Math.max(1, days.length - 1);
  const y = (value: number) => 205 - ((value - lo) * 165) / range;
  const yTicks = Array.from({ length: 5 }, (_, i) => lo + (range * i) / 4);
  const xTicks = [
    ...new Set(
      Array.from({ length: Math.min(5, days.length) }, (_, i) =>
        Math.round((i * (days.length - 1)) / Math.max(1, Math.min(5, days.length) - 1)),
      ),
    ),
  ];
  const path = (field: "nav" | "benchmark") => {
    let connected = false;
    return days
      .map((day, index) => {
        const value = day[field];
        if (value === null || !Number.isFinite(value)) {
          connected = false;
          return "";
        }
        const command = connected ? "L" : "M";
        connected = true;
        return `${command}${x(index)},${y(value)}`;
      })
      .join(" ");
  };
  return (
    <section className="space-y-3 border-t pt-3">
      <h4 className="text-sm font-semibold">성과 곡선 · 매매</h4>
      <div className="flex flex-wrap gap-3 text-xs">
        {!period ? (
          <>
            <label>
              시작일 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              종료일 <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
          </>
        ) : null}
        <span>
          전체 시리즈 MDD {book.mddPercent == null ? "산정 대기" : `${book.mddPercent.toFixed(2)}%`}
        </span>
      </div>
      {invalid ? (
        <p role="alert">종료일을 시작일 이후로 선택해 주세요.</p>
      ) : (
        <>
          {days.length && values.length ? (
            <>
              <svg
                role="img"
                aria-label="선택 기간 NAV와 벤치마크"
                viewBox="0 0 800 275"
                className="w-full rounded border"
              >
                <title>선택 기간 NAV, 동일 통화 기준</title>
                <text x="105" y="22" fontSize="12" fill="currentColor">
                  Y축: 평가자산 (NAV · {book.currency})
                </text>
                <line x1="105" y1="40" x2="105" y2="205" stroke="currentColor" />
                <line x1="105" y1="205" x2="765" y2="205" stroke="currentColor" />
                {yTicks.map((tick, i) => (
                  <g key={i}>
                    <line
                      x1="105"
                      y1={y(tick)}
                      x2="765"
                      y2={y(tick)}
                      stroke="currentColor"
                      opacity="0.12"
                    />
                    <text x="97" y={y(tick) + 4} textAnchor="end" fontSize="11" fill="currentColor">
                      {tick.toLocaleString(book.currency === "USD" ? "en-US" : "ko-KR", {
                        maximumFractionDigits: book.currency === "USD" ? 2 : 0,
                      })}
                    </text>
                  </g>
                ))}
                {xTicks.map((index) => (
                  <g key={index}>
                    <line x1={x(index)} y1="205" x2={x(index)} y2="210" stroke="currentColor" />
                    <text
                      x={x(index)}
                      y="228"
                      textAnchor={
                        index === 0 ? "start" : index === days.length - 1 ? "end" : "middle"
                      }
                      fontSize="11"
                      fill="currentColor"
                    >
                      {days[index]?.date}
                    </text>
                  </g>
                ))}
                <text x="435" y="258" textAnchor="middle" fontSize="12" fill="currentColor">
                  X축: 거래일
                </text>
                <path d={path("nav")} fill="none" stroke="currentColor" strokeWidth="2" />
                {days.some((d) => d.benchmark !== null) ? (
                  <path
                    d={path("benchmark")}
                    fill="none"
                    stroke="#94a3b8"
                    strokeWidth="2"
                    strokeDasharray="5 4"
                  />
                ) : null}
                {days.length === 1 && days[0]?.nav !== null && Number.isFinite(days[0]?.nav) ? (
                  <circle cx={x(0)} cy={y(days[0]!.nav!)} r="3" fill="currentColor" />
                ) : null}
              </svg>
              <p className="text-xs text-muted-foreground">
                실선 NAV · 점선 벤치마크{days.every((d) => d.benchmark === null) ? " 미연결" : ""} ·
                단기 성과는 누적수익률로 표시
              </p>
            </>
          ) : (
            <p className="text-xs">선택한 기간에 기록된 성과가 없습니다.</p>
          )}
          <details>
            <summary className="text-xs">매매 {trades.length}건</summary>
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th>종목</th>
                    <th>구분</th>
                    <th>수량</th>
                    <th>모델 가격</th>
                    <th>사유</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((t, i) => (
                    <tr key={`${t.date}:${t.symbol}:${t.side}:${i}`} className="border-t">
                      <td>{t.date}</td>
                      <td>{t.symbol}</td>
                      <td>{t.side}</td>
                      <td>{t.quantity}</td>
                      <td>{t.price}</td>
                      <td>{t.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
          <details>
            <summary className="text-xs">일별 원자료</summary>
            <pre className="max-h-64 overflow-auto text-xs">{JSON.stringify(days, null, 2)}</pre>
          </details>
        </>
      )}
    </section>
  );
}
