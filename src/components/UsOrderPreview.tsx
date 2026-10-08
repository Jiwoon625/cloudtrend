import type {
  UsOrderPlan,
  UsOrderPreviewBundle,
  UsOrderPreviewRow,
} from "@/lib/engine/usProspectiveOrderPreview";

interface Props {
  bundle?: UsOrderPreviewBundle | null;
  compact?: boolean;
  isPending?: boolean;
  error?: string | null;
  strategyLabel?: string;
  todayUs?: string;
}

const number = (value: number | null) =>
  value == null || !Number.isFinite(value)
    ? "미확인"
    : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
const shares = (value: number | null) =>
  value == null || !Number.isFinite(value) ? "미확인" : `${number(value)}주`;
const usd = (value: number | null) =>
  value == null || !Number.isFinite(value)
    ? "미확인"
    : `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const weight = (value: number | null) =>
  value == null || !Number.isFinite(value) ? "미확인" : `${(value * 100).toFixed(1)}%`;
const SIDE: Record<UsOrderPreviewRow["side"], string> = {
  BUY: "추가 매수",
  SELL: "일부 축소",
  HOLD: "유지",
  EXIT: "전량 청산",
};
const STATUS: Record<UsOrderPreviewRow["status"], string> = {
  ESTIMATED: "수량 추정",
  PARTIAL: "제약 반영 · 일부 수량",
  NO_CHANGE: "조정 없음",
  BLOCKED: "수량 산출 불가",
};
const REASON: Record<string, string> = {
  QUARTER_EQUAL_WEIGHT: "분기 동일비중 조정",
  ENTRY_ONSET80: "신규 진입 신호",
  ENTRY_MINIMUM_PROPORTIONAL_FUNDING: "신규 진입 자금 마련 · 기존 보유 축소",
  UNIVERSE_OR_DATA_EXIT: "투자대상 제외 또는 자료 미확인 청산",
  A0_BETA_ANCHOR_3D: "Beta 상위 40% 밖 3거래일 연속 청산",
  B3_BETA_WEAK_3D: "Beta 약세 3거래일 연속 청산",
  "CORE_BELOW_0.70": "Core 상위 30% 밖 청산",
  "CORE_BELOW_0.50": "Core 상위 50% 밖 청산",
};
const side = (row: UsOrderPreviewRow) =>
  row.status === "BLOCKED" && row.targetShares == null ? "조정 방향 미확인" : SIDE[row.side];

function RowStatus({ row }: { row: UsOrderPreviewRow }) {
  return (
    <div
      className={
        row.status === "BLOCKED" || row.status === "PARTIAL" ? "text-warn" : "text-muted-foreground"
      }
    >
      <span>{STATUS[row.status]}</span>
      {row.remainingShares != null && row.remainingShares > 0 ? (
        <span className="block">추정 미반영 {shares(row.remainingShares)}</span>
      ) : null}
      {row.limitReason ? <span className="block">{row.limitReason}</span> : null}
    </div>
  );
}

function CompactRows({ rows }: { rows: UsOrderPreviewRow[] }) {
  const renderRows = (items: UsOrderPreviewRow[]) => (
    <ul className="divide-y divide-border">
      {items.map((row, index) => (
        <li key={`${row.symbol}-${row.reason}-${index}`} className="py-2 text-[11px]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
            <span className="break-all font-semibold">{row.symbol}</span>
            <span
              className={`num font-medium ${row.side === "BUY" ? "text-up" : "text-foreground"}`}
            >
              {side(row)} {shares(row.estimatedShares)} 추정
            </span>
          </div>
          <p className="mt-0.5 break-words text-muted-foreground">{row.name}</p>
          <p className="num mt-1">
            모델 보유 {shares(row.currentShares)} → 목표 {shares(row.targetShares)}
          </p>
          <p className="text-muted-foreground">{REASON[row.reason] ?? row.reason}</p>
          <RowStatus row={row} />
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {renderRows(rows.slice(0, 5))}
      {rows.length > 5 ? (
        <details className="text-[11px]">
          <summary className="cursor-pointer py-2 font-medium text-primary">
            나머지 {rows.length - 5}종목 수량 보기
          </summary>
          {renderRows(rows.slice(5))}
        </details>
      ) : null}
    </>
  );
}

function DetailRows({
  rows,
  title,
  fixedSlotA0,
}: {
  rows: UsOrderPreviewRow[];
  title: string;
  fixedSlotA0: boolean;
}) {
  return (
    <div
      className="overflow-x-auto"
      role="region"
      aria-label={`${title} 종목별 추정 수량`}
      tabIndex={0}
    >
      <table className="w-full min-w-[1000px] text-[11px]">
        <caption className="sr-only">{title} · 모델 수량이며 실제 체결 내역이 아닙니다</caption>
        <thead>
          <tr className="border-b text-left text-muted-foreground [&>th]:px-3 [&>th]:py-2">
            <th scope="col">종목 / 사유</th>
            <th scope="col" className="text-right">
              모델 보유 → 목표
            </th>
            <th scope="col" className="text-right">
              예상 조정수량
            </th>
            <th scope="col" className="text-right">
              {fixedSlotA0 ? "초기자금 기준 비중" : "목표비중"}
            </th>
            <th scope="col" className="text-right">
              참고가격 / 가격일
            </th>
            <th scope="col" className="text-right">
              예상 주문금액
            </th>
            <th scope="col">산출 상태 / 제약</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={`${row.symbol}-${row.reason}-${index}`}
              className="border-b align-top last:border-0 [&>td]:px-3 [&>td]:py-3"
            >
              <td className="max-w-64 break-words">
                <span className="font-semibold">{row.symbol}</span>{" "}
                <span className="text-muted-foreground">{row.name}</span>
                <span className="mt-1 block text-[10px] text-muted-foreground">
                  {REASON[row.reason] ?? row.reason}
                </span>
              </td>
              <td className="num text-right">
                {shares(row.currentShares)} → {shares(row.targetShares)}
              </td>
              <td
                className={`num text-right ${row.side === "BUY" ? "text-up" : "text-foreground"}`}
              >
                {side(row)}
                <span className="block font-medium">{shares(row.estimatedShares)} 추정</span>
              </td>
              <td className="num text-right">{weight(row.targetWeight)}</td>
              <td className="num text-right">
                {usd(row.referencePrice)}
                <span className="block text-[10px] text-muted-foreground">
                  {row.priceDate ?? "가격일 미확인"}
                </span>
              </td>
              <td className="num text-right">{usd(row.estimatedNotionalUsd)}</td>
              <td className="max-w-56 break-words">
                <RowStatus row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Plan({
  plan,
  compact,
  todayUs,
  fixedSlotA0 = false,
}: {
  plan: UsOrderPlan;
  compact: boolean;
  todayUs: string;
  fixedSlotA0?: boolean;
}) {
  const quarterly = plan.kind === "QUARTER";
  const title = quarterly ? "다음 분기 비중조정" : "다음 정규장 대기 조정";
  const overdue = todayUs > plan.executionDate;
  const provisional =
    plan.status === "PROVISIONAL" || (quarterly && plan.sourceDate !== plan.confirmationDate);
  const status =
    plan.status === "BLOCKED"
      ? "산출 불가 · 자료 확인 필요"
      : provisional
        ? "가정 미리보기 · 확정 전"
        : "직전 거래일 자료 반영 · 수량은 추정";
  return (
    <section className="min-w-0 rounded-md border border-border" aria-label={title}>
      <div className={compact ? "p-3" : "p-4"}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-semibold">
            {title}
            {plan.quarter ? ` · ${plan.quarter}` : ""}
          </h3>
          <span
            className={`rounded border px-2 py-0.5 text-[10px] ${plan.status === "BLOCKED" || provisional ? "text-warn" : "text-muted-foreground"}`}
          >
            {status}
          </span>
        </div>
        {overdue ? (
          <p role="status" className="mt-2 rounded bg-muted p-2 text-[11px] font-medium text-warn">
            예정일 경과 · 이후 확정 자료 미반영. 현재 주문에 사용할 수 없는 과거 예상입니다.
          </p>
        ) : null}
        <dl
          className={`mt-3 grid gap-x-4 gap-y-2 text-[10px] ${compact ? "grid-cols-1" : "sm:grid-cols-3"}`}
        >
          <div>
            <dt className="text-muted-foreground">저장 자료 기준일</dt>
            <dd className="num mt-0.5 font-medium">{plan.sourceDate}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {quarterly ? "최종 확인 예정 종가일" : "대기 신호 기준일"}
            </dt>
            <dd className="num mt-0.5 font-medium">{plan.confirmationDate}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              {quarterly ? "분기 첫 미국 정규장 예정일" : "미국 정규장 예정일"}
            </dt>
            <dd className="num mt-0.5 font-medium">{plan.executionDate}</dd>
          </div>
        </dl>
        {provisional ? (
          <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
            현재 저장된 보유·가격으로 가정한 계획입니다. 확정일까지 투자대상·보유·신호가 달라질 수
            있습니다.
          </p>
        ) : null}
        <dl
          className={`mt-3 grid grid-cols-2 gap-2 border-t border-border pt-3 text-[10px] ${compact ? "" : "sm:grid-cols-4"}`}
        >
          <div>
            <dt className="text-muted-foreground">모델 NAV · USD</dt>
            <dd className="num mt-0.5 font-medium">{usd(plan.navUsd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">모델 현금 · 조정 전</dt>
            <dd className="num mt-0.5 font-medium">{usd(plan.cashBeforeUsd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">모델 현금 · 조정 후 추정</dt>
            <dd className="num mt-0.5 font-medium">{usd(plan.cashAfterUsd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">모델 비용 추정 · USD</dt>
            <dd className="num mt-0.5 font-medium">{usd(plan.feesUsd)}</dd>
          </div>
        </dl>
        {plan.warnings.length ? (
          <ul className="mt-2 space-y-1 text-[10px] leading-relaxed text-warn">
            {plan.warnings.map((warning, index) => (
              <li key={`${warning}-${index}`}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {plan.rows.length ? (
        compact ? (
          <div className="border-t border-border px-3">
            <CompactRows rows={plan.rows} />
          </div>
        ) : (
          <DetailRows rows={plan.rows} title={title} fixedSlotA0={fixedSlotA0} />
        )
      ) : (
        <p className="border-t border-border p-3 text-[11px] text-muted-foreground">
          {plan.status === "BLOCKED"
            ? "자료 부족으로 조정수량을 산출하지 못했습니다. 0주 조정을 뜻하지 않습니다."
            : quarterly
              ? "저장된 모델 기준 분기 조정 대상이 없습니다 (0종목)."
              : "저장된 모델 기준 다음 정규장 대기 조정이 없습니다 (0종목)."}
        </p>
      )}
    </section>
  );
}

/** A read-only model projection. Never scale it by the actual-account capital field. */
export function UsOrderPreview({
  bundle,
  compact = false,
  isPending = false,
  error,
  strategyLabel = "A0",
  todayUs = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date()),
}: Props) {
  const fixedSlotA0 =
    strategyLabel === "A0" &&
    (!bundle ||
      (!!bundle.allocationPolicy &&
        bundle.nextSession.executionDate >= bundle.allocationPolicy.effectiveDate));
  const nextSessionIsQuarter = Boolean(
    !fixedSlotA0 &&
    bundle?.nextQuarter &&
    bundle.nextSession.quarter === bundle.nextQuarter.quarter &&
    bundle.nextSession.executionDate === bundle.nextQuarter.executionDate,
  );
  return (
    <section
      className="min-w-0 rounded-lg border border-border bg-card p-4"
      aria-label={`${strategyLabel} 모델 조정 미리보기`}
    >
      <h2 className="text-sm font-semibold">{strategyLabel} 모델 조정 미리보기</h2>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        저장 자료만 조회 · 모든 날짜는 미국 거래일 기준 · 모델 자금 USD 기준의 예상이며 실제 체결
        내역이 아닙니다.
      </p>
      <p className="mt-2 rounded-md bg-muted p-2 text-[11px] leading-relaxed">
        실계좌 권장수량: 미산출. 실제 현금·주문예산이 확인되지 않아 모델 기본자금 $100,000을 실계좌
        수량으로 환산하지 않습니다.
      </p>
      <p className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        {fixedSlotA0
          ? "초기자금 USD ÷ 목표 20종목의 매입 예산을 고정합니다. 다음 미국 정규장 시가 기준이며, 실제 시가·현금·비용·거래대금 한도에 따라 수량이 달라질 수 있습니다."
          : "분기 조정의 모델 체결은 분기 첫 미국 정규장 시가를 기다립니다. 휴장일에는 체결하지 않으며, 실제 시가·현금·거래량 제약에 따라 수량이 달라질 수 있습니다. 아래 두 계획은 합산하지 않습니다."}
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-[11px] text-destructive">
          모델 조정 미리보기 조회 실패: {error}
        </p>
      ) : null}
      {bundle && !error ? (
        <div className="mt-3 space-y-3">
          {!fixedSlotA0 && bundle.nextQuarter ? (
            <Plan plan={bundle.nextQuarter} compact={compact} todayUs={todayUs} />
          ) : !fixedSlotA0 ? (
            <p className="rounded-md border p-3 text-[11px] text-muted-foreground">
              이 모델은 정기 분기 비중조정을 사용하지 않습니다. 다음 정규장 대기 조정을 확인하세요.
            </p>
          ) : null}
          {nextSessionIsQuarter ? (
            <p className="rounded-md bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground">
              다음 정규장이 분기 첫 거래일이므로 위 분기 계획이 다음 정규장 대기 조정에도
              적용됩니다. 같은 수량을 중복 표시하지 않습니다.
            </p>
          ) : (
            <Plan
              plan={bundle.nextSession}
              compact={compact}
              todayUs={todayUs}
              fixedSlotA0={fixedSlotA0}
            />
          )}
        </div>
      ) : (
        <div className="mt-3 rounded-md border p-3">
          <h3 className="text-xs font-semibold">모델 주문 계획 · 미확인</h3>
          <p
            role={isPending ? "status" : undefined}
            className="mt-1 text-[11px] text-muted-foreground"
          >
            {isPending
              ? "저장된 모델 조정 계획을 불러오는 중입니다."
              : error
                ? "조회 실패로 예정일과 수량을 확인할 수 없습니다."
                : "저장된 모델 자료가 없어 예정일과 수량을 확인할 수 없습니다. 조정 0건을 뜻하지 않습니다."}
          </p>
        </div>
      )}
      <p className="mt-3 text-[10px] leading-relaxed text-muted-foreground">
        {fixedSlotA0
          ? "신규 진입·전량 청산 신호와 체결 제약을 반영한 예상입니다. 정기 비중조정·신규 진입 자금 마련용 부분매도는 하지 않습니다."
          : "신규 진입·전량 청산 신호 집계와 별도입니다. 분기 리밸런싱과 진입 자금 마련을 위한 기존 종목 축소도 수량에 포함됩니다."}
      </p>
    </section>
  );
}
