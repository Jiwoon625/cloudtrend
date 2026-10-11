import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import { integratedAllocationShadowServer } from "@/lib/integratedAllocationShadow.functions";
import {
  allocationTotalNav,
  type IntegratedAllocationLedger,
} from "@/lib/integratedAllocationShadow";
import { Button } from "./ui/button";
const amount = (x: string | null) =>
  x === null ? "평가 미확정" : `${x.split(".")[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
export function IntegratedAllocationShadowContent({
  ledger,
  period,
}: {
  ledger: IntegratedAllocationLedger;
  period?: { from: string; to: string };
}) {
  const nav = allocationTotalNav(ledger);
  const records = ledger.receipts
    .map((r) => r.record)
    .filter(
      (r) => (!period?.from || r.date >= period.from) && (!period?.to || r.date <= period.to),
    );
  return (
    <div className="space-y-3">
      <p>모델 초기자산 3,000만원 · 평가자산 {amount(nav)}</p>
      <p>
        시작 이후 수익률{" "}
        {nav === null ? "평가 미확정" : `${((Number(nav) / 30_000_000 - 1) * 100).toFixed(2)}%`} ·
        전체 장부 최신 평가 기준
      </p>
      <p>
        중앙 유휴현금 {amount(ledger.centralCashKrw)} · 현금 목표{" "}
        {((100 * ledger.target.C) / ledger.target.denominator).toFixed(2)}%
      </p>
      <p>
        최근 완료일{" "}
        {Object.values(ledger.markets)
          .map((s) => s.lastSessionDate)
          .filter(Boolean)
          .sort()
          .at(-1) ?? "첫 세션 대기"}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {(["K", "E", "U"] as const).map((m) => (
          <div key={m} className="rounded border p-2">
            <h4>{m === "K" ? "한국" : m === "E" ? "ETF" : "미국"}</h4>
            <p>목표 {((100 * ledger.target[m]) / ledger.target.denominator).toFixed(2)}%</p>
            <p>현금 {amount(ledger.markets[m].cashKrw)}</p>
            <p>평가 {amount(ledger.markets[m].navKrw)}</p>
            <p>
              보유 {ledger.markets[m].positions.length} · 대기{" "}
              {ledger.markets[m].pendingBuys.length}
            </p>
          </div>
        ))}
      </div>
      <div className="overflow-x-auto">
        <h4>현재 보유 · 최신 완료 세션 기준</h4>
        {Object.values(ledger.markets).every((m) => !m.positions.length) ? (
          <p>보유종목 없음</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th>시장</th>
                <th>종목</th>
                <th>수량</th>
                <th>진입일</th>
                <th>평가 기준일</th>
              </tr>
            </thead>
            <tbody>
              {Object.values(ledger.markets)
                .flatMap((m) => m.positions)
                .map((p) => (
                  <tr key={`${p.venue}:${p.symbol}`}>
                    <td>{p.venue}</td>
                    <td>{p.symbol}</td>
                    <td>{p.quantity}</td>
                    <td>{p.entryDate}</td>
                    <td>{p.lastMark?.date ?? "미확정"}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
        <h4 className="mt-3">선택 기간 거래·월말 판단</h4>
        {!records.length ? (
          <p role="status">선택 기간 기록 없음 · 첫 세션 전에는 빈 장부를 유지합니다.</p>
        ) : (
          records.map((r) => (
            <div key={r.id} className="border-t py-2 text-xs">
              <p>
                {r.date} · {r.type === "MONTH_REVIEW" ? "다음 달 비중 판단" : "시장 세션"}
              </p>
              {r.fills.map((f, i) => (
                <p key={i}>
                  {f.market} {f.symbol} {f.side} {f.quantity}주 · 비용 {amount(f.feeKrw)}
                </p>
              ))}
              {r.monthReview ? (
                <p>
                  {r.monthReview.signalMonth} {r.monthReview.partialMonth ? "부분월" : "월 전체"}{" "}
                  신호 → {r.monthReview.targetMonth} · 한국 {r.monthReview.signalCounts.K} / ETF{" "}
                  {r.monthReview.signalCounts.E} / 미국 {r.monthReview.signalCounts.U} ·
                  {r.monthReview.applied ? "목표 반영" : "관측 미완료로 기존 목표 유지"}
                </p>
              ) : null}
              {r.cancelledBuys.map((c) => (
                <p key={c.id}>
                  미체결 예약 해제 {c.market} · {c.reason}
                </p>
              ))}
              {r.issues.map((issue, i) => (
                <p key={i} className="text-warn">
                  {issue}
                </p>
              ))}
            </div>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        미국 비교환산은 초기 기준 1달러=1,339.2원입니다. 실제 환전·계좌 잔고와 독립된 모델입니다.
      </p>
      {ledger.contract.kind === "O1" ? (
        <p className="text-xs">
          초기 목표는 9월 11일 연구 종료 시점의 검증된 20세션 수요를 선택한 값입니다. 운영 중 전달된
          진입조건 충족 신호를 신호확정일의 달력월별로 모아 다음 달 목표를 갱신하고 유휴현금만
          이동합니다. 첫 집계는 10월 12일부터 월말까지의 부분월입니다. 시장 관측이 빠졌으면 기존
          목표를 유지합니다. 별도 참조 장부를 계산하지 않는 새 운영 방식으로, 원본 O1 연구 성과와
          구분합니다. 목표 0% 시장의 미체결 매수는 취소하며 보유종목은 강제매도하지 않습니다.
        </p>
      ) : (
        <p className="text-xs">
          한국/ETF/미국 60/20/20 정적 초기배분 · 비중 맞추기 위한 강제매도 없음
        </p>
      )}
      <p className="text-xs">
        한국·미국은 연초 시장별 자산 기준으로 새 종목 예산을 갱신합니다. ETF는 진입 직전 완료 종가의
        시장자산과 변동성 비중을 사용합니다.
      </p>
    </div>
  );
}
export function IntegratedAllocationShadowPanel({
  owner,
  period,
}: {
  owner: string | null;
  period?: { from: string; to: string };
}) {
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const [kind, setKind] = useState<"O1" | "S07">("O1"),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const lock = useRef(false);
  async function token(id: string) {
    const { data, error } = await supabase.auth.getSession();
    if (error || data.session?.user.id !== id || ownerRef.current !== id)
      throw new Error("로그인 소유자 확인 필요");
    return data.session.access_token;
  }
  const query = useQuery({
    queryKey: ["integrated-allocation-shadow", owner],
    enabled: !!owner,
    gcTime: 0,
    staleTime: 30000,
    retry: false,
    queryFn: async () =>
      integratedAllocationShadowServer({
        data: { action: "load", accessToken: await token(owner!) },
      }),
  });
  async function initialize() {
    if (!owner || lock.current) return;
    const id = owner;
    lock.current = true;
    setBusy(true);
    setMessage(null);
    try {
      await integratedAllocationShadowServer({
        data: { action: "initialize", accessToken: await token(id) },
      });
      if (ownerRef.current === id) {
        await query.refetch();
        setMessage("자산배분 Shadow 초기화 내역을 확인했습니다.");
      }
    } catch {
      if (ownerRef.current === id)
        setMessage("초기화 응답을 확인하지 못했습니다. 새로고침으로 기존 기록을 확인하세요.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const book = query.data?.books.find((b) => b.kind === kind);
  return (
    <section aria-label="자산배분 Shadow" className="space-y-3 rounded border p-4">
      <label>
        자산배분 전략{" "}
        <select value={kind} onChange={(e) => setKind(e.target.value as "O1" | "S07")}>
          <option value="O1">O1 · 전월 전달 신호</option>
          <option value="S07">S07 · 60/20/20</option>
        </select>
      </label>
      <Button
        disabled={!owner || busy || query.isFetching}
        variant="outline"
        onClick={() => void query.refetch()}
      >
        배분 Shadow 새로고침
      </Button>
      {!owner ? (
        <p>로그인 후 조회합니다.</p>
      ) : query.isPending ? (
        <p role="status">배분 Shadow 확인 중</p>
      ) : query.error ? (
        <p role="alert">배분 Shadow 기록 조회 실패. 기존 기록을 유지하고 재조회하세요.</p>
      ) : book?.ledger ? (
        <IntegratedAllocationShadowContent ledger={book.ledger} {...(period ? { period } : {})} />
      ) : (
        <div>
          <p>신규 배분 장부 등록 대기</p>
          <Button disabled={busy} onClick={() => void initialize()}>
            승인한 O1·60/20/20 새 장부 초기화
          </Button>
        </div>
      )}
      {message ? <p role="status">{message}</p> : null}
    </section>
  );
}
