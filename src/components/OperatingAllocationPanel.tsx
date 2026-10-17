import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { operatingAllocationServer } from "@/lib/operatingAllocation.functions";
import {
  operatingAllocationErrorMessage,
  type OperatingAllocationRequest,
  type OperatingCurrency,
} from "@/lib/operatingAllocation";
import type { OperatingAllocationResponse } from "@/lib/operatingAllocation.server";
import { decimal, format } from "@/lib/ledger/decimal";
import { invalidateActualPositionViews } from "@/lib/dashboardActualRefresh";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

type Write = Exclude<OperatingAllocationRequest, { action: "load" }>;
type Change = Write["change"];
type PreviewRequest = Omit<Extract<Write, { action: "preview" }>, "accessToken">;
const labels = { KR: "한국", ETF: "ETF", US: "미국" } as const;
const money = (value: string | null | undefined) => {
  if (value == null) return "미확정";
  const [whole = "", fraction] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
};
const emptyValues = () => ({
  KR: null as string | null,
  ETF: null as string | null,
  US: null as string | null,
  nativeAmount: "",
  nativeReference: "",
  nativeConfirmedAt: "",
  fundingEventIds: [] as string[],
});
export interface OperatingAllocationCandidate {
  market: "KOSPI" | "KOSDAQ" | "ETF" | "US";
  symbol: string;
  name: string;
  signalOriginDate: string;
  sourceDate: string;
  cashRequired: string | null;
  quantity: string | null;
  status: "ESTIMATED" | "WAITING" | "SKIPPED";
}

export function OperatingAllocationContent({
  data,
  currency = "KRW",
}: {
  data: OperatingAllocationResponse | null;
  currency?: OperatingCurrency;
}) {
  const assets = currency === "KRW" ? (["KR", "ETF"] as const) : (["US"] as const);
  const unit = currency === "KRW" ? "원" : "USD";
  return (
    <div className="space-y-2 text-sm">
      <p className="font-medium">실제 S06 · 한국 40% / ETF 20% / 미국 40%</p>
      <p>계획금액 3,000만원 · 한국 1,200만원 · ETF 600만원 · 미국 1,200만원</p>
      <p className="text-xs">
        한국·미국은 연초 기준 예산, ETF는 신호 확정일 종가의 보유·귀속현금 NAV에 변동성 비중을
        적용합니다.
      </p>
      <p>
        실제 기록상 현금: {money(data?.cash)} {unit}
      </p>
      <p className="text-xs text-muted-foreground">
        기록된 입출금·체결과 현금 귀속을 기준으로 계산한 금액입니다. 실제 주문가능 금액은 증권사에서
        최종 확인하세요.
      </p>
      {!data?.plan ? <p role="status">승인 배분계획 등록 대기</p> : null}
      {data?.availability.status === "RECONCILIATION_REQUIRED" ? (
        <p role="status">
          배분비율은 확정되어 있습니다. 매수·입출금 후 남은 현금의 시장별 귀속만 확인이 필요합니다.
          매수수량 기록은 바로 입력할 수 있습니다.
        </p>
      ) : null}
      {data?.availability.status === "CLAIMS_PENDING" ? (
        <p role="status">시장별 현금 귀속 확인 대기</p>
      ) : null}
      <dl className="grid grid-cols-2 gap-2">
        {assets.map((m) => (
          <div key={m}>
            <dt>{labels[m]} 가용 귀속액</dt>
            <dd>
              {money(data?.availability.available[m])} {unit}
            </dd>
          </div>
        ))}
        <div>
          <dt>미귀속 현금</dt>
          <dd>
            {money(data?.authority?.claims.UNASSIGNED)} {unit}
          </dd>
        </div>
      </dl>
      {currency === "USD" ? (
        data?.usdSizingEvidence ? (
          <p>
            미국 첫해 기준: {money(data.usdSizingEvidence.amountUsd)} USD ÷ 20 ·{" "}
            {data.usdSizingEvidence.effectiveSessionDate} 이후 확정 신호부터
          </p>
        ) : (
          <p role="status">미국 첫해 USD 예산 근거 확인 대기</p>
        )
      ) : null}
      {!!data?.sizingIssues?.length && (
        <p role="alert">
          USD 배정 근거가 변경되었습니다. 입금 내역을 대조하기 전 미국 예산은 보류합니다.
        </p>
      )}
    </div>
  );
}

/** Preview approval is bound to owner, currency, current revision and unedited form generation. */
export function OperatingAllocationPanel({
  editable = false,
  candidate = null,
}: {
  editable?: boolean;
  candidate?: OperatingAllocationCandidate | null;
}) {
  const qc = useQueryClient();
  const [owner, setOwner] = useState<string | null>(null);
  const [currency, setCurrency] = useState<OperatingCurrency>(
    candidate?.market === "US" ? "USD" : "KRW",
  );
  const [values, setValues] = useState(emptyValues);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    owner: string;
    currency: OperatingCurrency;
    epoch: number;
    request: PreviewRequest;
    data: OperatingAllocationResponse;
  } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [mustReload, setMustReload] = useState(false);
  const ownerRef = useRef<string | null>(null),
    currencyRef = useRef<OperatingCurrency>(candidate?.market === "US" ? "USD" : "KRW"),
    epoch = useRef(0),
    lock = useRef<number | null>(null),
    alive = useRef(true),
    operation = useRef(0);
  function clearReview() {
    epoch.current++;
    setPreview(null);
    setConfirmed(false);
  }
  useEffect(() => {
    let events = 0;
    const generation = epoch;
    alive.current = true;
    const apply = (id: string | null) => {
      if (!alive.current || ownerRef.current === id) return;
      const previous = ownerRef.current;
      ownerRef.current = id;
      generation.current++;
      lock.current = null;
      setOwner(id);
      setBusy(false);
      setPreview(null);
      setConfirmed(false);
      setMustReload(false);
      setMessage(null);
      setValues(emptyValues());
      if (previous) qc.removeQueries({ queryKey: ["operating-allocation", previous] });
    };
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      events++;
      apply(session?.user.is_anonymous ? null : (session?.user.id ?? null));
    });
    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!events)
          apply(error || data.session?.user.is_anonymous ? null : (data.session?.user.id ?? null));
      })
      .catch(() => {
        if (!events) apply(null);
      });
    return () => {
      alive.current = false;
      ownerRef.current = null;
      generation.current++;
      subscription.unsubscribe();
    };
  }, [qc]);
  const candidateIdentity = candidate ? JSON.stringify(candidate) : "";
  const candidateCurrency = candidate ? (candidate.market === "US" ? "USD" : "KRW") : null;
  const candidateRef = useRef(candidateIdentity);
  // Invalidate approval immediately when a newer dashboard selection/estimate renders.
  if (candidateRef.current !== candidateIdentity) {
    candidateRef.current = candidateIdentity;
    epoch.current++;
  }
  useEffect(() => {
    clearReview();
    setValues(emptyValues());
    setMessage(null);
    if (candidateCurrency) {
      currencyRef.current = candidateCurrency;
      setCurrency(candidateCurrency);
    }
  }, [candidateIdentity, candidateCurrency]);
  async function token(id: string) {
    const { data, error } = await supabase.auth.getSession();
    if (
      error ||
      !data.session ||
      data.session.user.is_anonymous ||
      data.session.user.id !== id ||
      ownerRef.current !== id
    )
      throw new Error("로그인 소유자 확인 필요");
    return data.session.access_token;
  }
  const query = useQuery({
    queryKey: ["operating-allocation", owner, currency],
    enabled: !!owner,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: async () =>
      operatingAllocationServer({
        data: { action: "load", currency, accessToken: await token(owner!) },
      }),
  });
  const current = (stamp: { owner: string; currency: OperatingCurrency; epoch: number }) =>
    alive.current &&
    ownerRef.current === stamp.owner &&
    currencyRef.current === stamp.currency &&
    epoch.current === stamp.epoch;
  const usable = !!owner && !query.isPending && !query.error && !!query.data;
  const disabled = busy || query.isFetching || !usable || mustReload;
  function edit(update: Partial<ReturnType<typeof emptyValues>>) {
    clearReview();
    setValues((old) => ({ ...old, ...update }));
    setMessage(null);
  }
  async function prepare(change: Change) {
    if (!editable || disabled || !owner || lock.current !== null || query.data?.revision == null)
      return;
    clearReview();
    setMessage(null);
    const stamp = { owner, currency, epoch: epoch.current },
      id = ++operation.current;
    lock.current = id;
    setBusy(true);
    try {
      const request: PreviewRequest = {
        action: "preview",
        currency,
        expectedRevision: query.data.revision,
        requestId: crypto.randomUUID(),
        change,
      };
      const accessToken = await token(owner);
      if (!current(stamp)) return;
      const data = await operatingAllocationServer({ data: { ...request, accessToken } });
      if (request.change.kind === "PIN_SIGNAL_BUDGET") {
        if (!data.reviewFingerprint) throw new Error("예산 검토 근거 미확인");
        request.change = { ...request.change, reviewFingerprint: data.reviewFingerprint };
      }
      if (current(stamp)) setPreview({ ...stamp, request, data });
    } catch (error) {
      if (current(stamp)) setMessage(operatingAllocationErrorMessage(error));
    } finally {
      if (lock.current === id) {
        lock.current = null;
        setBusy(false);
      }
    }
  }
  async function save() {
    if (
      !editable ||
      disabled ||
      !confirmed ||
      !preview ||
      lock.current !== null ||
      !current(preview)
    )
      return;
    if (preview.request.expectedRevision !== query.data?.revision) {
      clearReview();
      setMessage("원장이 변경되었습니다. 새로고침 후 다시 검토하세요.");
      return;
    }
    const reviewed = preview,
      id = ++operation.current;
    lock.current = id;
    setBusy(true);
    setPreview(null);
    setConfirmed(false);
    setMessage(null);
    try {
      const accessToken = await token(reviewed.owner);
      if (!current(reviewed)) return;
      const data = await operatingAllocationServer({
        data: { ...reviewed.request, action: "save", reviewConfirmed: true, accessToken },
      });
      if (alive.current && ownerRef.current === reviewed.owner) {
        qc.setQueryData(["operating-allocation", reviewed.owner, reviewed.currency], data);
        if (current(reviewed)) {
          setMessage("확인한 배정 내역을 저장했습니다.");
          setValues(emptyValues());
        }
        await qc.invalidateQueries({
          queryKey: ["operating-allocation", reviewed.owner],
          refetchType: "active",
        });
        await invalidateActualPositionViews(qc, true);
      }
    } catch (error) {
      if (alive.current && ownerRef.current === reviewed.owner) {
        setMustReload(true);
        setMessage(
          `${operatingAllocationErrorMessage(error)} 저장 여부를 최신 내역에서 확인하세요. 자동 재시도하지 않습니다.`,
        );
      }
    } finally {
      if (lock.current === id) {
        lock.current = null;
        setBusy(false);
      }
    }
  }
  async function refresh() {
    if (!owner || lock.current !== null) return;
    clearReview();
    setMessage(null);
    const stamp = { owner, currency, epoch: epoch.current },
      id = ++operation.current;
    lock.current = id;
    setBusy(true);
    try {
      const result = await query.refetch();
      if (current(stamp)) {
        setMustReload(result.isError);
        if (result.isError) setMessage("최신 배정 내역을 읽지 못했습니다. 다시 조회하세요.");
      }
    } catch {
      if (current(stamp)) {
        setMustReload(true);
        setMessage("최신 배정 내역을 읽지 못했습니다. 다시 조회하세요.");
      }
    } finally {
      if (lock.current === id) {
        lock.current = null;
        setBusy(false);
      }
    }
  }
  function reviewClaims() {
    try {
      if (query.data?.cash == null) throw new Error("현금 미확정");
      const claims = {
        KR:
          currency === "KRW"
            ? format(decimal((values.KR ?? query.data.authority?.claims.KR) || "0"))
            : "0",
        ETF:
          currency === "KRW"
            ? format(decimal((values.ETF ?? query.data.authority?.claims.ETF) || "0"))
            : "0",
        US:
          currency === "USD"
            ? format(decimal((values.US ?? query.data.authority?.claims.US) || "0"))
            : "0",
        UNASSIGNED: "0",
      };
      claims.UNASSIGNED = format(
        decimal(query.data.cash) - decimal(claims.KR) - decimal(claims.ETF) - decimal(claims.US),
      );
      if (Object.values(claims).some((amount) => decimal(amount) < 0n))
        throw new Error("현금 초과");
      void prepare({
        kind: "REVIEW_CLAIMS",
        claims,
      });
    } catch {
      setMessage("실제 현금 안에서 시장 귀속액을 입력하세요.");
    }
  }
  function reviewUsdSizing() {
    try {
      const confirmedAt = new Date(values.nativeConfirmedAt).toISOString();
      void prepare({
        kind: "CONFIRM_USD_SIZING",
        amountUsd: format(decimal(values.nativeAmount)),
        fundingEventIds: values.fundingEventIds,
        confirmedAt,
        reference: values.nativeReference.trim(),
      });
    } catch {
      setMessage("실제 USD 배정금액과 확정시각을 확인하세요.");
    }
  }
  const visiblePreview = preview && current(preview) && usable && !mustReload ? preview : null;
  const pinned = candidate
    ? query.data?.sizing.signalBudgets.find(
        (budget) =>
          budget.security?.symbol === candidate.symbol &&
          budget.security.venue === candidate.market &&
          budget.security.originDate === candidate.signalOriginDate,
      )
    : null;
  const reserved = candidate
    ? query.data?.authority?.reservations.some(
        (reservation) =>
          reservation.security?.symbol === candidate.symbol &&
          reservation.security.venue === candidate.market,
      )
    : false;
  return (
    <section className="my-4 space-y-3 rounded-lg border p-4" aria-label="실제 자산배분">
      <h3 className="font-semibold">실제 자산배분</h3>
      <label>
        현금 통화{" "}
        <select
          aria-label="현금 통화"
          value={currency}
          disabled={busy || !!candidate}
          onChange={(event) => {
            const next = event.target.value as OperatingCurrency;
            currencyRef.current = next;
            clearReview();
            setCurrency(next);
            setValues(emptyValues());
            setMessage(null);
            setMustReload(false);
          }}
        >
          <option value="KRW">원화 · 한국/ETF</option>
          <option value="USD">달러 · 미국</option>
        </select>
      </label>
      {!owner ? (
        <p role="status">로그인 후 실제 배정 내역을 조회합니다.</p>
      ) : query.isPending ? (
        <p role="status">배정·현금을 확인 중입니다.</p>
      ) : query.error ? (
        <p role="alert">{operatingAllocationErrorMessage(query.error)}</p>
      ) : (
        <OperatingAllocationContent data={query.data ?? null} currency={currency} />
      )}
      <Button
        type="button"
        variant="outline"
        disabled={!owner || busy || query.isFetching}
        onClick={() => void refresh()}
      >
        배정 내역 새로고침
      </Button>
      {editable && usable && query.data ? (
        <div className="space-y-3 border-t pt-3">
          {candidate ? (
            <div className="space-y-2 rounded border p-3">
              <p>
                {candidate.name} ({candidate.symbol}) · {candidate.market}
              </p>
              <p className="text-xs">
                원신호 {candidate.signalOriginDate} · 자료 {candidate.sourceDate}
              </p>
              <p>
                종가 기준 예상 {candidate.quantity ?? "미확정"}주 · 비용 포함{" "}
                {money(candidate.cashRequired)} {currency}
              </p>
              <p className="text-xs">
                예산 확정과 현금 예약만 기록합니다. 증권사 주문은 실행하지 않습니다.
              </p>
              {reserved ? (
                <p role="status">기존 미체결 예약 있음 · 아래 예약 해제 목록에서 확인하세요.</p>
              ) : (
                <Button
                  type="button"
                  disabled={
                    disabled ||
                    !query.data.plan ||
                    (!!pinned &&
                      (candidate.status !== "ESTIMATED" ||
                        candidate.cashRequired === null ||
                        query.data.availability.status !== "CONFIRMED_CASH"))
                  }
                  onClick={() => {
                    if (!pinned)
                      void prepare({
                        kind: "PIN_SIGNAL_BUDGET",
                        market: candidate.market,
                        symbol: candidate.symbol,
                        signalOriginDate: candidate.signalOriginDate,
                        sourceDate: candidate.sourceDate,
                      });
                    else if (
                      candidate.cashRequired !== null &&
                      query.data.availability.status === "CONFIRMED_CASH"
                    )
                      void prepare({
                        kind: "RESERVE",
                        reservation: {
                          id: crypto.randomUUID(),
                          signalId: pinned.id,
                          signalBudgetId: pinned.id,
                          market: pinned.market,
                          currency: pinned.currency,
                          amount: candidate.cashRequired,
                        },
                      });
                  }}
                >
                  {pinned
                    ? query.data.availability.status === "CONFIRMED_CASH"
                      ? "후보 현금 예약 검토"
                      : "예상 수량 · 현금 예약 보류"
                    : "후보 예산 확정 검토"}
                </Button>
              )}
            </div>
          ) : null}
          {!query.data.plan && currency === "KRW" ? (
            <Button
              type="button"
              disabled={disabled || query.data.revision === null}
              onClick={() => void prepare({ kind: "CONFIRM_PLAN" })}
            >
              승인한 40/20/40 배분 검토
            </Button>
          ) : null}
          {query.data.plan ? (
            <details className="rounded border p-3">
              <summary className="cursor-pointer font-medium">
                남은 현금 귀속 조정 (필요할 때만)
              </summary>
              <fieldset
                disabled={disabled || query.data.cash === null}
                className="min-w-0 space-y-4"
              >
                <legend className="font-medium">실제 현금 귀속 대조</legend>
                <p className="text-sm text-muted-foreground">
                  각 시장에 배정할 최종 귀속액을 직접 입력하세요. 추가 입금액이 아닌 총액이며,
                  빈칸은 0으로 검토합니다. 입력 후 검토 내용을 확인하고 저장하세요.
                </p>
                <p className="text-sm">
                  기록상 현금 {money(query.data.cash)} {currency === "KRW" ? "원" : "USD"}
                  {" · "}현재 미귀속 {money(query.data.authority?.claims.UNASSIGNED)}{" "}
                  {currency === "KRW" ? "원" : "USD"}
                </p>
                <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                  {(currency === "KRW" ? (["KR", "ETF"] as const) : (["US"] as const)).map((m) => (
                    <label key={m} className="block min-w-0 space-y-1.5">
                      <span>
                        {labels[m]} 귀속액 ({currency === "KRW" ? "원" : "USD"})
                      </span>
                      <Input
                        aria-label={`${labels[m]} 귀속액`}
                        inputMode="decimal"
                        placeholder="0"
                        className="h-11 border-slate-400 bg-background text-base text-foreground dark:border-slate-500"
                        value={values[m] ?? query.data.authority?.claims[m] ?? ""}
                        onChange={(event) => edit({ [m]: event.target.value })}
                      />
                      <span className="block text-xs text-muted-foreground">
                        현재 귀속 {money(query.data.authority?.claims[m])}{" "}
                        {currency === "KRW" ? "원" : "USD"}
                      </span>
                    </label>
                  ))}
                </div>
                <p className="text-xs">
                  남는 실제 현금은 미귀속으로 보존합니다. 체결된 예약은 해제한 뒤 귀속액을 다시
                  대조하세요. 귀속액 검토만으로는 저장되지 않습니다.
                </p>
                <Button
                  type="button"
                  disabled={disabled || query.data.cash === null}
                  onClick={reviewClaims}
                >
                  귀속액 검토
                </Button>
              </fieldset>
            </details>
          ) : null}
          {currency === "USD" && query.data.plan && !query.data.usdSizingEvidence ? (
            <fieldset disabled={disabled || query.data.cash === null} className="space-y-2">
              <legend>미국 첫해 USD 예산 근거</legend>
              <p className="text-xs">
                기록된 실제 USD 입금을 선택하고 미국에 배정한 금액을 확인하세요. 등록 후 첫 미국
                거래일부터 새 신호 예산에 적용하며 실제 잔고는 바뀌지 않습니다.
              </p>
              {(query.data.fundingSources ?? []).map((source) => (
                <label key={source.id} className="block">
                  <input
                    type="checkbox"
                    aria-label={`USD 입금 ${source.id}`}
                    checked={values.fundingEventIds.includes(source.id)}
                    onChange={(event) =>
                      edit({
                        fundingEventIds: event.target.checked
                          ? [...values.fundingEventIds, source.id]
                          : values.fundingEventIds.filter((id) => id !== source.id),
                      })
                    }
                  />{" "}
                  {source.date} · {money(source.amount)} USD · {source.reference}
                </label>
              ))}
              <label className="block">
                미국 배정금액(USD){" "}
                <input
                  aria-label="미국 배정금액 USD"
                  inputMode="decimal"
                  value={values.nativeAmount}
                  onChange={(event) => edit({ nativeAmount: event.target.value })}
                />
              </label>
              <label className="block">
                배정 확정시각(기기 현지시간){" "}
                <input
                  aria-label="배정 확정시각"
                  type="datetime-local"
                  value={values.nativeConfirmedAt}
                  onChange={(event) => edit({ nativeConfirmedAt: event.target.value })}
                />
              </label>
              <label className="block">
                USD 배정 증빙 식별자{" "}
                <input
                  aria-label="USD 배정 증빙 식별자"
                  value={values.nativeReference}
                  onChange={(event) => edit({ nativeReference: event.target.value })}
                />
              </label>
              <Button
                type="button"
                disabled={
                  disabled ||
                  query.data.cash === null ||
                  !values.fundingEventIds.length ||
                  !values.nativeAmount ||
                  !values.nativeConfirmedAt ||
                  !values.nativeReference.trim()
                }
                onClick={reviewUsdSizing}
              >
                USD 예산 근거 검토
              </Button>
            </fieldset>
          ) : null}
          {query.data.authority?.reservations.map((reservation) => (
            <div key={reservation.id} className="text-xs">
              {reservation.security
                ? `${reservation.security.symbol} · 원신호 ${reservation.security.originDate} · `
                : "종목 근거 확인 필요 · "}
              {labels[reservation.market]} 예약 {money(reservation.amount)} {reservation.currency} ·{" "}
              {reservation.id}{" "}
              <Button
                type="button"
                disabled={disabled}
                variant="outline"
                onClick={() => void prepare({ kind: "RELEASE", reservationId: reservation.id })}
              >
                예약 해제 검토
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {visiblePreview ? (
        <div className="space-y-2 rounded border p-3">
          <h4>저장 전 검토</h4>
          {visiblePreview.request.change.kind === "RELEASE" ? (
            <p>해제할 예약: {visiblePreview.request.change.reservationId}</p>
          ) : null}
          {visiblePreview.request.change.kind === "PIN_SIGNAL_BUDGET" ? (
            <p>
              확정할 신호 예산: {candidate?.name} · 원신호{" "}
              {visiblePreview.request.change.signalOriginDate}
            </p>
          ) : null}
          {visiblePreview.request.change.kind === "RESERVE" ? (
            <p>
              예약할 현금: {candidate?.name} ·{" "}
              {money(visiblePreview.request.change.reservation.amount)} {visiblePreview.currency}
            </p>
          ) : null}
          <OperatingAllocationContent
            data={visiblePreview.data}
            currency={visiblePreview.currency}
          />
          <label className="block">
            <input
              type="checkbox"
              aria-label="저장 내용 확인"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />{" "}
            표시된 통화·배정·예약 변경을 확인했습니다.
          </label>
          <Button type="button" disabled={disabled || !confirmed} onClick={() => void save()}>
            검토한 내용 저장
          </Button>
          <Button type="button" disabled={busy} variant="outline" onClick={() => clearReview()}>
            검토 취소
          </Button>
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
