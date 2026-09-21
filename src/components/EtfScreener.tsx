import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ETF_POLICY, etfOrderPlan } from "@/lib/engine/etfStrategy";
import type { AnalysisResult } from "@/lib/engine/pipeline";

const num = (n: number | null | undefined, digits = 2) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : n.toLocaleString("ko-KR", { maximumFractionDigits: digits });
const pct = (n: number | null | undefined) => (n == null ? "—" : `${num(n * 100)}%`);
const environmentNames = {
  stock_sector: "국내 주식 섹터",
  peer_mix_lag1: "지역 ETF 환경 · 전일",
  own_index_lag1: "기초지수 대체 · 전일",
  unavailable: "데이터 없음",
};

export function EtfScreener({ analysis }: { analysis: AnalysisResult }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("equity");
  const [equity, setEquity] = useState("");
  const [cash, setCash] = useState("");
  const [held, setHeld] = useState("");
  const [prices, setPrices] = useState<Record<string, string>>({});
  const rows = analysis.rows.filter((r) => r.instrument.instrumentType === "ETF");
  const heldSymbols = [
    ...new Set(
      held
        .split(/[\s,]+/)
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean),
    ),
  ];
  const heldSet = new Set(heldSymbols);
  const validAccount =
    Number(equity) > 0 && cash.trim() !== "" && Number(cash) >= 0 && Number(cash) <= Number(equity);
  const orders = useMemo(
    () =>
      etfOrderPlan({
        equity: Number(equity),
        cash: cash.trim() === "" ? NaN : Number(cash),
        heldSymbols: [
          ...new Set(
            held
              .split(/[\s,]+/)
              .map((x) => x.trim().toUpperCase())
              .filter(Boolean),
          ),
        ],
        candidates: analysis.rows
          .filter((r) => r.instrument.instrumentType === "ETF")
          .map((r) => ({
            symbol: r.instrument.symbol,
            strategy: r.etfStrategy,
            price:
              prices[r.instrument.symbol] === undefined
                ? r.snapshot.close
                : Number(prices[r.instrument.symbol]),
          })),
      }),
    [analysis, equity, cash, held, prices],
  );
  const bySymbol = new Map(orders.map((o) => [o.symbol, o]));
  const shown = rows
    .filter((r) => {
      const s = r.etfStrategy,
        text = `${r.instrument.symbol} ${r.instrument.name}`.toLowerCase();
      if (!text.includes(query.trim().toLowerCase())) return false;
      if (filter === "entry") return s?.onset === true;
      if (filter === "exit") return heldSet.has(r.instrument.symbol) && s?.exit != null;
      if (filter === "missing") return !s?.eligible;
      if (filter === "equity") return s?.eligible === true;
      return true;
    })
    .sort(
      (a, b) =>
        Number(b.etfStrategy?.onset ?? false) - Number(a.etfStrategy?.onset ?? false) ||
        a.instrument.symbol.localeCompare(b.instrument.symbol),
    );
  const exits = rows.filter((r) => heldSet.has(r.instrument.symbol) && r.etfStrategy?.exit != null);
  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-bold">
          ETF 스크리너 <span className="text-sm text-muted-foreground">V0.1 확정 전략</span>
        </h1>
        <p className="text-sm text-muted-foreground">
          기준일 {analysis.asOfDate} · 일반 주식형 ETF · 최대 10종목
        </p>
      </header>
      <section className="rounded-lg border bg-card p-4 text-sm space-y-2" aria-label="확정 전략">
        <p>
          <strong>진입</strong> 전일 M0 &lt; 80 → 당일 M0 ≥ 80 · <strong>청산</strong> 기초지수 종가
          &lt; MA60 · 신호 확인 후 다음 거래일 시가 기준
        </p>
        <p>
          기술 62.5 + Priority 7.5 + Health 15 + 환경 15 = 100점. Priority는 국내 상대성과만
          반영합니다.
        </p>
        <p>
          <strong>신규 매수 비중 = 10% × min(1, 15% ÷ 20일 연환산 변동성)</strong>
        </p>
        <p className="text-muted-foreground">
          수정종가의 최근 20개 단순 일수익률 표본표준편차 × √252. 변동성 15% 이하는 10%, 20%는 7.5%,
          30%는 5%입니다. 보유 후 변동성 변화로 추가 매수·일부 매도하지 않습니다. 점수 청산과
          보유기한 제한은 없습니다.
        </p>
      </section>
      <section className="rounded-lg border bg-card p-4" aria-label="M0 요소별 산출방법">
        <h2 className="mb-3 text-sm font-semibold">M0 요소별 산출방법</h2>
        <dl className="grid gap-4 text-xs leading-relaxed sm:grid-cols-2">
          <div>
            <dt className="mb-1 font-semibold">기술 · 62.5점</dt>
            <dd className="text-muted-foreground">
              종가/구름대 상단, MA20/MA60, MA60/MA120, 종가/MA20, MA60의 5거래일 변화율을
              평가합니다. 각 비율의 이격도를 20일 일수익률 변동성으로 조정해 0~100점으로 연속 산정한
              뒤, 5개 항목 평균 × 62.5%를 반영합니다.
            </dd>
          </div>
          <div>
            <dt className="mb-1 font-semibold">Priority · 7.5점</dt>
            <dd className="text-muted-foreground">
              국내 투자 ETF의 당일 수정주가 수익률이 KOSPI 당일 수익률보다 2%p 이상 높으면 7.5점,
              미충족 또는 해외 투자 ETF는 0점입니다. 규모·로테이션·지수편입 가점은 없습니다.
            </dd>
          </div>
          <div>
            <dt className="mb-1 font-semibold">Health · 15점</dt>
            <dd className="text-muted-foreground">
              KRX ETF 시가총액 500억 원 이상 5점, 1,000억 원 이상이면 추가 2.5점, 최근 20거래일 평균
              거래대금 10억 원 이상 5점, 일반형 구조 2.5점을 합산합니다. 규모 기준은 이 항목에 남아
              있으며, 필수 데이터가 없으면 산정하지 않습니다.
            </dd>
          </div>
          <div>
            <dt className="mb-1 font-semibold">환경 · 15점</dt>
            <dd className="text-muted-foreground">
              국내 섹터형은 해당 주식 섹터의 20·60일 상대강도 순위, 추세, 상승 확산도를 합산합니다.
              해외·시장대표형은 같은 지역의 다른 기초지수군 3개 이상으로 추세 50% + 상승 확산도
              50%를 산정하고, 부족하면 자체 기초지수 추세로 대체합니다. 해외·시장대표형은 전일 값을
              사용하며, 환경 원점수 × 15%를 반영합니다.
            </dd>
          </div>
        </dl>
      </section>
      <section className="rounded-lg border bg-card p-4 space-y-3" aria-label="신규 매수 수량 계산">
        <h2 className="font-semibold">신규 매수 계획</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor="etf-equity">ETF 운용 총자산(원)</Label>
            <Input
              id="etf-equity"
              type="number"
              min="0"
              value={equity}
              onChange={(e) => setEquity(e.target.value)}
              placeholder="보유 ETF 평가액 + 현금"
            />
          </div>
          <div>
            <Label htmlFor="etf-cash">가용현금(원)</Label>
            <Input
              id="etf-cash"
              type="number"
              min="0"
              value={cash}
              onChange={(e) => setCash(e.target.value)}
              placeholder="실제 주문 가능 금액"
            />
          </div>
          <div>
            <Label htmlFor="etf-held">기보유 ETF 코드</Label>
            <Input
              id="etf-held"
              value={held}
              onChange={(e) => setHeld(e.target.value)}
              placeholder="예: 069500, 360750"
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          기보유 {heldSymbols.length}/10 · 신규 계획 {orders.length}종목 · 비용 포함 예상 사용액{" "}
          {num(
            orders.reduce((s, o) => s + o.estimatedCost, 0),
            0,
          )}
          원. 종목코드 순서로 배정하며 화면 검색·필터는 배정 순서에 영향을 주지 않습니다.
        </p>
        {!validAccount && (
          <p className="text-sm">
            총자산과 가용현금을 입력해 주세요. 현금은 총자산을 초과할 수 없습니다.
          </p>
        )}
        {heldSymbols.length >= 10 && (
          <p className="text-sm">
            보유 한도에 도달했습니다. 청산 체결 후 보유 코드와 가용현금을 갱신해 주세요.
          </p>
        )}
        {exits.length > 0 && (
          <p className="text-sm font-medium">
            보유 ETF 청산·데이터 점검:{" "}
            {exits
              .map(
                (r) =>
                  `${r.instrument.name} (${r.etfStrategy?.exit === "MA60" ? "MA60 하회" : "기초지수 데이터 오류"})`,
              )
              .join(", ")}
            . 청산 전 예상 매도대금은 신규 매수 재원에 포함하지 않습니다.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          주문가격 기본값은 기준일 종가로 계산한 추정치입니다. 실제 주문가격으로 수정하면 수량을
          다시 계산합니다. 비용 여유분 편도 0.15% 포함, 소수점 수량 버림. 입력한 보유 종목은 신규
          매수에서 제외합니다.
        </p>
      </section>
      <div className="flex flex-wrap gap-2 items-center">
        <Input
          className="max-w-xs"
          aria-label="ETF 검색"
          placeholder="ETF 이름 / 코드"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          aria-label="ETF 신호 필터"
          className="rounded-md border bg-background p-2 text-sm"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        >
          <option value="equity">계산 가능한 전략 대상</option>
          <option value="entry">신규 Onset</option>
          <option value="exit">보유 ETF 청산·점검</option>
          <option value="missing">대상 제외·데이터 점검</option>
          <option value="all">전체 ETF</option>
        </select>
        <span className="text-sm text-muted-foreground">
          {shown.length}/{rows.length}종목 · 신규 신호{" "}
          {rows.filter((r) => r.etfStrategy?.onset).length}건 · 데이터·대상 점검{" "}
          {rows.filter((r) => !r.etfStrategy?.eligible).length}건
        </span>
      </div>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm whitespace-nowrap">
          <thead className="bg-muted">
            <tr>
              {[
                "종목",
                "M0 / 100",
                "전일 M0",
                "기술 / 62.5",
                "Priority / 7.5",
                "Health / 15",
                "환경 / 15",
                "신호",
                "20일 변동성",
                "신규 비중",
                "주문가격(원)",
                "매수 수량",
                "데이터·환경 근거",
              ].map((h) => (
                <th key={h} className="p-3 text-left">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const s = r.etfStrategy,
                symbol = r.instrument.symbol,
                order = bySymbol.get(symbol);
              const confirmed = s?.version === ETF_POLICY.version;
              const label = !confirmed
                ? "재계산 필요"
                : !s.eligible
                  ? "대상·데이터 점검"
                  : heldSet.has(symbol)
                    ? s.exit === "MA60"
                      ? "다음 시가 청산"
                      : s.exit === "DATA_UNAVAILABLE"
                        ? "데이터 오류 청산 점검"
                        : "보유"
                    : s.onset
                      ? "신규 Onset"
                      : s.exit === "MA60"
                        ? "MA60 하회 · 보유 시 청산"
                        : s.score !== null && s.score >= 80
                          ? "80 이상 유지"
                          : "관찰";
              return (
                <tr key={symbol} className="border-t align-top">
                  <td className="p-3">
                    <Link
                      to="/instrument/$symbol"
                      params={{ symbol }}
                      className="font-medium hover:underline"
                    >
                      {r.instrument.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {symbol} · {s?.region ?? "분류 없음"} · {s?.sector ?? r.instrument.sectorName}
                    </div>
                  </td>
                  <td className="p-3 font-semibold">{num(s?.score)}</td>
                  <td className="p-3">{num(s?.previousScore)}</td>
                  <td className="p-3">{num(s?.technical == null ? null : s.technical * 0.625)}</td>
                  <td className="p-3">{num(s?.priority == null ? null : s.priority * 0.075)}</td>
                  <td className="p-3">{num(s?.health == null ? null : s.health * 0.15)}</td>
                  <td className="p-3">
                    {num(s?.environment == null ? null : s.environment * 0.15)}
                  </td>
                  <td className="p-3">
                    <strong>{label}</strong>
                    <div className="text-xs text-muted-foreground">
                      기초지수 {num(s?.underlyingClose)} / MA60 {num(s?.underlyingMa60)}
                    </div>
                  </td>
                  <td className="p-3">{pct(s?.annualVolatility)}</td>
                  <td className="p-3">{pct(s?.entryWeight)}</td>
                  <td className="p-3">
                    {s?.onset && !heldSet.has(symbol) ? (
                      <Input
                        type="number"
                        min="0"
                        aria-label={`${symbol} 주문가격`}
                        className="w-28"
                        value={prices[symbol] ?? r.snapshot.close}
                        onChange={(e) => setPrices((p) => ({ ...p, [symbol]: e.target.value }))}
                      />
                    ) : (
                      num(r.snapshot.close, 0)
                    )}
                  </td>
                  <td className="p-3">
                    {order
                      ? `${num(order.quantity, 0)}주`
                      : s?.onset && validAccount && !heldSet.has(symbol)
                        ? "0주 · 한도/현금/가격 점검"
                        : "—"}
                  </td>
                  <td className="p-3 whitespace-normal min-w-48 text-xs">
                    {s ? environmentNames[s.environmentSource] : "새 전략 재계산 필요"}
                    {s?.issues.length ? <p>{s.issues.join(" · ")}</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!shown.length && (
          <p className="p-6 text-sm text-muted-foreground">
            표시할 ETF가 없습니다. 전체 또는 데이터 점검 필터에서 입력 상태를 확인해 주세요.
          </p>
        )}
      </div>
    </div>
  );
}
