import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { operatingCapitalPlanServer } from "@/lib/operatingCapitalPlan.functions";
import {
  CAPITAL_PLAN_ERRORS,
  capitalPlanErrorMessage,
  type OperatingCapitalPlan as Plan,
} from "@/lib/operatingCapitalPlan";
import { Button } from "./ui/button";

const money = (value: string) => {
  const [whole = "", fraction] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}원`;
};
export function OperatingCapitalPlanContent({
  plan,
  loading = false,
  error = null,
  children,
}: {
  plan: Plan | null;
  loading?: boolean;
  error?: string | null;
  children?: ReactNode;
}) {
  return (
    <section
      className="mb-4 space-y-2 rounded-lg border border-dashed bg-card p-4"
      aria-label="운용계획"
    >
      <h3 className="font-semibold">운용계획</h3>
      {loading ? (
        <p role="status">개인 운용계획을 확인 중입니다.</p>
      ) : error ? (
        <p role="alert" className="text-sm text-warn">
          {error}
        </p>
      ) : (
        <>
          <p className="font-medium">
            {plan ? `총 계획금액 ${money(plan.plannedCapitalKrw)}` : "총 계획금액 미등록"}
          </p>
          <p role="status" className="text-sm">
            시장 배분 미확정
          </p>
          <p className="text-xs text-muted-foreground">
            계획금액은 참고용입니다. 실제 입금·배정한 자금은 현금 내역에 별도로 기록하세요.
          </p>
        </>
      )}
      {children}
    </section>
  );
}

/** Private plan only. Auth changes invalidate local approval and never reveal another owner's cache. */
export function OperatingCapitalPlan({ editable = false }: { editable?: boolean }) {
  const qc = useQueryClient();
  const [owner, setOwner] = useState<string | null>(null);
  const ownerRef = useRef<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [preview, setPreview] = useState<{ owner: string; revision: number; plan: Plan } | null>(
    null,
  );
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  useEffect(() => {
    let active = true,
      events = 0;
    const updateOwner = (id: string | null) => {
      if (!active) return;
      if (ownerRef.current !== id) {
        setAmount("");
        setPreview(null);
        setConfirmed(false);
        setMessage(null);
      }
      ownerRef.current = id;
      setOwner(id);
      setAuthError(id ? null : CAPITAL_PLAN_ERRORS.auth);
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
        if (events === 0) updateOwner(error ? null : (data.session?.user.id ?? null));
      })
      .catch(() => {
        if (events === 0) updateOwner(null);
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
      throw new Error(CAPITAL_PLAN_ERRORS.auth);
    return data.session.access_token;
  }
  const query = useQuery({
    queryKey: ["operating-capital-plan", owner],
    enabled: !!owner,
    gcTime: 0,
    staleTime: 30_000,
    retry: false,
    queryFn: async () =>
      operatingCapitalPlanServer({ data: { accessToken: await token(owner!), action: "load" } }),
  });
  async function run(task: (id: string) => Promise<void>) {
    if (lock.current || !owner) return;
    const id = owner;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    setFailed(false);
    try {
      await task(id);
    } catch (error) {
      if (ownerRef.current === id) {
        setPreview(null);
        setConfirmed(false);
        setFailed(true);
        setMessage(capitalPlanErrorMessage(error));
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function inspect() {
    setPreview(null);
    setConfirmed(false);
    await run(async (id) => {
      const accessToken = await token(id);
      const loaded = await operatingCapitalPlanServer({ data: { accessToken, action: "load" } });
      if (loaded.revision === null) throw new Error(CAPITAL_PLAN_ERRORS.missing);
      const result = await operatingCapitalPlanServer({
        data: {
          accessToken,
          action: "preview",
          expectedRevision: loaded.revision,
          plannedCapitalKrw: amount,
        },
      });
      if (!result.plan || result.revision === null) throw new Error(CAPITAL_PLAN_ERRORS.generic);
      if (ownerRef.current === id)
        setPreview({ owner: id, revision: result.revision, plan: result.plan });
    });
  }
  async function save() {
    if (!confirmed || !preview || preview.owner !== owner) return;
    const reviewed = preview;
    setPreview(null);
    setConfirmed(false);
    await run(async (id) => {
      await operatingCapitalPlanServer({
        data: {
          accessToken: await token(id),
          action: "save",
          expectedRevision: reviewed.revision,
          plannedCapitalKrw: reviewed.plan.plannedCapitalKrw,
          reviewConfirmed: true,
        },
      });
      if (ownerRef.current === id) {
        setAmount("");
        setMessage("운용계획을 저장했습니다.");
        await Promise.all([
          qc.invalidateQueries({ queryKey: ["operating-capital-plan", id] }),
          qc.invalidateQueries({ queryKey: ["portfolio-ledgers"] }),
          qc.invalidateQueries({ queryKey: ["actual-performance"] }),
        ]);
      }
    });
  }
  const plan = owner ? (query.data?.plan ?? null) : null;
  return (
    <OperatingCapitalPlanContent
      plan={plan}
      loading={!authError && query.isPending}
      error={authError ?? (query.error ? capitalPlanErrorMessage(query.error) : null)}
    >
      {editable && owner && !query.isPending && !query.error && !plan ? (
        <details className="border-t pt-2">
          <summary className="cursor-pointer text-sm font-medium">개인 운용계획 등록</summary>
          <label className="mt-2 block text-sm" htmlFor="operating-plan-capital">
            한국·미국·ETF 합계 계획금액 (원)
          </label>
          <input
            id="operating-plan-capital"
            inputMode="decimal"
            className="mt-1 w-full max-w-xs rounded border bg-background p-2"
            value={amount}
            disabled={busy}
            onChange={(e) => {
              setAmount(e.target.value);
              setPreview(null);
              setConfirmed(false);
              setMessage(null);
            }}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            계획금액만 저장합니다. 실제 입금·배정은 현금 내역에 입력하세요. 저장 후 금액 수정은
            지원하지 않습니다.
          </p>
          <Button
            type="button"
            variant="outline"
            className="mt-2"
            disabled={busy || !amount.trim()}
            onClick={() => void inspect()}
          >
            계획 미리보기
          </Button>
          {preview && preview.owner === owner ? (
            <div className="mt-3 space-y-2 border-t pt-2">
              <p>저장 전 계획: {money(preview.plan.plannedCapitalKrw)} · 배분 미확정</p>
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmed}
                  disabled={busy}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                실제 입금이 아닌 계획금액임을 확인했습니다.
              </label>
              <Button type="button" disabled={busy || !confirmed} onClick={() => void save()}>
                운용계획만 저장
              </Button>
            </div>
          ) : null}
        </details>
      ) : null}
      {message ? (
        <p role={failed ? "alert" : "status"} className="text-sm">
          {message}
        </p>
      ) : null}
    </OperatingCapitalPlanContent>
  );
}
