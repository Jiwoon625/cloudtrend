import { NavSeriesLegend } from "@/components/NavSeriesLegend";
import { navSeriesStyle } from "@/lib/navSeries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { loadKospiShadow } from "@/lib/kospiShadowCloud";
import { KOSPI_SHADOW_POLICY, type ShadowDaily } from "@/lib/engine/kospiShadow";
import type { KospiShadowView } from "@/lib/kospiShadowStore";
import { Button } from "./ui/button";
import { Badge } from "./ui/badge";
const pct = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(2)}%` : "-";
const krw = (v: number | null | undefined) =>
  typeof v === "number" ? `${Math.round(v).toLocaleString("ko-KR")}원` : "-";
const regime = (v: string) =>
  ({ RISK_ON: "호황", NEUTRAL: "중립", RISK_OFF: "불황", UNKNOWN: "자료 미확인" })[v] ?? v;
const status = (v: string) =>
  ({
    AWAITING_CONFIRMATION: "다음 거래일 확인 대기",
    MODEL_ENTRY_PENDING: "다음 시가 모델 진입 대기",
    EXCLUDED: "제외",
    MODEL_FILLED: "모델 체결",
  })[v] ?? v;
const reason = (v: string) =>
  ({
    NEXT_KOSPI_SESSION_CLOSE: "다음 KOSPI 거래일 종가 확인",
    MODEL_ONLY_NEXT_SESSION_OPEN: "모델 기록만 · 다음 거래일 시가",
    ONSET_REGIME_UNOBSERVABLE: "발생일 국면 자료 미확인",
    CONFIRMATION_SCORE_MISSING: "확인일 점수 미확인",
    CONFIRMATION_SCORE_BELOW_8: "확인일 8점 미만",
    COMMON_HISTORY_OR_SIGNAL_OPEN_INELIGIBLE: "공통 이력 또는 확인일 시가 미충족",
    BEAR_CONFIRMATION_RSACCEL_MISSING: "불황 확인일 RSAccel 미확인",
    BEAR_CONFIRMATION_RSACCEL_NONPOSITIVE: "불황 확인일 RSAccel 0 이하",
    HELD_UP95_EXCEPTION_BLOCKED: "기보유 UP95 청산 우선",
    ALREADY_HELD: "이미 모델 보유",
    POSITION_CAP: "30종목 한도",
    SECTOR_CAP: "섹터 3종목 한도",
    NO_EXECUTABLE_OPEN_NO_LATE_RETRY: "체결 가능한 시가 없음 · 재시도 없음",
    INSUFFICIENT_MODEL_CASH: "모델 현금 부족",
    CONFIRMED_RESEARCH_ENTRY: "연구 규칙 확인 후 모델 진입",
    H60_CLOSE: "60거래일 종가 청산",
    H60_DEFERRED_OPEN: "60거래일 거래정지 후 시가 청산",
    UP95: "9.5점 상향돌파 청산",
  })[v] ?? v;
export function KospiShadowPanel({
  fromDate = "",
  toDate = "",
}: {
  fromDate?: string;
  toDate?: string;
}) {
  const query = useQuery({
      queryKey: ["kospi-prospective-shadow"],
      queryFn: loadKospiShadow,
      staleTime: 60_000,
    }),
    qc = useQueryClient();
  return (
    <KospiShadowContent
      view={query.data ?? null}
      loading={query.isPending}
      error={query.error?.message ?? null}
      fromDate={fromDate}
      toDate={toDate}
      refresh={() => void qc.invalidateQueries({ queryKey: ["kospi-prospective-shadow"] })}
    />
  );
}
export function KospiShadowContent({
  view,
  loading,
  error,
  fromDate,
  toDate,
  refresh,
}: {
  view: KospiShadowView | null;
  loading: boolean;
  error: string | null;
  fromDate: string;
  toDate: string;
  refresh: () => void;
}) {
  const snapshot = view?.latest,
    daily = snapshot?.daily,
    state = snapshot?.state;
  const within = (date: string) => (!fromDate || date >= fromDate) && (!toDate || date <= toDate);
  const history = (view?.history ?? []).filter((d) => within(d.date)),
    trades = (view?.recentTrades ?? [])
      .filter((t) => within(t.executionDate))
      .slice()
      .reverse();
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{KOSPI_SHADOW_POLICY.label}</h2>
          <Badge variant="outline">SHADOW · KRW · 연구 관찰</Badge>
        </div>
        <Button variant="outline" onClick={refresh}>
          새로고침
        </Button>
      </header>
      <p className="rounded-lg border bg-card p-3 text-sm leading-relaxed">
        원래 8점 돌파일의 국면을 고정하고 다음 거래일 종가 8점 이상을 확인합니다. 호황·중립은 RS
        조건 없이, 불황은 확인일 RSAccel &gt; 0일 때만 모델 진입합니다. 신규 미보유 종목의 확인일
        UP95는 허용합니다. 기존 보유의 UP95·H60 청산과 DX 없음은 유지합니다.
      </p>
      <p className="text-xs text-muted-foreground">
        실제 매수 가능 신호·실거래·실제 투자금과 분리된 가상 원장입니다. 최초 기록일에는 현금 기준만
        저장하며 이전 거래를 재구성하지 않습니다. 국면 자료 미확인 시 해당 발생 건은 제외됩니다.
        기준 종가와 시가를 이용한 모델 성과이며, 기업행동 권리·실제 체결 가능성을 보증하지 않습니다.
      </p>
      {loading && <p role="status">KOSPI Shadow 기록을 불러오는 중입니다.</p>}
      {error && (
        <p role="alert" className="rounded border border-destructive p-3">
          Shadow 기록을 불러오지 못했습니다: {error}
        </p>
      )}
      {!loading && !error && !view && (
        <p className="rounded-lg border p-5">
          아직 확정된 KOSPI Shadow 기록이 없습니다. 도입일 이후 첫 장 마감 자료가 저장되면 1억원의
          독립 가상 자금으로 관찰을 시작합니다. 과거 연구 수익률을 여기에 채우지 않습니다.
        </p>
      )}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["최신 기준일", daily?.date ?? "-"],
          ["기록 시작일", view?.registry.initializedDate ?? "미시작"],
          ["모델 NAV · KRW", krw(daily?.navKrw)],
          ["현금 · KRW", krw(daily?.cashKrw)],
          ["시작 이후 누적수익률", pct(daily?.cumulativeReturn)],
          ["CAGR · 252거래일 연율", pct(daily?.cagr)],
          ["최대낙폭 MDD", pct(daily?.mdd)],
          ["평균 노출도", pct(daily?.averageExposure)],
          ["현재 노출도", pct(daily?.exposure)],
          ["모델 보유", `${daily?.positions ?? 0} / 30종목`],
          ["누적 모델 비용", krw(state?.totalFeesKrw)],
          ["모델 진입 / 청산", `${state?.totalEntries ?? 0} / ${state?.totalClosedTrades ?? 0}건`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 text-lg font-semibold">{value}</p>
          </div>
        ))}
      </section>
      <p className="text-xs text-muted-foreground">
        30종목 · 섹터 최대 3종목 · 전일 종가 NAV ÷ 30 배분 · 정수 수량 · 왕복 비용 0.30% (편도
        0.15%) · 시가 미체결 신규 진입은 지연 재시도하지 않음. CAGR은 짧은 관찰 기간에서 과장될 수
        있습니다. 요약·보유·확인 기록은 최신일, 날짜 필터는 NAV와 모델 체결에 적용됩니다.
      </p>
      {!!daily?.staleMarks.length && (
        <p role="alert" className="rounded border border-amber-500 p-3 text-sm">
          가격 미갱신 보유: {daily.staleMarks.join(", ")} · 직전 유효 평가가를 유지하여 NAV를
          계산했습니다.
        </p>
      )}
      <section className="rounded-lg border bg-card p-4">
        <h3 className="font-semibold">NAV 추이 · KRW</h3>
        <ShadowNavChart rows={history} />
        <p className="text-xs text-muted-foreground">
          모델 NAV / 동일 시작일 KOSPI 가격지수 기준 · 배당 미포함
        </p>
      </section>
      <section className="overflow-x-auto rounded-lg border bg-card p-4">
        <h3 className="mb-3 font-semibold">최신 모델 보유</h3>
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th>종목</th>
              <th>섹터</th>
              <th>모델 수량</th>
              <th>평가가 · KRW</th>
              <th>진입일</th>
              <th>발생일 고정 국면</th>
              <th>보유 거래일</th>
            </tr>
          </thead>
          <tbody>
            {Object.values(state?.positions ?? {}).map((p) => (
              <tr key={p.symbol} className="border-t text-center [&>td]:p-2">
                <td>
                  {p.name} ({p.symbol})
                </td>
                <td>{p.sector}</td>
                <td>{p.shares}</td>
                <td>{krw(p.lastPrice)}</td>
                <td>{p.entryDate}</td>
                <td>{regime(p.candidate.onsetRegime)}</td>
                <td>{p.heldSessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!Object.keys(state?.positions ?? {}).length && (
          <p className="p-4 text-sm text-muted-foreground">모델 보유가 없습니다.</p>
        )}
      </section>
      <section className="overflow-x-auto rounded-lg border bg-card p-4">
        <h3 className="mb-3 font-semibold">최신 Shadow 확인 기록</h3>
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th>종목</th>
              <th>원래 발생일</th>
              <th>고정 국면</th>
              <th>확인일</th>
              <th>RSAccel</th>
              <th>상태</th>
              <th>근거</th>
            </tr>
          </thead>
          <tbody>
            {(snapshot?.candidates ?? []).map((c, i) => (
              <tr key={`${c.key}-${i}`} className="border-t text-center [&>td]:p-2">
                <td>{c.name}</td>
                <td>{c.originDate}</td>
                <td>{regime(c.onsetRegime)}</td>
                <td>{c.confirmationDate ?? "-"}</td>
                <td>{c.confirmationRsAccel?.toFixed(2) ?? "-"}</td>
                <td>{status(c.status)}</td>
                <td>{reason(c.reason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!snapshot?.candidates.length && (
          <p className="p-4 text-sm text-muted-foreground">
            이 기준일의 신규 확인 기록이 없습니다.
          </p>
        )}
      </section>
      <section className="overflow-x-auto rounded-lg border bg-card p-4">
        <h3 className="mb-3 font-semibold">모델 체결 원장 · KRW</h3>
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th>모델 체결일</th>
              <th>종목</th>
              <th>방향</th>
              <th>수량</th>
              <th>모델 가격</th>
              <th>비용</th>
              <th>근거</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.key} className="border-t text-center [&>td]:p-2">
                <td>{t.executionDate}</td>
                <td>{t.name}</td>
                <td>{t.side === "BUY" ? "모델 매수" : "모델 매도"}</td>
                <td>{t.shares}</td>
                <td>{krw(t.price)}</td>
                <td>{krw(t.feeKrw)}</td>
                <td>{reason(t.reason)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!trades.length && (
          <p className="p-4 text-sm text-muted-foreground">선택한 기간의 모델 체결이 없습니다.</p>
        )}
        {view?.tradeHistoryTruncated && (
          <p className="text-xs">
            최근 1,000건을 표시합니다. 전체 기록은 변경 불가 일별 원장에 유지됩니다.
          </p>
        )}
      </section>
      <details className="rounded border p-3 text-xs">
        <summary>규칙·원천 버전</summary>
        <p className="mt-2 break-all">
          규칙: {KOSPI_SHADOW_POLICY.version}
          <br />
          입력: {snapshot?.source.sourceHash ?? "미시작"}
          <br />
          코드: {snapshot?.source.codeVersion ?? "미시작"}
          <br />
          설정: {snapshot?.source.configHash ?? "미시작"}
          <br />
          원천 등록: {snapshot?.source.sourceCollectedAt ?? "미시작"}
        </p>
      </details>
    </div>
  );
}
export function ShadowNavChart({ rows }: { rows: ShadowDaily[] }) {
  if (rows.length < 2)
    return (
      <div>
        <p className="p-6 text-sm text-muted-foreground">
          선택한 기간에 2거래일 이상 기록이 쌓이면 추이를 표시합니다.
        </p>
        <NavSeriesLegend
          series={[
            { id: "KOSPI_SHADOW", label: "KOSPI Shadow", status: "추이 대기" },
            { id: "KOSPI_BENCHMARK", label: "KOSPI 가격지수", status: "추이 대기" },
          ]}
        />
      </div>
    );
  const values = rows.flatMap((r) => [r.navKrw, r.benchmarkNavKrw]),
    min = Math.min(...values),
    max = Math.max(...values),
    y = (v: number) => (max === min ? 100 : 180 - ((v - min) / (max - min)) * 160);
  const points = (key: "navKrw" | "benchmarkNavKrw") =>
    rows.map((r, i) => `${20 + (i / (rows.length - 1)) * 960},${y(r[key])}`).join(" ");
  return (
    <>
      <svg
        role="img"
        aria-label="KOSPI Shadow와 KOSPI 가격지수 NAV 추이"
        viewBox="0 0 1000 200"
        preserveAspectRatio="none"
        className="h-52 w-full"
      >
        <polyline
          fill="none"
          stroke={navSeriesStyle("KOSPI_SHADOW").color}
          strokeWidth="2.5"
          vectorEffect="non-scaling-stroke"
          points={points("navKrw")}
        />
        <polyline
          fill="none"
          stroke={navSeriesStyle("KOSPI_BENCHMARK").color}
          strokeWidth="2"
          strokeDasharray={navSeriesStyle("KOSPI_BENCHMARK").dash}
          vectorEffect="non-scaling-stroke"
          points={points("benchmarkNavKrw")}
        />
      </svg>
      <p className="flex justify-between text-xs">
        <span>{rows[0]!.date}</span>
        <span>{rows.at(-1)!.date}</span>
      </p>
      <NavSeriesLegend
        series={[
          { id: "KOSPI_SHADOW", label: "KOSPI Shadow" },
          { id: "KOSPI_BENCHMARK", label: "KOSPI 가격지수" },
        ]}
      />
    </>
  );
}
