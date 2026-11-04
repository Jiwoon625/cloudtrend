import { useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import {
  integratedAllocationShadowServer,
  allocationWarningEvidenceServer,
} from "@/lib/integratedAllocationShadow.functions";
import {
  allocationTotalNav,
  type IntegratedAllocationLedger,
  type AllocationRecord,
} from "@/lib/integratedAllocationShadow";
import { Button } from "./ui/button";
import {
  allocationWarningGroups,
  type AllocationWarningEvidence,
} from "@/lib/allocationWarningPresentation";
const amount = (x: string | null) =>
  x === null ? "평가 미확정" : `${x.split(".")[0]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}원`;
function allocationHistoryDate(record: Pick<AllocationRecord, "type" | "date">) {
  if (record.type !== "MONTH_REVIEW") return record.date;
  const [year, month] = record.date.split("-").map(Number);
  return new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
}
export function IntegratedAllocationShadowContent({
  ledger,
  period,
  warningEvidence,
  renderWarnings,
}: {
  warningEvidence?: Record<string, AllocationWarningEvidence> | undefined;
  renderWarnings?: (record: AllocationRecord) => ReactNode;
  ledger: IntegratedAllocationLedger;
  period?: { from: string; to: string };
}) {
  const nav = allocationTotalNav(ledger);
  const records = ledger.receipts
    .map((r) => r.record)
    .filter((r) => {
      const date = allocationHistoryDate(r);
      return (!period?.from || date >= period.from) && (!period?.to || date <= period.to);
    });
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
          .at(-1) ?? "세션 기록 없음"}
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
        <h4>기록 당시 보유 · 마지막 저장 세션 기준</h4>
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
        <p className="text-xs text-muted-foreground">
          월말 판단의 기간 필터는 집계월 말일 기준이며, 실제 자료 전달·판단 완료 시각과 다릅니다.
        </p>
        {!records.length ? (
          <p role="status">선택 기간에 보관된 기록이 없습니다.</p>
        ) : (
          records.map((r) => (
            <div key={r.id} className="border-t py-2 text-xs">
              <p>
                {allocationHistoryDate(r)}
                {r.type === "MONTH_REVIEW" ? " 집계월 말일" : ""} ·{" "}
                {r.type === "MONTH_REVIEW" ? "다음 달 비중 판단" : "시장 세션"}
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
              {r.issues.length > 0 ? (
                renderWarnings ? (
                  renderWarnings(r)
                ) : (
                  <details>
                    <summary className="cursor-pointer text-warn">
                      자료 확인 {r.issues.length}건
                    </summary>
                    <AllocationWarningDetails record={r} evidence={warningEvidence?.[r.id]} />
                  </details>
                )
              ) : null}
            </div>
          ))
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        미국 비교환산은 초기 기준 1달러=1,339.2원입니다. 실제 환전·계좌 잔고와 독립된 모델입니다.
      </p>
      {ledger.contract.kind === "O1" ? (
        <p className="text-xs">
          보관된 O1 모델은 당시 전달된 진입 신호를 월별로 집계해 다음 달 목표와 유휴현금 배분을
          계산했습니다. 10월 12일부터 시작한 부분월 기록이며 원본 O1 연구 성과와 구분합니다. 현재는
          월말 비중 변경이나 신규 세션 기록을 자동 수행하지 않습니다.
        </p>
      ) : (
        <p className="text-xs">
          한국/ETF/미국 60/20/20 정적 초기배분 · 비중 맞추기 위한 강제매도 없음
        </p>
      )}
      <p className="text-xs">
        보관 기록의 산식: 한국·미국은 연초 시장별 자산 기준 종목 예산, ETF는 진입 직전 완료 종가의
        시장자산과 변동성 비중을 사용했습니다.
      </p>
    </div>
  );
}
export function AllocationWarningDetails({
  record,
  evidence,
}: {
  record: AllocationRecord;
  evidence?: AllocationWarningEvidence | undefined;
}) {
  const groups = allocationWarningGroups(record, evidence);
  const sections = [
    ["전략 대상 제외", groups.excluded],
    ["분류 미확인", groups.unclassified],
    ["판단 자료 미확인", groups.unavailable],
    ["분류 근거 미확인", groups.unverified],
    ["기타 확인", groups.other],
  ] as const;
  return (
    <div className="space-y-1 pl-2">
      {sections
        .filter(([, rows]) => rows.length)
        .map(([label, rows]) => (
          <details key={label}>
            <summary>
              {label} {rows.length}건
            </summary>
            <ul>
              {rows.map((row, i) => (
                <li key={i}>{row}</li>
              ))}
            </ul>
          </details>
        ))}
      <p className="text-muted-foreground">
        해당 세션 저장 근거로 구분합니다. 확인 건수는 수집 실패·주문 건수가 아닙니다.
      </p>
      <details>
        <summary>저장 원문</summary>
        <ul>
          {record.issues.map((issue, i) => (
            <li key={i}>{issue}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
/** Each receipt owns its lazy state, isolated by owner/book/head React key at the caller. */
export function LazyAllocationWarnings({
  owner,
  kind,
  stateHash,
  record,
  getToken,
}: {
  owner: string;
  kind: "O1" | "S07";
  stateHash: string;
  record: AllocationRecord;
  getToken: (owner: string) => Promise<string>;
}) {
  const [open, setOpen] = useState(false);
  const canClassify = /^session:E:\d{4}-\d{2}-\d{2}$/.test(record.id);
  const query = useQuery({
    queryKey: ["allocation-warning-evidence", owner, kind, stateHash, record.id],
    enabled: open && canClassify,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    queryFn: async () =>
      allocationWarningEvidenceServer({
        data: {
          accessToken: await getToken(owner),
          kind,
          receiptId: record.id,
        },
      }),
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="cursor-pointer text-warn">자료 확인 {record.issues.length}건</summary>
      {open ? (
        query.isFetching ? (
          <p role="status">근거 확인 중</p>
        ) : (
          <AllocationWarningDetails record={record} evidence={query.data?.[record.id]} />
        )
      ) : null}
      {open && canClassify && !query.isFetching && !query.data?.[record.id] ? (
        <button
          type="button"
          className="text-primary underline"
          onClick={() => void query.refetch()}
        >
          근거 다시 확인
        </button>
      ) : null}
    </details>
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
  const [kind, setKind] = useState<"O1" | "S07">("O1");
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
  const book = query.data?.books.find((b) => b.kind === kind);
  return (
    <section aria-label="자산배분 Shadow" className="space-y-3 rounded border p-4">
      <p className="text-sm text-muted-foreground">
        통합배분은 일상 운영에서 제외했습니다. 아래는 마지막 저장일 기준의 보관 기록입니다.
      </p>
      <label>
        자산배분 전략{" "}
        <select value={kind} onChange={(e) => setKind(e.target.value as "O1" | "S07")}>
          <option value="O1">O1 · 전월 전달 신호</option>
          <option value="S07">S07 · 60/20/20</option>
        </select>
      </label>
      <Button
        disabled={!owner || query.isFetching}
        variant="outline"
        onClick={() => void query.refetch()}
      >
        배분 보관 기록 다시 불러오기
      </Button>
      {!owner ? (
        <p>로그인 후 조회합니다.</p>
      ) : query.isPending ? (
        <p role="status">배분 Shadow 확인 중</p>
      ) : query.error ? (
        <p role="alert">배분 Shadow 기록 조회 실패. 기존 기록을 유지하고 재조회하세요.</p>
      ) : book?.ledger ? (
        <IntegratedAllocationShadowContent
          ledger={book.ledger}
          {...(period ? { period } : {})}
          renderWarnings={(record) => (
            <LazyAllocationWarnings
              key={`${owner}:${kind}:${book.ledger!.stateHash}:${record.id}`}
              owner={owner}
              kind={kind}
              stateHash={book.ledger!.stateHash}
              record={record}
              getToken={token}
            />
          )}
        />
      ) : (
        <p>보관된 배분 장부가 없습니다. 일상 운영에서는 새 장부를 생성하지 않습니다.</p>
      )}
    </section>
  );
}
