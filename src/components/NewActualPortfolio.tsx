import { actualPriceExitStatus, isActionableActualPriceExit } from "@/lib/newActualPriceExit";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { invalidateActualPositionViews } from "@/lib/dashboardActualRefresh";
import {
  newActualPortfolioServer,
  type NewActualPortfolioResponse,
  type NewActualPortfolioRequest,
} from "@/lib/newActualPortfolio.functions";
import { Button } fr…7603 tokens truncated…    정정
                              </Button>
                            )}
                            {onCancelCash && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={disabled}
                                aria-label={`${ccy} ${event.date} ${cashLabels[event.kind]} 기록 취소`}
                                onClick={() => onCancelCash(ccy, event)}
                              >
                                기록 취소
                              </Button>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </Table>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

type Session = { owner: string; expectedRevision: number; requestId: string; needsReview: boolean };
export type PurchaseRecordCandidate = { symbol: string; name: string; market: Market };
type ExecutionDraft = Session & {
  candidate?: PurchaseRecordCandidate;
  kind: "execution";
  asset: PortfolioAsset;
  id: string;
  symbol: string;
  name: string;
  market: Market;
  side: "BUY" | "SELL";
  date: string;
  price: string;
  shares: string;
  fee: string;
  note: string;
  mixed: boolean;
  originalMixed: boolean;
  quantity: string;
  gross: string;
  allocatedFee: string;
  brokerReference: string;
  confirmed: boolean;
};
type CashDraft = Session & {
  kind: "cash";
  currency: Currency;
  id: string;
  date: string;
  cashKind: CashKind;
  amount: string;
  reference: string;
  confirmed: boolean;
};
type CancelExecutionDraft = Session & {
  kind: "cancelExecution";
  asset: PortfolioAsset;
  executionId: string;
  description: string;
  reason: string;
};
type CancelCashDraft = Session & {
  kind: "cancelCash";
  currency: Currency;
  eventId: string;
  description: string;
  reason: string;
};
type Draft = ExecutionDraft | CashDraft | CancelExecutionDraft | CancelCashDraft;
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
    </label>
  );
}
function ExecutionFields({
  draft,
  onChange,
}: {
  draft: ExecutionDraft;
  onChange: (draft: ExecutionDraft) => void;
}) {
  const patch = (value: Partial<ExecutionDraft>) =>
    onChange({ ...draft, ...value, confirmed: false });
  const ccy = currencyOf(draft.asset);
  return (
    <>
      <p className="text-sm">
        실제 매수·매도한 수량과 체결가격을 직접 입력하세요. 확정된 자금배분을 다시 설정할 필요가
        없습니다.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {draft.candidate ? (
          <div className="rounded bg-muted p-3 sm:col-span-2">
            <p className="font-semibold">
              {draft.name} · {draft.symbol}
            </p>
            <p className="text-xs text-muted-foreground">{draft.market} · 매수 기록</p>
          </div>
        ) : (
          <>
            <Field label="종목코드">
              <Input
                required
                value={draft.symbol}
                disabled={!!draft.id}
                onChange={(e) => patch({ symbol: e.target.value.toUpperCase() })}
              />
            </Field>
            <Field label="종목명">
              <Input
                required
                value={draft.name}
                disabled={draft.originalMixed}
                onChange={(e) => patch({ name: e.target.value })}
              />
            </Field>
            <Field label="시장">
              <select
                className={fieldClass}
                value={draft.market}
                disabled={!!draft.id || draft.asset !== "KR"}
                onChange={(e) => patch({ market: e.target.value as Market })}
              >
                {(draft.asset === "KR"
                  ? ["KOSPI", "KOSDAQ"]
                  : draft.asset === "ETF"
                    ? ["ETF"]
                    : ["US"]
                ).map((market) => (
                  <option key={market}>{market}</option>
                ))}
              </select>
            </Field>
            <Field label="체결 구분">
              <select
                className={fieldClass}
                value={draft.side}
                disabled={draft.originalMixed}
                onChange={(e) => patch({ side: e.target.value as "BUY" | "SELL" })}
              >
                <option value="BUY">매수</option>
                <option value="SELL">매도</option>
              </select>
            </Field>
          </>
        )}
        <Field label="실제 체결일">
          <Input
            type="date"
            required
            min={START_DATE}
            max={newActualMarketDay(ccy)}
            value={draft.date}
            disabled={draft.originalMixed}
            onChange={(e) => patch({ date: e.target.value })}
          />
        </Field>
        <Field label={`${draft.candidate ? "실제 매수가" : "실제 체결가격"} (${ccy})`}>
          <Input
            type="number"
            required
            min="0.00000001"
            step="0.00000001"
            value={draft.price}
            disabled={draft.originalMixed}
            onChange={(e) => patch({ price: e.target.value })}
          />
        </Field>
        <Field label={draft.candidate ? "실제 매수수량 (주)" : "실제 체결수량 (정수)"}>
          <Input
            type="number"
            required
            min="1"
            step="1"
            value={draft.shares}
            disabled={draft.originalMixed}
            onChange={(e) => patch({ shares: e.target.value })}
          />
        </Field>
        <Field label={`${draft.candidate ? "수수료·세금" : "수수료·세금 합계"} (${ccy})`}>
          <Input
            type="number"
            required
            min="0"
            step="0.00000001"
            value={draft.fee}
            disabled={draft.originalMixed}
            onChange={(e) => patch({ fee: e.target.value })}
          />
        </Field>
      </div>
      <details
        open={draft.mixed || draft.originalMixed || undefined}
        className="rounded border p-3"
      >
        <summary className="cursor-pointer text-sm">일부 수량만 배정하는 경우</summary>
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.mixed}
              disabled={draft.originalMixed}
              onChange={(e) => patch({ mixed: e.target.checked })}
            />
            혼합 체결 (일부 수량만 배정)
          </label>
          {draft.originalMixed && (
            <p className="rounded border p-3 text-xs text-muted-foreground">
              혼합 체결은 배정 수량·금액·비용과 메모만 정정할 수 있습니다.
            </p>
          )}
          {draft.mixed ? (
            <div className="grid gap-3 rounded border p-3 sm:grid-cols-3">
              <Field label="배정 수량">
                <Input
                  type="number"
                  required
                  min="1"
                  step="1"
                  value={draft.quantity}
                  onChange={(e) => patch({ quantity: e.target.value })}
                />
              </Field>
              <Field label={`배정 금액 (${ccy})`}>
                <Input
                  type="number"
                  required
                  min="0.00000001"
                  step="0.00000001"
                  value={draft.gross}
                  onChange={(e) => patch({ gross: e.target.value })}
                />
              </Field>
              <Field label={`배정 비용 (${ccy})`}>
                <Input
                  type="number"
                  required
                  min="0"
                  step="0.00000001"
                  value={draft.allocatedFee}
                  onChange={(e) => patch({ allocatedFee: e.target.value })}
                />
              </Field>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              체결 수량·금액·비용 전부를 이 포트폴리오에 반영합니다.
            </p>
          )}
        </div>
      </details>
      <Field label="증권사 체결 근거 (필수)">
        <Input
          required
          maxLength={180}
          placeholder="예: 거래내역의 체결번호 또는 확인 메모"
          value={draft.brokerReference}
          onChange={(e) => patch({ brokerReference: e.target.value })}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        계좌 비밀번호·인증정보·비밀정보는 입력하지 마세요. 체결 비용에 세금을 포함했다면 현금 내역의
        별도 세금에 다시 넣지 않습니다.
      </p>
      <details className="rounded border p-3">
        <summary className="cursor-pointer text-sm">메모 (선택)</summary>
        <Field label="메모">
          <textarea
            className={fieldClass}
            rows={2}
            maxLength={300}
            value={draft.note}
            onChange={(e) => patch({ note: e.target.value })}
          />
        </Field>
      </details>
      <label className="flex items-start gap-2 rounded border p-3 text-sm">
        <input
          type="checkbox"
          required
          className="mt-1"
          checked={draft.confirmed}
          onChange={(e) => onChange({ ...draft, confirmed: e.target.checked })}
        />
        실제 체결이며 위 배정 수량·금액·비용을 확인했습니다
      </label>
    </>
  );
}
function CashFields({
  draft,
  onChange,
}: {
  draft: CashDraft;
  onChange: (draft: CashDraft) => void;
}) {
  const patch = (value: Partial<CashDraft>) => onChange({ ...draft, ...value, confirmed: false });
  return (
    <>
      <p className="font-medium">
        {draft.currency === "KRW"
          ? "한국·ETF 공동 원화 현금, 한 번만 입력"
          : "미국주식 별도 USD 현금"}
      </p>
      <p className="text-sm">
        실제 입금·배정한 금액을 기록하세요. 계획금액이나 입금 예정액은 입력하지 마세요.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="실제 발생일 (한국 기준)">
          <Input
            type="date"
            required
            min={START_DATE}
            max={newActualCashDay()}
            value={draft.date}
            onChange={(e) => patch({ date: e.target.value })}
          />
        </Field>
        <Field label="현금 구분">
          <select
            className={fieldClass}
            value={draft.cashKind}
            onChange={(e) => patch({ cashKind: e.target.value as CashKind })}
          >
            {Object.entries(cashLabels).map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label={`금액 (${draft.currency}, 양수)`}>
          <Input
            type="number"
            required
            min="0.00000001"
            step="0.00000001"
            value={draft.amount}
            onChange={(e) => patch({ amount: e.target.value })}
          />
        </Field>
      </div>
      <Field label="배정·입출금 근거 (필수)">
        <Input
          required
          maxLength={180}
          placeholder="실제 배정 또는 입출금 내역의 확인 근거"
          value={draft.reference}
          onChange={(e) => patch({ reference: e.target.value })}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        포트폴리오 외부의 매도대금은 실제 배정한 금액만 입금으로 기록하세요. 체결에 포함한
        수수료·세금은 중복 입력하지 마세요. 비밀정보는 입력하지 마세요.
      </p>
      <label className="flex items-start gap-2 rounded border p-3 text-sm">
        <input
          type="checkbox"
          required
          className="mt-1"
          checked={draft.confirmed}
          onChange={(e) => onChange({ ...draft, confirmed: e.target.checked })}
        />
        실제 입금·배정 또는 현금 흐름이며 금액과 근거를 확인했습니다
      </label>
    </>
  );
}

export function NewActualPortfolio({
  selectedAsset,
  onAssetChange,
  children,
  entryCandidate,
  onEntryClose,
}: {
  entryCandidate?: PurchaseRecordCandidate;
  onEntryClose?: () => void;
  selectedAsset?: PortfolioAsset | undefined;
  onAssetChange?: ((asset: PortfolioAsset) => void) | undefined;
  children?: ReactNode;
}) {
  const qc = useQueryClient();
  const [owner, setOwner] = useState<string | null>(null);
  const ownerRef = useRef<string | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [localAsset, setLocalAsset] = useState<PortfolioAsset>("KR");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const guard = useRef({ pending: false, needsReload: false });
  const readEpoch = useRef(0);
  const asset = selectedAsset ?? localAsset;
  const queryKey = ["new-actual-portfolio", owner] as const;
  useEffect(() => {
    let active = true,
      events = 0;
    const updateOwner = (id: string | null) => {
      if (!active) return;
      if (ownerRef.current !== id) {
        readEpoch.current++;
        setDraft(null);
        setWriteError(null);
        guard.current.needsReload = false;
      }
      ownerRef.current = id;
      setOwner(id);
      setAuthReady(true);
    };
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      events++;
      updateOwner(session?.user.id ?? null);
    });
    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!events) updateOwner(error ? null : (data.session?.user.id ?? null));
      })
      .catch(() => {
        if (!events) updateOwner(null);
      });
    return () => {
      active = false;
      ownerRef.current = null;
      subscription.unsubscribe();
    };
  }, []);
  async function token(id: string) {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session || data.session.user.id !== id || ownerRef.current !== id)
      throw new Error("먼저 로그인해 주세요.");
    return data.session.access_token;
  }
  const query = useQuery({
    queryKey,
    enabled: !!owner,
    gcTime: 5 * 60_000,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () =>
      newActualPortfolioServer({ data: { action: "load", accessToken: await token(owner!) } }),
  });
  const session = useCallback(
    (currency: Currency): Session | null => {
      if (!owner || guard.current.pending || guard.current.needsReload || draft) return null;
      const revision = currency === "USD" ? query.data?.usRevision : query.data?.domesticRevision;
      if (revision == null) {
        setWriteError("원장을 먼저 새로고침한 뒤 입력을 다시 열어 주세요.");
        return null;
      }
      setWriteError(null);
      return {
        owner,
        expectedRevision: revision,
        requestId: crypto.randomUUID(),
        needsReview: false,
      };
    },
    [owner, draft, query.data?.usRevision, query.data?.domesticRevision],
  );
  const openExecution = useCallback(
    (nextAsset: PortfolioAsset, trade?: Trade, candidate?: PurchaseRecordCandidate) => {
      const opened = session(currencyOf(nextAsset));
      if (!opened) return;
      const execution = trade?.execution;
      setDraft({
        ...opened,
        kind: "execution",
        ...(candidate ? { candidate } : {}),
        asset: nextAsset,
        id: execution?.id ?? "",
        symbol: execution?.symbol ?? candidate?.symbol ?? "",
        name: execution?.name ?? candidate?.name ?? "",
        market: (execution?.market ??
          candidate?.market ??
          (nextAsset === "US" ? "US" : nextAsset === "ETF" ? "ETF" : "KOSPI")) as Market,
        side: execution?.side ?? "BUY",
        date: execution?.date ?? newActualMarketDay(currencyOf(nextAsset)),
        price: execution ? String(execution.price) : "",
        shares: execution ? String(execution.shares) : "",
        fee: execution ? String(execution.fee) : "0",
        note: execution?.note ?? "",
        originalMixed:
          !!trade &&
          (trade.rawProtected === true || trade.allocation.quantity < trade.execution.shares),
        mixed:
          !!trade &&
          (trade.rawProtected === true ||
            trade.allocation.quantity !== execution?.shares ||
            trade.allocation.gross !==
              Number(((execution?.price ?? 0) * (execution?.shares ?? 0)).toFixed(8)) ||
            trade.allocation.fee !== execution?.fee),
        quantity: trade ? String(trade.allocation.quantity) : "",
        gross: trade ? String(trade.allocation.gross) : "",
        allocatedFee: trade ? String(trade.allocation.fee) : "",
        brokerReference: trade?.allocation.brokerReference ?? "",
        confirmed: false,
      });
    },
    [session],
  );
  const openedEntry = useRef(false);
  useEffect(() => {
    if (!entryCandidate || openedEntry.current || !owner || !query.data || draft) return;
    const revision =
      entryCandidate.market === "US" ? query.data.usRevision : query.data.domesticRevision;
    if (revision == null || guard.current.pending || guard.current.needsReload) return;
    openedEntry.current = true;
    openExecution(assetOf(entryCandidate.market), undefined, entryCandidate);
  }, [entryCandidate, owner, query.data, draft, openExecution]);
  function openCash(currency: Currency, event?: CashEvent) {
    const opened = session(currency);
    if (!opened) return;
    setDraft({
      ...opened,
      kind: "cash",
      currency,
      id: event?.id ?? "",
      date: event?.date ?? newActualCashDay(),
      cashKind: event?.kind ?? "DEPOSIT",
      amount: event ? String(event.amount) : "",
      reference: event?.reference ?? "",
      confirmed: false,
    });
  }
  function cancelExecution(trade: Trade) {
    const nextAsset = assetOf(trade.execution.market);
    const opened = session(currencyOf(nextAsset));
    if (opened)
      setDraft({
        ...opened,
        kind: "cancelExecution",
        asset: nextAsset,
        executionId: trade.execution.id,
        description: `${trade.execution.date} ${trade.execution.name} ${trade.allocation.quantity}주`,
        reason: "",
      });
  }
  function cancelCash(currency: Currency, event: CashEvent) {
    const opened = session(currency);
    if (opened)
      setDraft({
        ...opened,
        kind: "cancelCash",
        currency,
        eventId: event.id,
        description: `${event.date} ${cashLabels[event.kind]} ${money(String(event.amount), currency)}`,
        reason: "",
      });
  }
  function closeEditor() {
    if (!guard.current.pending) {
      setDraft(null);
      onEntryClose?.();
    }
  }
  async function refresh() {
    if (guard.current.pending || !owner) return;
    const id = owner;
    const epoch = ++readEpoch.current;
    const result = await query.refetch();
    if (ownerRef.current !== id || readEpoch.current !== epoch) return;
    if (!result.isError) {
      guard.current.needsReload = false;
      setWriteError(
        draft?.needsReview ? "최신 체결·현금 기록을 대조한 뒤 입력을 닫고 다시 열어 주세요." : null,
      );
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (
      !draft ||
      draft.owner !== owner ||
      draft.needsReview ||
      guard.current.pending ||
      guard.current.needsReload
    )
      return;
    const current = draft;
    let payload: WithoutToken<Request>;
    const base = { expectedRevision: current.expectedRevision, requestId: current.requestId };
    try {
      if (current.kind === "execution") {
        if (!current.confirmed) throw new Error("실제 체결과 배정 내용을 확인해 주세요.");
        if (
          !current.date ||
          current.date < START_DATE ||
          current.date > newActualMarketDay(currencyOf(current.asset))
        )
          throw new Error("체결일은 2026-10-12부터 시장 현지 오늘까지 입력할 수 있습니다.");
        const price = Number(current.price),
          shares = Number(current.shares),
          fee = Number(current.fee);
        if (
          !current.symbol.trim() ||
          !current.name.trim() ||
          !current.price.trim() ||
          !current.shares.trim() ||
          !current.fee.trim() ||
          !Number.isFinite(price) ||
          price <= 0 ||
          !Number.isSafeInteger(shares) ||
          shares <= 0 ||
          !Number.isFinite(fee) ||
          fee < 0
        )
          throw new Error("종목·실제 체결가격·정수 수량·비용을 확인해 주세요.");
        const quantity = current.mixed ? Number(current.quantity) : shares;
        const gross = current.mixed ? Number(current.gross) : Number((price * shares).toFixed(8));
        const allocatedFee = current.mixed ? Number(current.allocatedFee) : fee;
        if (
          quantity === shares &&
          (gross !== Number((price * shares).toFixed(8)) || allocatedFee !== fee)
        )
          throw new Error("전체 수량을 배정할 때는 원체결 금액과 비용 전부를 배정해야 합니다.");
        if (
          (current.mixed &&
            (!current.quantity.trim() || !current.gross.trim() || !current.allocatedFee.trim())) ||
          !Number.isSafeInteger(quantity) ||
          quantity <= 0 ||
          quantity > shares ||
          !Number.isFinite(gross) ||
          gross <= 0 ||
          gross > Number((price * shares).toFixed(8)) ||
          !Number.isFinite(allocatedFee) ||
          allocatedFee < 0 ||
          allocatedFee > fee ||
          !current.brokerReference.trim()
        )
          throw new Error("배정 수량·금액·비용과 증권사 체결 근거를 확인해 주세요.");
        payload = {
          ...base,
          action: "execution",
          asset: current.asset,
          execution: {
            id: current.id,
            symbol: current.symbol.trim(),
            name: current.name.trim(),
            market: current.market,
            side: current.side,
            date: current.date,
            price,
            shares,
            fee,
            note: current.note,
          },
          allocation: {
            quantity,
            gross,
            fee: allocatedFee,
            brokerReference: current.brokerReference.trim(),
          },
          confirmed: true,
        };
      } else if (current.kind === "cash") {
        if (!current.confirmed) throw new Error("실제 배정·현금 흐름을 확인해 주세요.");
        if (!current.date || current.date < START_DATE || current.date > newActualCashDay())
          throw new Error(
            "발생일은 2026-10-12부터 한국 기준 오늘까지 입력할 수 있습니다. 시작 전 준비는 입금이 아닙니다.",
          );
        const amount = Number(current.amount);
        if (
          !current.amount.trim() ||
          !Number.isFinite(amount) ||
          amount <= 0 ||
          !current.reference.trim()
        )
          throw new Error("실제 금액과 배정·입출금 근거를 입력해 주세요.");
        payload = {
          ...base,
          action: "cash",
          currency: current.currency,
          event: {
            id: current.id,
            date: current.date,
            kind: current.cashKind,
            amount,
            reference: current.reference.trim(),
          },
          confirmed: true,
        };
      } else {
        if (!current.reason.trim()) throw new Error("기록 취소 사유를 입력해 주세요.");
        if (
          !window.confirm(
            `${current.description} 기록을 취소하시겠습니까? 원본과 취소 이력은 보존되며 증권사 주문·매도·출금은 실행되지 않습니다.`,
          )
        )
          return;
        payload =
          current.kind === "cancelExecution"
            ? {
                ...base,
                action: "cancelExecution",
                asset: current.asset,
                executionId: current.executionId,
                reason: current.reason.trim(),
              }
            : {
                ...base,
                action: "cancelCash",
                currency: current.currency,
                eventId: current.eventId,
                reason: current.reason.trim(),
              };
      }
    } catch (error) {
      setWriteError(error instanceof Error ? error.message : "입력 내용을 확인해 주세요.");
      return;
    }
    // Lock synchronously before token lookup or any await: a same-tick second click cannot write.
    guard.current.pending = true;
    setBusy(true);
    setWriteError(null);
    readEpoch.current++;
    try {
      await qc.cancelQueries({ queryKey });
      const accessToken = await token(current.owner);
      const result = await newActualPortfolioServer({
        data: { ...payload, accessToken } as Request,
      });
      if (ownerRef.current !== current.owner) return;
      await qc.cancelQueries({ queryKey });
      if (ownerRef.current !== current.owner) return;
      qc.setQueryData(queryKey, result);
      setDraft(null);
      onEntryClose?.();
    } catch (error) {
      if (ownerRef.current !== current.owner) return;
      guard.current.needsReload = true;
      setDraft((previous) =>
        previous?.requestId === current.requestId ? { ...previous, needsReview: true } : previous,
      );
      setWriteError(
        `${error instanceof Error ? error.message : "저장 응답 확인 실패"} ${RELOAD_MESSAGE}`,
      );
      await qc.cancelQueries({ queryKey });
      await qc.invalidateQueries({ queryKey, refetchType: "none" });
    } finally {
      // A write can commit after navigation or despite a lost response. Never publish
      // its owner data here; refresh only already-mounted authenticated readers.
      await invalidateActualPositionViews(qc, true);
      guard.current.pending = false;
      setBusy(false);
    }
  }
  const loadError =
    authReady && !owner
      ? "먼저 로그인해 주세요."
      : query.error instanceof Error
        ? query.error.message
        : query.error
          ? "조회 오류"
          : null;
  return (
    <>
      {!entryCandidate ? (
        <NewActualPortfolioContent
          data={query.data}
          loading={!authReady || (!!owner && query.isPending)}
          error={loadError}
          asset={asset}
          onAssetChange={(next) => {
            if (onAssetChange) onAssetChange(next);
            else setLocalAsset(next);
          }}
          onExecution={openExecution}
          onCancelExecution={cancelExecution}
          onCash={openCash}
          onCancelCash={cancelCash}
          writesDisabled={busy || guard.current.needsReload || !!draft}
          onReload={() => void refresh()}
          refreshing={busy || query.isFetching}
        >
          {children}
        </NewActualPortfolioContent>
      ) : !draft ? (
        <div className="rounded border p-4" role="status">
          <p>
            {loadError ??
              (query.data
                ? "원장 확인 후 수량을 입력할 수 있습니다."
                : "매수 기록을 불러오는 중입니다…")}
          </p>
          <Button variant="outline" onClick={onEntryClose}>
            닫기
          </Button>
        </div>
      ) : null}
      {writeError && !draft && (
        <p role="alert" className="mt-4 rounded border border-destructive p-3 text-sm">
          {writeError}
        </p>
      )}
      <Dialog
        open={!!draft}
        onOpenChange={(open) => {
          if (!open) closeEditor();
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {draft?.kind === "execution"
                ? `${draft.candidate ? "매수수량 기록" : draft.id ? "체결 정정" : "실제 체결 입력"} · ${labels[draft.asset]}`
                : draft?.kind === "cash"
                  ? `${draft.id ? "현금 정정" : "실제 현금 입력"} · ${draft.currency}`
                  : "기록 취소"}
            </DialogTitle>
            <DialogDescription>
              실제 기록을 입력·정정합니다. 증권사 주문은 실행하지 않습니다.
            </DialogDescription>
          </DialogHeader>
          {draft && (
            <form onSubmit={(event) => void save(event)} className="space-y-4">
              <fieldset disabled={busy || draft.needsReview} className="space-y-4">
                {draft.kind === "execution" ? (
                  <ExecutionFields draft={draft} onChange={setDraft} />
                ) : draft.kind === "cash" ? (
                  <CashFields draft={draft} onChange={setDraft} />
                ) : (
                  <>
                    <p className="text-sm">{draft.description}</p>
                    <p className="text-xs text-muted-foreground">
                      원본 및 취소 이력을 보존합니다. 실제 매도·출금이 발생한 것처럼 기록하지
                      않습니다.
                    </p>
                    <Field label="기록 취소 사유">
                      <textarea
                        required
                        className={fieldClass}
                        rows={3}
                        maxLength={300}
                        value={draft.reason}
                        onChange={(event) => setDraft({ ...draft, reason: event.target.value })}
                      />
                    </Field>
                  </>
                )}
              </fieldset>
              {(draft.kind === "cash" || draft.kind === "cancelCash"
                ? newActualCashDay()
                : newActualMarketDay(currencyOf(draft.asset))) < START_DATE && (
                <p className="text-xs text-warn">
                  10월 12일 시작 전입니다. 미래 체결·배정금은 저장할 수 없습니다.
                </p>
              )}
              {writeError && (
                <p role="alert" className="rounded border border-destructive p-3 text-sm">
                  {writeError}
                </p>
              )}
              {draft.needsReview && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || query.isFetching}
                  onClick={() => void refresh()}
                >
                  최신 기록 새로고침
                </Button>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={closeEditor}>
                  닫기
                </Button>
                <Button
                  type="submit"
                  disabled={
                    busy ||
                    draft.needsReview ||
                    guard.current.needsReload ||
                    ((draft.kind === "execution" || draft.kind === "cash") && !draft.confirmed)
                  }
                >
                  {busy
                    ? "저장 중…"
                    : draft.kind === "cancelExecution" || draft.kind === "cancelCash"
                      ? "기록 취소 확인"
                      : "확인한 내용 저장"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
