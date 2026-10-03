import { formatCount } from "@/lib/format";
import type { DataStatusPayload } from "@/lib/market.functions";

const CAPABILITY_LABELS: Record<string, string> = {
  marketCap: "시가총액",
  fundamentals: "재무(펀더멘털)",
  etfFacts: "ETF NAV·총보수·순자산",
  sectors: "업종 분류·섹터지수",
  investorFlow: "투자자별 순매수",
  volatilityIndex: "변동성지수(VKOSPI)",
  exactTradingValue: "거래대금 실측값",
};

export function KrMarketDataPanel({ data }: { data: DataStatusPayload }) {
  const validations = [
    { label: "OHLC 논리 오류", value: data.checks.ohlcErrors },
    { label: "음수 거래량", value: data.checks.negativeVolume },
    { label: "동일 종목·일자 중복", value: data.checks.duplicates },
    { label: "미래 날짜 데이터", value: data.checks.futureDates },
    { label: "지표 최소 기간(120봉) 미충족", value: data.checks.insufficient },
    { label: "비정상 급등락 (검토 플래그)", value: data.checks.abnormalMoves },
  ];

  return (
    <section id="kr-data" className="min-w-0 scroll-mt-4" aria-label="한국 데이터 상세">
      <h2 className="text-lg font-bold tracking-tight">한국 · 데이터 상태 및 계산 로그</h2>
      <p className="mb-4 text-[12px] text-muted-foreground">
        공급자 {data.dataProvider} · 기준일 {data.asOfDate} · 데이터 버전 {data.dataVersion} · 전략
        v{data.strategyVersion} · {data.isLive ? "실데이터" : "합성 데이터"}
      </p>

      {data.notes.length > 0 ? (
        <ul className="mb-4 space-y-1 rounded-lg border border-border bg-card p-3 text-[12px] leading-relaxed text-muted-foreground">
          {data.notes.map((n) => (
            <li key={n}>· {n}</li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
          <h3 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
            공급자별 수집 현황
          </h3>
          <div
            className="overflow-x-auto"
            tabIndex={0}
            role="region"
            aria-label="한국 공급자별 수집 현황 표"
          >
            <table className="w-full min-w-[540px] text-[12px]">
              <thead className="text-[11px] text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left">공급자</th>
                  <th className="px-2 py-1.5 text-left">데이터 종류</th>
                  <th className="px-2 py-1.5 text-right">레코드 수</th>
                  <th className="px-2 py-1.5 text-right">대상 수</th>
                  <th className="px-2 py-1.5 text-left">상태</th>
                </tr>
              </thead>
              <tbody>
                {data.coverage.map((r) => (
                  <tr key={r.kind} className="border-t border-border">
                    <td className="px-2 py-1.5">{r.provider}</td>
                    <td className="px-2 py-1.5">{r.kind}</td>
                    <td className="num px-2 py-1.5 text-right">{formatCount(r.count)}</td>
                    <td className="num px-2 py-1.5 text-right">{formatCount(r.entities)}</td>
                    <td className={`px-2 py-1.5 ${r.ok ? "text-up" : "text-warn"}`}>
                      {r.ok ? "정상" : "미제공"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-4">
          <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
            <h3 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
              자동 검증 결과
            </h3>
            <table className="w-full text-[12px]">
              <tbody>
                {validations.map((v) => (
                  <tr key={v.label} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">{v.label}</td>
                    <td
                      className={`num px-3 py-2 text-right font-semibold ${v.value === 0 ? "text-up" : "text-warn"}`}
                    >
                      {formatCount(v.value)}건
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-3 py-2 text-[11px] text-muted-foreground">
              비정상 급등락은 자동 삭제하지 않고 corporate action 또는 데이터 오류 검토 대상으로만
              플래그합니다.
            </p>
          </div>

          <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
            <h3 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
              항목별 제공 여부
            </h3>
            <table className="w-full text-[12px]">
              <tbody>
                {Object.entries(data.capabilities).map(([key, ok]) => (
                  <tr key={key} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">{CAPABILITY_LABELS[key] ?? key}</td>
                    <td
                      className={`px-3 py-2 text-right font-semibold ${ok ? "text-up" : "text-muted-foreground"}`}
                    >
                      {ok ? "제공" : "미제공 → 점수 산정에서 제외"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-border bg-card">
        <h3 className="border-b border-border bg-surface-strong px-3 py-2 text-sm font-semibold">
          종목별 일봉 수집 구간
        </h3>
        <div
          className="max-h-[420px] overflow-auto"
          tabIndex={0}
          role="region"
          aria-label="한국 종목별 일봉 수집 구간 표"
        >
          <table className="w-full min-w-[560px] text-[12px]">
            <thead className="sticky top-0 bg-surface-strong text-[11px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 text-left">종목</th>
                <th className="px-2 py-1.5 text-left">심볼</th>
                <th className="px-2 py-1.5 text-right">봉 수</th>
                <th className="px-2 py-1.5 text-left">시작일</th>
                <th className="px-2 py-1.5 text-left">최종일</th>
              </tr>
            </thead>
            <tbody>
              {data.barCoverage.map((b) => (
                <tr key={b.symbol} className="border-t border-border">
                  <td className="px-2 py-1.5">{b.name}</td>
                  <td className="num px-2 py-1.5">{b.symbol}</td>
                  <td className={`num px-2 py-1.5 text-right ${b.bars < 120 ? "text-warn" : ""}`}>
                    {formatCount(b.bars)}
                  </td>
                  <td className="num px-2 py-1.5">{b.first}</td>
                  <td className="num px-2 py-1.5">{b.last}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
