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
      aria-label="통합 운용계획 준비 상태"
    >
      <h3 className="font-semibold">통합 운용계획 · 실제 / 전략 비교</h3>
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
            10월 12일 시작 예정 · 시장 배분 미확정 · 통합 모델 진입 준비 중
          </p>
          <p className="text-xs text-muted-foreground">
            한국·미국·ETF가 하나의 총자금을 나눠 씁니다. 실제와 전략 비교는 각각 기록하며 두 장부의
            금액을 합산하지 않습니다. 계획금액은 확인된 현금이나 성과 NAV가 아닙니다.
          </p>
          {plan ? (
            <>
              <p className="text-xs text-muted-foreground">
                연초 신규매수 예산: 한국 운용분 평가자산 ÷ 30, 미국 USD 평가자산 ÷ 20, ETF 운용분
                평가자산 × 기존 변동성 비중(최대 10종목). ETF는 균등 1/10 배분이 아닙니다.
              </p>
              <p className="text-xs text-muted-foreground">
                기존 보유 리밸런싱 없음 · 확정된 연말 대기주문 예산 유지 · 기존 비용 가정 유지. 첫해
                시장 배분과 연간 평가 근거 확정 후 별도 통합 계약을 연결하며, 아직 주문 실행이나
                연초 자동평가는 활성화되지 않았습니다.
              </p>
            </>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Notion 종목마스터·거래내역은 전체 실제 원장입니다. CloudTrend는 빈 보유로 시작한 신규
            운용분만 측정하며 자동 동기화하지 않습니다. 기존 보유 매도 예정은 체결로 기록하지
            않습니다.
          </p>
          <p className="text-xs text-muted-foreground">
            기존 매도대금이 계획금액에 포함되면 시작현금과 이후 입금에 한 번만 반영합니다.
            공용현금과 내부 배분을 중복 자산이나 투자수익으로 세지 않습니다.
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
        setMessage(
          "운용계획만 저장했습니다. 실제 기준점·현금·거래와 모델 계약은 변경하지 않았습니다.",
        );
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
            금액만 계획으로 저장합니다. 시장별 비중·현금·환율을 자동 배정하지 않습니다. 저장한 초기
            계획은 이 화면에서 덮어쓰지 않습니다.
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
                계획금액이며 실제 현금·성과 기준점 확정이 아님을 확인했습니다.
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
