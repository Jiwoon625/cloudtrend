import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { actualEntryDecisionsServer } from "@/lib/actualEntryDecisions.functions";
import {
  activeEntryDecisions,
  ENTRY_REASONS,
  entryDecisionLabel,
  type EntryCommand,
  type EntryDecisionCandidate,
} from "@/lib/actualEntryDecisions";
import { invalidateActualPositionViews } from "@/lib/dashboardActualRefresh";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./ui/dialog";

function useEntryDecisions() {
  const qc = useQueryClient();
  const [owner, setOwner] = useState<string | null>(null);
  const ownerRef = useRef<string | null>(null);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let alive = true,
      events = 0;
    const update = (id: string | null) => {
      if (alive) {
        ownerRef.current = id;
        setOwner(id);
        setMessage("");
      }
    };
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_e, s) => {
      events++;
      update(s?.user.id ?? null);
    });
    void supabase.auth
      .getSession()
      .then(({ data, error }) => {
        if (!events) update(error ? null : (data.session?.user.id ?? null));
      })
      .catch(() => {
        if (!events) update(null);
      });
    return () => {
      alive = false;
      ownerRef.current = null;
      subscription.unsubscribe();
    };
  }, []);
  async function token(id: string) {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session || data.session.user.id !== id || ownerRef.current !== id)
      throw new Error("로그인 계정이 변경되었습니다. 창을 다시 열어 주세요.");
    return data.session.access_token;
  }
  const query = useQuery({
    queryKey: ["actual-entry-decisions", owner],
    enabled: !!owner,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    queryFn: async () =>
      actualEntryDecisionsServer({ data: { action: "load", accessToken: await token(owner!) } }),
  });
  async function save(command: EntryCommand) {
    if (!owner || !query.data || lock.current || query.isError || query.isFetching) return false;
    const id = owner;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const saved = await actualEntryDecisionsServer({
        data: {
          action: "save",
          accessToken: await token(id),
          expectedRevision: query.data.revision,
          command,
        },
      });
      if (ownerRef.current !== id) return false;
      await qc.cancelQueries({ queryKey: ["actual-entry-decisions", id] });
      if (ownerRef.current !== id) return false;
      qc.setQueryData(["actual-entry-decisions", id], saved);
      await invalidateActualPositionViews(qc, true);
      if (ownerRef.current !== id) return false;
      setMessage(
        command.action === "release"
          ? "미매수 제한을 해제했습니다."
          : "실제 원장용 미매수 결정을 저장했습니다.",
      );
      return true;
    } catch (e) {
      if (ownerRef.current === id) {
        setMessage(e instanceof Error ? e.message : "저장 결과를 다시 조회하세요.");
        await query.refetch();
      }
      return false;
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return { owner, query, busy, message, save };
}
export function ActualEntryDecisionDialog({
  candidate,
  onClose,
}: {
  candidate: EntryDecisionCandidate;
  onClose: () => void;
}) {
  const state = useEntryDecisions();
  const [reason, setReason] = useState<(typeof ENTRY_REASONS)[number]>("독립성 제한");
  const [scope, setScope] = useState<"signal" | "symbol">("symbol");
  const [note, setNote] = useState("");
  const requestId = useRef(crypto.randomUUID());
  const initialOwner = useRef<string | null>(null);
  useEffect(() => {
    if (state.owner && !initialOwner.current) initialOwner.current = state.owner;
    else if (initialOwner.current && state.owner !== initialOwner.current) onClose();
  }, [state.owner, onClose]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !state.busy) onClose();
      }}
    >
      <DialogContent className="max-w-md" aria-describedby="nonpurchase-description">
        <DialogTitle>미매수 처리 · {candidate.name}</DialogTitle>
        <DialogDescription id="nonpurchase-description">
          {candidate.market} · {candidate.symbol} · 원신호 {candidate.signalOriginDate}
          <br />
          실제 원장의 진입 후보에만 적용합니다. Shadow는 전략대로 계속 진행합니다.
        </DialogDescription>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void state
              .save({ ...candidate, action: "set", id: requestId.current, reason, scope, note })
              .then((ok) => {
                if (ok) onClose();
              });
          }}
        >
          <label className="grid gap-1 text-sm">
            미매수 사유
            <select
              className="rounded border bg-background p-2"
              value={reason}
              disabled={state.busy}
              onChange={(e) => {
                const value = e.target.value as typeof reason;
                setReason(value);
                setScope(value === "독립성 제한" ? "symbol" : "signal");
                requestId.current = crypto.randomUUID();
              }}
            >
              {ENTRY_REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            적용 범위
            <select
              className="rounded border bg-background p-2"
              value={scope}
              disabled={state.busy}
              onChange={(e) => {
                setScope(e.target.value as typeof scope);
                requestId.current = crypto.randomUUID();
              }}
            >
              <option value="symbol">해제 전까지 · 다음 신호에도 자동 미매수</option>
              <option value="signal">이번 원신호만</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            메모 (선택)
            <textarea
              className="rounded border bg-background p-2"
              rows={2}
              maxLength={300}
              value={note}
              disabled={state.busy}
              onChange={(e) => {
                setNote(e.target.value);
                requestId.current = crypto.randomUUID();
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            체결·현금·보유수량·수익률은 바뀌지 않습니다. 기존 미체결 예약이 있다면 별도로
            취소하세요. 해제는 포트폴리오의 ‘미매수·제한 관리’에서 할 수 있습니다.
          </p>
          {state.query.isError ? (
            <p role="alert">
              미매수 기록 조회 실패{" "}
              <button
                type="button"
                className="underline"
                onClick={() => void state.query.refetch()}
              >
                다시 조회
              </button>
            </p>
          ) : null}
          {state.message ? <p role="status">{state.message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" disabled={state.busy} onClick={onClose}>
              취소
            </Button>
            <Button
              type="submit"
              disabled={
                !state.owner ||
                !state.query.data ||
                state.query.isFetching ||
                state.query.isError ||
                state.busy
              }
            >
              {state.busy ? "저장 중…" : "미매수 저장"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function ActualEntryDecisionManager() {
  const state = useEntryDecisions();
  const active = state.query.data ? activeEntryDecisions(state.query.data) : [];
  const names = new Map(
    state.query.data?.events.flatMap((e) =>
      e.command.action === "set" ? [[e.command.id, e.command.name] as const] : [],
    ) ?? [],
  );
  return (
    <details className="rounded border p-3 text-sm">
      <summary className="cursor-pointer font-medium">
        미매수·제한 관리 {state.query.data ? `(${active.length})` : ""}
      </summary>
      <p className="my-2 text-xs text-muted-foreground">
        실제 원장 전용입니다. 독립성 제한은 해제 전까지 다음 신호에도 적용되며, Shadow에는 적용하지
        않습니다. 등록은 대시보드 진입 후보의 ‘미매수 처리’에서 합니다.
      </p>
      {state.query.isPending ? (
        <p>미매수 기록 조회 중…</p>
      ) : state.query.isError ? (
        <p role="alert">미매수 기록을 불러오지 못했습니다.</p>
      ) : !active.length ? (
        <p>적용 중인 미매수 결정이 없습니다.</p>
      ) : (
        <ul className="divide-y">
          {active.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 py-2">
              <div>
                <span className="font-medium">
                  {d.name} · {d.market}
                </span>
                <p className="text-xs">
                  {entryDecisionLabel(d)} ·{" "}
                  {d.scope === "signal" ? `원신호 ${d.signalOriginDate}` : "다음 신호 자동 적용"}
                </p>
                {d.note ? (
                  <details className="text-xs">
                    <summary>메모</summary>
                    {d.note}
                  </details>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={state.busy || state.query.isFetching || state.query.isError}
                onClick={() =>
                  void state.save({ action: "release", id: crypto.randomUUID(), targetId: d.id })
                }
              >
                {d.scope === "symbol" ? "제한 해제" : "미매수 취소"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        size="sm"
        variant="ghost"
        disabled={state.busy || state.query.isFetching}
        onClick={() => void state.query.refetch()}
      >
        다시 조회
      </Button>
      {state.message ? <p role="status">{state.message}</p> : null}
      {state.query.data?.events.length ? (
        <details className="mt-2 text-xs">
          <summary>변경 이력 ({state.query.data.events.length})</summary>
          <ul className="mt-2 max-h-60 overflow-auto">
            {[...state.query.data.events].reverse().map((e) => (
              <li key={e.command.id} className="py-1">
                {new Date(e.recordedAt).toLocaleString("ko-KR")} ·{" "}
                {e.command.action === "set"
                  ? `${e.command.name} · ${e.command.reason} · ${e.command.scope === "symbol" ? "지속 제한" : "이번 원신호"}`
                  : `해제 · ${names.get(e.command.targetId) ?? "미매수 기록"}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </details>
  );
}
