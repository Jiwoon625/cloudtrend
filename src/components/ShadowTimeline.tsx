import { useState } from "react";
import type { OctoberShadowBookSummary } from "@/lib/octoberShadowSummary.server";
export function ShadowTimeline({ book }: { book: OctoberShadowBookSummary }) {
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const invalid = !!from && !!to && from > to;
  const days = (book.history ?? []).filter(
    (d) => (!from || d.date >= from) && (!to || d.date <= to),
  );
  const trades = (book.trades ?? []).filter(
    (d) => (!from || d.date >= from) && (!to || d.date <= to),
  );
  const values = days.flatMap((d) => [d.nav, d.benchmark].filter((n): n is number => n !== null));
  const lo = Math.min(...values),
    hi = Math.max(...values),
    range = hi - lo || 1;
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
        return `${command}${30 + (index * 730) / Math.max(1, days.length - 1)},${180 - ((value - lo) * 150) / range}`;
      })
      .join(" ");
  };
  return (
    <section className="space-y-3 border-t pt-3">
      <h4 className="text-sm font-semibold">성과 곡선 · 매매</h4>
      <div className="flex flex-wrap gap-3 text-xs">
        <label>
          시작일 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          종료일 <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
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
                viewBox="0 0 800 220"
                className="w-full rounded border"
              >
                <title>선택 기간 NAV, 동일 통화 기준</title>
                <text x="30" y="18" fontSize="11" fill="currentColor">
                  {hi.toLocaleString()} {book.currency}
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
                <text x="30" y="209" fontSize="11" fill="currentColor">
                  {days[0]?.date}
                </text>
                <text x="680" y="209" fontSize="11" fill="currentColor">
                  {days.at(-1)?.date}
                </text>
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
