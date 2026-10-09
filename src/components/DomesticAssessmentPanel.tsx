import { EtfAssessmentDetails } from "./EtfAssessmentDetails";
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { DashboardMarketSignals } from "@/lib/dashboardOperations";
import { StockAssessmentDetails } from "./StockAssessmentDetails";

/** All derived stock assessments remain browsable, including failed and pending universes. */
export function DomesticAssessmentPanel({
  markets,
  heldOnly = false,
}: {
  markets: DashboardMarketSignals[];
  heldOnly?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [market, setMarket] = useState("ALL");
  const domestic = markets.filter(
    (m) => m.market === "KOSPI" || m.market === "KOSDAQ" || m.market === "ETF",
  );
  const all = domestic.flatMap((m) => m.assessments ?? []).filter((r) => !heldOnly || r.held);
  const filtered = all.filter(
    (r) =>
      (market === "ALL" || market === r.market) &&
      `${r.name} ${r.symbol}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const stocks = all.filter((r) => r.market !== "ETF");
  const counts = {
    score: stocks.filter((r) => r.assessment?.score != null).length,
    onset: stocks.filter((r) => r.assessment?.rawOnset).length,
    a: stocks.filter((r) => r.assessment?.grade === "A").length,
    b: stocks.filter((r) => r.assessment?.grade === "B").length,
    pending: stocks.filter((r) => r.assessment?.pending.length).length,
  };
  return (
    <section
      className="my-4 rounded-lg border border-border bg-card"
      aria-label={heldOnly ? "보유종목 조건별 판단" : "저녁 스크리닝 조건별 판단"}
    >
      <div className="space-y-2 border-b p-3">
        <h2 className="text-sm font-semibold">
          {heldOnly ? "보유종목 조건별 판단" : "계산된 국내 조건별 판단"}
        </h2>
        <p className="text-[11px] text-muted-foreground">
          KRX 시가총액 등은 다음 영업일 08:00 KST부터 확인 가능합니다. 저녁에는
          가격·거래량·기술점수·돌파·청산·확인 조건을 먼저 표시하며, 최종 진입은 별도로 구분합니다.
          보유 기간 청산은 기존 원장을 확인하세요.
        </p>
        {stocks.length > 0 ? (
          <p className="text-xs">
            기술점수 확인 {counts.score} / {stocks.length}종목 · 기술 A {counts.a} / B {counts.b} ·
            기술 8.0 신규 돌파 {counts.onset} · 자료 확인 대기 {counts.pending}
          </p>
        ) : null}
        {all.some((r) => r.market === "ETF") ? (
          <p className="text-xs">
            ETF {all.filter((r) => r.market === "ETF").length}종목 · KRX 자료 확인 대기{" "}
            {all.filter((r) => r.etfAssessment?.krxPending).length}
          </p>
        ) : null}
        <p className="text-[10px] text-muted-foreground">
          기술 등급·돌파 집계는 보유·시가총액 조건과 독립적이며, 진입 준비 수가 아닙니다.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            aria-label="조건별 판단 종목 검색"
            placeholder="종목명 / 코드"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
            className="rounded border bg-background px-2 py-1 text-xs"
          />
          <select
            aria-label="조건별 판단 시장"
            value={market}
            onChange={(e) => {
              setMarket(e.target.value);
              setPage(0);
            }}
            className="rounded border bg-background px-2 py-1 text-xs"
          >
            <option value="ALL">국내 전체</option>
            <option>KOSPI</option>
            <option>KOSDAQ</option>
            <option>ETF</option>
          </select>
        </div>
      </div>
      {domestic.some((m) => m.assessments === undefined) ? (
        <p className="p-3 text-xs text-warn">
          조건별 판단 자료 미확인 · 새로고침 후 다시 확인하세요.
        </p>
      ) : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px] text-xs">
          <thead>
            <tr className="border-b text-left">
              <th className="p-3">종목 / 기준일</th>
              <th className="p-3">가격·거래량</th>
              <th className="p-3">확인된 조건과 대기 항목</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(currentPage * 20, (currentPage + 1) * 20).map((r) => (
              <tr key={r.symbol} className="border-b align-top last:border-0">
                <td className="p-3">
                  <Link
                    to="/instrument/$symbol"
                    params={{ symbol: r.symbol }}
                    className="font-medium hover:underline"
                  >
                    {r.name}
                  </Link>
                  <p>
                    {r.symbol} · {r.market}
                  </p>
                  <p>{r.date}</p>
                  <p className="mt-1">{r.reason}</p>
                </td>
                <td className="p-3">
                  <p>
                    {(r.assessment?.current || r.etfAssessment?.current) &&
                    r.price != null &&
                    r.price > 0
                      ? `${r.price.toLocaleString("ko-KR")}원`
                      : "기준일 가격 미확인"}
                  </p>
                  {r.market !== "ETF" ? (
                    <p>
                      20일 거래량 비율{" "}
                      {r.assessment?.volumeRatio20 == null
                        ? "미확인"
                        : `${r.assessment.volumeRatio20.toFixed(1)}%`}
                    </p>
                  ) : null}
                </td>
                <td className="p-3">
                  {r.assessment ? (
                    <StockAssessmentDetails assessment={r.assessment} held={r.held ?? false} />
                  ) : r.etfAssessment ? (
                    <EtfAssessmentDetails evidence={r.etfAssessment} />
                  ) : (
                    <p>조건별 판단 자료 미확인</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!filtered.length ? (
        <p className="p-4 text-xs text-muted-foreground">표시할 조건별 판단이 없습니다.</p>
      ) : null}
      <div className="flex items-center justify-end gap-3 border-t p-3 text-xs">
        <span>
          {filtered.length}종목 · {currentPage + 1}/{pages}페이지
        </span>
        <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          이전
        </button>
        <button disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>
          다음
        </button>
      </div>
    </section>
  );
}
