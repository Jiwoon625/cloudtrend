import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { octoberShadowSummaryServer } from "@/lib/octoberShadowSummary.functions";
import type {
  OctoberShadowBookSummary,
  OctoberShadowSummary as Summary,
} from "@/lib/octoberShadowSummary.server";
import { UsTaxEstimatePanel } from "./UsTaxEstimatePanel";
import { UsA0AllocationRules } from "./UsA0AllocationRules";

const labels: Record<OctoberShadowBookSummary["kind"], string> = {
  KR_MIXED: "한국 혼합",
  KR_KOSPI: "KOSPI",
  KR_KOSDAQ: "KOSDAQ 현행전략 · 독립 Shadow",
  US_A0: "미국 A0 고정예산",
  ETF_V02: "ETF v0.2",
  US_A2: "미국 A2 고정예산",
  US_B3: "미국 B3 Beta · 고정예산",
  KR_KOSPI_CONFIRM1_BEAR: "KOSPI 하루확인·불황 시 RSAccel 필터",
};
const states: Record<OctoberShadowBookSummary["status"], string> = {
  NOT_INITIALIZED: "등록 대기",
  INITIALIZED_WAITING: "초기화 완료 · 첫 실제 세션 대기",
  RECORDED: "실제 세션 기록 연결됨",
  UNAVAILABLE: "자료 확인 필요",
};
const replayStateLabel = (status: Summary["replayStatus"][number]["status"]) =>
  status === "WAITING_INPUT"
    ? "자료 대기"
    : status === "FAILED"
      ? "계산 실패"
      : status === "REUSED"
        ? "기존 기록 재사용"
        : "기록 완료";

const money = (value: string | null, currency: "KRW" | "USD", residual = false) =>
  value === null
    ? "미확인"
    : `${currency === "USD" ? "$" : ""}${Number(value).toLocaleString(
        currency === "USD" ? "en-US" : "ko-KR",
        {
          minimumFractionDigits: currency === "USD" ? 2 : 0,
          maximumFractionDigits: residual ? 3 : currency === "USD" ? 2 : 0,
        },
      )}${currency === "KRW" ? "원" : ""}`;

export function OctoberShadowSummary() {
  const [owner, setOwner] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let authEvents = 0;
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (active) {
        authEvents++;
        setOwner(session?.user.id ?? null);
        setAuthError(session ? null : "신규 Shadow 조회를 위해 로그인 세션을 확인해 주세요.");
      }
    });
    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!active || authEvents > 0) return;
        if (error || !data.session)
          setAuthError("신규 Shadow 조회를 위해 로그인 세션을 확인해 주세요.");
        else setOwner(data.session.user.id);
      })
      .catch(() => {
        if (active && authEvents === 0)
          setAuthError("신규 Shadow 로그인 세션을 불러오지 못했습니다.");
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);
  const query = useQuery({
    queryKey: ["october-shadow-summary", owner],
    enabled: !!owner,
    staleTime: 60_000,
    gcTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const { data, error } = await supabase.auth.getSession();
      if (error || !data.session || data.session.user.id !== owner)
        throw new Error("로그인 소유자 확인 필요");
      return octoberShadowSummaryServer({ data: { accessToken: data.session.access_token } });
    },
  });
  return (
    <OctoberShadowSummaryContent
      summary={owner ? (query.data ?? null) : null}
      loading={!authError && query.isPending}
      refreshing={query.isFetching}
      error={authError ?? query.error?.message ?? null}
      refresh={() => void query.refetch()}
    />
  );
}

export function OctoberShadowSummaryContent({
  summary,
  loading,
  refreshing = false,
  error,
  refresh,
}: {
  summary: Summary | null;
  loading: boolean;
  refreshing?: boolean;
  error: string | null;
  refresh: () => void;
}) {
  return (
    <section
      aria-labelledby="october-shadow-title"
      className="min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="october-shadow-title" className="text-lg font-semibold">
            2026-10-05 신규 Shadow · 독립 장부
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            장부당 시작자본 1억원 · 기존 연구 이력과 분리 · 읽기 전용
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing || loading}
          className="rounded border px-3 py-2 text-sm disabled:opacity-50"
        >
          신규 장부 새로고침
        </button>
      </header>
      <p className="text-xs leading-relaxed text-muted-foreground">
        초기화는 거래일 기록이 아닙니다. 최초·최근 세션은 정규장 데이터가 저장된 후 표시합니다. 실제
        계좌·주문과 연결되지 않는 비교 모델이며, KRW와 USD는 합산하지 않습니다.
      </p>
      {loading ? (
        <p role="status" className="text-sm">
          신규 Shadow 등록정보와 세션을 확인 중입니다.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <p className="rounded border border-amber-500/30 bg-amber-500/5 p-3 text-xs leading-relaxed">
        거래일 달력은 2026-12-31까지 확인했습니다. 한국 2026-11-19 특별 거래시간은 거래소 공지 확인
        대기이며, 해당일 기록 전에 보완해야 합니다. 이후 거래일도 공식 달력을 확인해 연장하며,
        확인되지 않은 날짜는 기록을 건너뛰지 않고 중단합니다.
      </p>
      {summary?.replayStatus.length ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {summary.replayStatus.map((replay) => (
            <div key={replay.market} className="space-y-1 rounded-lg border p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <strong>{replay.market === "KR" ? "한국 Shadow replay" : "미국 Shadow replay"}</strong>
                <span>{replayStateLabel(replay.status)}</span>
              </div>
              <p className="text-muted-foreground">
                신호 기준일 {replay.signalDate} · 실제 계산{" "}
                {new Date(replay.calculatedAt).toLocaleString("ko-KR")}
              </p>
              <p className="text-muted-foreground">
                {replay.replayMode === "RETROSPECTIVE"
                  ? "사후 복원 계산"
                  : "다음 거래일 체결 전에 계산"}
                {replay.executionAt
                  ? ` · 다음 체결시각 ${new Date(replay.executionAt).toLocaleString("ko-KR")}`
                  : ""}
              </p>
              {replay.reason ? (
                <p role="status" className="text-warn">
                  보류 사유: {replay.reason}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {summary ? (
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          {summary.books.map((book) => (
            <article key={book.bookId} className="min-w-0 space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="min-w-0 break-words font-semibold">{labels[book.kind]}</h3>
                <span className="text-xs text-muted-foreground">
                  {book.role === "ALTERNATIVE_SHADOW" ? "대안 비교" : "채택 전략 비교"} ·{" "}
                  {book.currency}
                </span>
              </div>
              <p role="status" className="text-sm">
                {states[book.status]}
              </p>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                <dt className="text-muted-foreground">예정 회계 시작</dt>
                <dd>{book.scheduledStart}</dd>
                <dt className="text-muted-foreground">최초 실제 기록 세션</dt>
                <dd>{book.firstSessionDate ?? "아직 없음"}</dd>
                <dt className="text-muted-foreground">최근 기록 세션</dt>
                <dd>{book.latestSessionDate ?? "아직 없음"}</dd>
                <dt className="text-muted-foreground">초기 모델 현금</dt>
                <dd>{money(book.initialCapital, book.currency)}</dd>
                <dt className="text-muted-foreground">현재 모델 현금</dt>
                <dd>{money(book.cash, book.currency)}</dd>
                <dt className="text-muted-foreground">기록 세전 NAV</dt>
                <dd>
                  {book.status === "INITIALIZED_WAITING"
                    ? "첫 세션 대기"
                    : money(book.nav, book.currency)}
                </dd>
                <dt className="text-muted-foreground">독립 모델 누적수익률</dt>
                <dd>
                  {book.returnPercent === null
                    ? "첫 세션 대기"
                    : `${book.returnPercent.toFixed(2)}%`}
                </dd>
                <dt className="text-muted-foreground">보유 / 대기 신호</dt>
                <dd>
                  {book.positions ?? "미확인"} / {book.pending ?? "미확인"}
                </dd>
                {book.residualKrw !== null ? (
                  <>
                    <dt className="text-muted-foreground">별도 KRW 잔액</dt>
                    <dd>{money(book.residualKrw, "KRW", true)}</dd>
                  </>
                ) : null}
              </dl>
              <div className="space-y-2 border-t pt-3">
                <h4 className="text-sm font-medium">모델 보유종목</h4>
                {book.holdings.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr>
                          <th>종목</th>
                          <th className="text-right">수량</th>
                          <th className="text-right">평가가격</th>
                          <th className="text-right">평가금액</th>
                          <th>편입일</th>
                        </tr>
                      </thead>
                      <tbody>
                        {book.holdings.map((holding) => (
                          <tr key={holding.symbol} className="border-t">
                            <td className="py-2">
                              {holding.name}
                              <span className="block text-muted-foreground">{holding.symbol}</span>
                            </td>
                            <td className="text-right">
                              {Number(holding.quantity).toLocaleString()}
                            </td>
                            <td className="text-right">{money(holding.price, book.currency)}</td>
                            <td className="text-right">{money(holding.value, book.currency)}</td>
                            <td className="whitespace-nowrap pl-2">{holding.entryDate}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {book.status === "UNAVAILABLE" || book.status === "NOT_INITIALIZED"
                      ? "보유자료 확인 대기"
                      : "모델 보유종목 없음"}
                  </p>
                )}
                {book.currency === "USD" ? (
                  <p className="text-xs text-muted-foreground">
                    10월 5일 신규 장부: 초기자금 ÷ 목표 20종목 고정 매입 예산. 정수
                    수량·현금·비용·거래대금 한도를 적용합니다
                  </p>
                ) : null}
                {book.kind === "US_A0" ? <UsA0AllocationRules /> : null}
                {book.kind === "KR_KOSDAQ" ? (
                  <p className="text-xs text-muted-foreground">
                    실제 매수 여부·수동 제외·실계좌 현금과 분리된 가상 1억원/30 장부입니다. 실제
                    원장과 시작일이 다를 수 있습니다
                  </p>
                ) : null}
              </div>
              {book.valuationStatus === "STALE" || book.valuationStatus === "MISSING" ? (
                <p className="text-xs text-warn">
                  평가가격{" "}
                  {book.valuationStatus === "STALE" ? "일부 이전 시세 포함" : "자료 미확인"}
                </p>
              ) : null}
              {book.warnings.map((warning) => (
                <p key={warning} role="alert" className="text-xs text-destructive">
                  {warning}
                </p>
              ))}
              {book.tax ? (
                <UsTaxEstimatePanel
                  estimate={book.tax}
                  title="신규 Shadow 세금 · 독립 가상 납세자 추정"
                />
              ) : null}
            </article>
          ))}
        </div>
      ) : null}
      <aside
        className="space-y-2 rounded-lg border border-dashed p-4"
        aria-label="자산배분 통합 Shadow 준비 상태"
      >
        <h3 className="font-semibold">자산배분 통합 Shadow</h3>
        <p role="status" className="text-sm">
          배분전략 확정 대기 · CM6
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          가상 총자금 1억원을 한국·미국·ETF·현금에 나누는 별도 통합 장부입니다. 위 8개 독립 장부의
          자금을 합산하지 않습니다. 배분비중과 전략을 확정한 뒤 기록을 시작하며, 현재는
          거래·비중·성과 기록이 없습니다.
        </p>
      </aside>
    </section>
  );
}
