import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/lib/cloud";
import {
  newActualPortfolioServer,
  type NewActualPortfolioResponse,
  type NewActualPortfolioRequest,
} from "@/lib/newActualPortfolio.functions";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import type { PortfolioAsset } from "./PortfolioAssetHub";

const START_DATE = "2026-10-12";
const labels = { KR: "한국주식", US: "미국주식", ETF: "ETF" };
const cashLabels = {
  DEPOSIT: "입금·배정",
  WITHDRAWAL: "출금·배정 회수",
  DIVIDEND: "배당",
  INTEREST: "이자",
  FEE: "별도 비용",
  TAX: "별도 세금",
} as const;
type Currency = "KRW" | "USD";
type CashKind = keyof typeof cashLabels;
type Pool = NewActualPortfolioResponse["pools"][Currency];
type Trade = Pool["trades"][number];
type CashEvent = Pool["cashEvents"][number];
type Request = NewActualPortfolioRequest;
type WithoutToken<T> = T extends unknown ? Omit<T, "accessToken"> : never;
type Market = "KOSPI" | "KOSDAQ" | "ETF" | "US";
const assetOf = (market: string): PortfolioAsset =>
  market === "US" ? "US" : market === "ETF" ? "ETF" : "KR";
const currencyOf = (asset: PortfolioAsset): Currency => (asset === "US" ? "USD" : "KRW");
const td = "whitespace-nowrap px-3 py-3 align-top";
const fieldClass = "w-full rounded-md border bg-background px-3 py-2 text-sm";
const RELOAD_MESSAGE =
  "저장 결과가 확실하지 않습니다. 새로고침으로 체결·현금을 대조한 뒤 입력을 닫고 다시 열어 주세요. 자동 재시도하지 않습니다.";

// eslint-disable-next-line react-refresh/only-export-components -- Export the market clock for deterministic date-boundary tests.
export function newActualMarketDay(currency: Currency, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: currency === "USD" ? "America/New_York" : "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((part) => parts.find((p) => p.type === part)?.value)
    .join("-");
}
function money(value: string | null | undefined, currency: Currency) {
  if (value == null) return "미확정";
  const [whole = "", fraction] = value.split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""} ${currency}`;
}
function issueLabel(issue: string) {
  const messages: Record<string, string> = {
    funding_pending: "실제 입금·배정 금액을 입력해 주세요.",
    funding_shortfall: "기록된 배정 현금 부족 · 입출금 내역 대조 필요",
    flow_adjusted_return_pending: "추가 입출금 반영 수익률 미확정",
    missing_price: "평가가격 미확인",
    stale_price: "평가가격이 오래되어 평가 미확정",
    future_price: "미래 평가가격 제외",
    price_before_last_fill: "최근 체결 이전 가격 · 평가 미확정",
    invalid_price: "평가가격 검증 필요",
    valuation_date_missing: "평가 기준일 미확인",
    future_valuation_date: "미래 평가일 제외",
  };
  const [code, ...context] = issue.split(":");
  return `${messages[code ?? ""] ?? issue}${messages[code ?? ""] && context.length ? ` (${context.join(":")})` : ""}`;
}
function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 break-words font-semibold tabular-nums">{children}</dd>
    </div>
  );
}
function PoolCard({ currency, pool }: { currency: Currency; pool: Pool | undefined }) {
  const pending = !pool || pool.fundingStatus === "PENDING";
  return (
    <section className="rounded-lg border bg-card p-4" aria-label={`${currency} 성과`}>
      <h3 className="font-semibold">
        {currency === "KRW" ? "한국·ETF 공동 원화" : "미국주식 달러"}
      </h3>
      <p className="mt-1 text-sm" role="status">
        {pending
          ? "자금 확인 대기"
          : pool.fundingStatus === "INCOMPLETE"
            ? "배정·평가 자료 확인 필요"
            : "실제 배정 현금 확인"}
      </p>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        <Metric label="순배정액">{money(pending ? null : pool.netContributions, currency)}</Metric>
        <Metric label="기록상 현금">{money(pending ? null : pool.cash, currency)}</Metric>
        <Metric label="보유 평가금액">{money(pool?.marketValue, currency)}</Metric>
        <Metric label="평가자산 (NAV)">{money(pending ? null : pool.nav, currency)}</Metric>
        <Metric label="실현손익">{money(pool?.realizedPnl, currency)}</Metric>
        <Metric label="미실현손익">{money(pool?.unrealizedPnl, currency)}</Metric>
        <Metric label="총손익">{money(pending ? null : pool.totalPnl, currency)}</Metric>
        <Metric label="수익률">
          {pending || pool.returnPercent == null ? "미확정" : `${pool.returnPercent}%`}
        </Metric>
      </dl>
      {!!pool?.issues.length && (
        <ul className="mt-3 space-y-1 text-xs text-warn">
          {pool.issues.map((issue, i) => (
            <li key={`${issue}-${i}`}>{issueLabel(issue)}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
function Table({
  title,
  heads,
  children,
  empty,
}: {
  title: string;
  heads: string[];
  children: ReactNode;
  empty: boolean;
}) {
  return (
    <section className="rounded-lg border bg-card" aria-label={title}>
      <h3 className="border-b p-3 font-semibold">{title}</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40">
            <tr>
              {heads.map((head) => (
                <th
                  key={head}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 text-left font-medium"
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {empty ? (
              <tr>
                <td colSpan={heads.length} className="p-6 text-center text-muted-foreground">
                  등록된 기록이 없습니다.
                </td>
              </tr>
            ) : (
              children
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
type ContentProps = {
  data?: NewActualPortfolioResponse | undefined;
  loading?: boolean;
  error?: string | null;
  asset: PortfolioAsset;
  onAssetChange: (asset: PortfolioAsset) => void;
  onExecution?: ((asset: PortfolioAsset, trade?: Trade) => void) | undefined;
  onCancelExecution?: ((trade: Trade) => void) | undefined;
  onCash?: ((currency: Currency, event?: CashEvent) => void) | undefined;
  onCancelCash?: ((currency: Currency, event: CashEvent) => void) | undefined;
  writesDisabled?: boolean;
  onReload?: (() => void) | undefined;
  refreshing?: boolean;
  children?: ReactNode;
};

/** Presentation receives only the new-series projection, never a legacy holding or signal. */
export function NewActualPortfolioContent({
  data,
  loading = false,
  error = null,
  asset,
  onAssetChange,
  onExecution,
  onCancelExecution,
  onCash,
  onCancelCash,
  writesDisabled = false,
  onReload,
  refreshing = false,
  children,
}: ContentProps) {
  const available = !loading && !error;
  const pools = available ? data?.pools : undefined;
  const currency = currencyOf(asset);
  const pool = pools?.[currency];
  const positions = (pool?.positions ?? []).filter((position) => position.asset === asset);
  const trades = (pool?.trades ?? []).filter((trade) => assetOf(trade.execution.market) === asset);
  const revision = asset === "US" ? data?.usRevision : data?.domesticRevision;
  const assetWriteDisabled = writesDisabled || !available || revision == null;
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="text-xl font-bold">실제 포트폴리오</h1>
        {onReload && (
          <Button variant="outline" disabled={refreshing} onClick={onReload}>
            {refreshing ? "확인 중…" : "새로고침"}
          </Button>
        )}
      </header>
      <p className="text-sm text-muted-foreground">
        독립 모델 기록은{" "}
        <Link to="/shadow" className="text-primary underline">
          Shadow
        </Link>
        에서 확인합니다.
      </p>
      {children}
      {loading ? (
        <p role="status" className="rounded-lg border p-4">
          포트폴리오를 불러오는 중입니다.
        </p>
      ) : error ? (
        <p role="alert" className="rounded-lg border border-destructive p-4">
          포트폴리오를 확인하지 못했습니다. {error}
        </p>
      ) : (
        <>
          {!!data?.warnings.length && (
            <ul role="status" className="space-y-1 rounded-lg border border-warn p-3 text-sm">
              {data.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <PoolCard currency="KRW" pool={pools?.KRW} />
            <PoolCard currency="USD" pool={pools?.USD} />
          </div>
          <div className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
            <p>USD 환율·배정 기준이 미확정이므로 원화 합산 수익률은 표시하지 않습니다.</p>
            <p>주문 가능 금액은 증권사 잔고·결제 현황에서 확인하세요.</p>
            <p>
              평가가격·기준일은 보유 내역에서 확인하세요. 시세가 없거나 오래되면 평가자산·수익률은
              대기 상태입니다.
            </p>
          </div>
        </>
      )}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="포트폴리오 자산군">
        {(["KR", "US", "ETF"] as const).map((key) => (
          <Button
            key={key}
            id={`new-asset-${key}`}
            role="tab"
            aria-selected={asset === key}
            aria-controls="new-actual-panel"
            tabIndex={asset === key ? 0 : -1}
            onKeyDown={(event) => {
              const keys = ["KR", "US", "ETF"] as const;
              const index = keys.indexOf(key);
              const nextIndex =
                event.key === "ArrowRight"
                  ? (index + 1) % keys.length
                  : event.key === "ArrowLeft"
                    ? (index + keys.length - 1) % keys.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? keys.length - 1
                        : null;
              if (nextIndex === null) return;
              event.preventDefault();
              const next = keys[nextIndex]!;
              onAssetChange(next);
              document.getElementById(`new-asset-${next}`)?.focus();
            }}
            variant={asset === key ? "default" : "outline"}
            onClick={() => onAssetChange(key)}
          >
            {labels[key]}
          </Button>
        ))}
      </div>
      <section
        id="new-actual-panel"
        role="tabpanel"
        aria-labelledby={`new-asset-${asset}`}
        className="space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">{labels[asset]}</h2>
          {onExecution && (
            <Button disabled={assetWriteDisabled} onClick={() => onExecution(asset)}>
              실제 체결 입력
            </Button>
          )}
        </div>
        {available && revision == null && (
          <p className="text-xs text-warn">
            저장 정보를 확인하지 못했습니다. 새로고침 후 입력을 다시 열어 주세요.
          </p>
        )}
        {available && (
          <>
            <Table
              title="보유 내역"
              heads={[
                "종목",
                "수량",
                "매입원가",
                "평균단가",
                "평가가격 · 기준일",
                "평가금액",
                "미실현손익",
              ]}
              empty={!positions.length}
            >
              {positions.map((position) => (
                <tr key={`${position.market}-${position.symbol}`} className="border-t">
                  <td className={td}>
                    {position.name}
                    <div className="text-xs text-muted-foreground">
                      {position.symbol} · {position.market}
                    </div>
                  </td>
                  <td className={td}>{position.quantity}</td>
                  <td className={td}>{money(position.cost, currency)}</td>
                  <td className={td}>{money(position.averagePrice, currency)}</td>
                  <td className={td}>
                    {money(position.currentPrice, currency)}
                    <div className="text-xs text-muted-foreground">
                      가격 기준일 {position.priceDate ?? "미확정"}
                    </div>
                  </td>
                  <td className={td}>{money(position.marketValue, currency)}</td>
                  <td className={td}>{money(position.unrealizedPnl, currency)}</td>
                </tr>
              ))}
            </Table>
            <Table
              title="체결 내역"
              heads={[
                "체결일",
                "종목",
                "구분",
                "배정 수량 / 전체 수량",
                "배정 금액 · 비용",
                "실현손익",
                "증권사 체결 근거",
                "관리",
              ]}
              empty={!trades.length}
            >
              {trades.map((trade) => (
                <tr key={trade.execution.id} className="border-t">
                  <td className={td}>{trade.execution.date}</td>
                  <td className={td}>
                    {trade.execution.name}
                    <div className="text-xs text-muted-foreground">
                      {trade.execution.symbol} · {trade.execution.market}
                    </div>
                  </td>
                  <td className={td}>{trade.execution.side === "BUY" ? "매수" : "매도"}</td>
                  <td className={td}>
                    {trade.allocation.quantity} / {trade.execution.shares}
                  </td>
                  <td className={td}>
                    {money(String(trade.allocation.gross), currency)}
                    <div className="text-xs text-muted-foreground">
                      비용 {money(String(trade.allocation.fee), currency)}
                    </div>
                  </td>
                  <td className={td}>{money(trade.realizedPnl, currency)}</td>
                  <td className={`${td} max-w-64 whitespace-normal break-words`}>
                    {trade.allocation.brokerReference}
                  </td>
                  <td className={td}>
                    <div className="flex gap-2">
                      {onExecution && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={assetWriteDisabled}
                          aria-label={`${trade.execution.name} ${trade.execution.date} 체결 정정`}
                          onClick={() => onExecution(asset, trade)}
                        >
                          정정
                        </Button>
                      )}
                      {onCancelExecution && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={assetWriteDisabled}
                          aria-label={`${trade.execution.name} ${trade.execution.date} 체결 기록 취소`}
                          onClick={() => onCancelExecution(trade)}
                        >
                          기록 취소
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
            <p className="text-xs text-muted-foreground">
              이 포트폴리오에 배정한 수량·금액·비용입니다. 정정·취소는 기록에만 반영됩니다.
            </p>
          </>
        )}
      </section>
      {available && (
        <section className="space-y-4" aria-label="현금 내역">
          <h2 className="font-semibold">입출금 내역</h2>
          <p className="text-sm">한국·ETF 공동 원화 현금, 한 번만 입력. USD는 별도 관리합니다.</p>
          <p className="text-xs text-muted-foreground">
            실제 입금·배정한 금액만 기록하세요. 체결에 포함한 수수료·세금은 중복 입력하지 마세요.
          </p>
          {(["KRW", "USD"] as const).map((ccy) => {
            const events = pools?.[ccy].cashEvents ?? [];
            const disabled =
              writesDisabled || (ccy === "USD" ? data?.usRevision : data?.domesticRevision) == null;
            return (
              <div key={ccy} className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {ccy === "KRW" ? "한국·ETF 공동 원화" : "미국 달러"}
                  </h3>
                  {onCash && (
                    <Button variant="outline" disabled={disabled} onClick={() => onCash(ccy)}>
                      {ccy} 현금 입력
                    </Button>
                  )}
                </div>
                <Table
                  title={`${ccy} 현금 기록`}
                  heads={["일자", "구분", "금액", "배정·입출금 근거", "상태", "관리"]}
                  empty={!events.length}
                >
                  {events.map((event) => (
                    <tr key={event.id} className="border-t">
                      <td className={td}>{event.date}</td>
                      <td className={td}>{cashLabels[event.kind]}</td>
                      <td className={td}>{money(String(event.amount), ccy)}</td>
                      <td className={`${td} max-w-72 whitespace-normal break-words`}>
                        {event.reference}
                      </td>
                      <td className={td}>{event.voided ? "취소됨" : "반영"}</td>
                      <td className={td}>
                        {!event.voided && (
                          <div className="flex gap-2">
                            {onCash && (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={disabled}
                                aria-label={`${ccy} ${event.date} ${cashLabels[event.kind]} 정정`}
                                onClick={() => onCash(ccy, event)}
                              >
                                정정
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
type ExecutionDraft = Session & {
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
        증권사에서 확인한 체결일·단가·수량·비용을 입력하세요. 혼합 체결은 이 포트폴리오에 배정할
        부분을 따로 입력합니다.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
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
        <Field label={`원체결 단가 (${ccy})`}>
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
        <Field label="원체결 전체 수량 (정수)">
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
        <Field label={`원체결 전체 비용·세금 (${ccy})`}>
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
      <Field label="메모">
        <textarea
          className={fieldClass}
          rows={2}
          maxLength={300}
          value={draft.note}
          onChange={(e) => patch({ note: e.target.value })}
        />
      </Field>
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
        <Field label="실제 발생일">
          <Input
            type="date"
            required
            min={START_DATE}
            max={newActualMarketDay(draft.currency)}
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
}: {
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
    gcTime: 0,
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () =>
      newActualPortfolioServer({ data: { action: "load", accessToken: await token(owner!) } }),
  });
  function session(currency: Currency): Session | null {
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
  }
  function openExecution(nextAsset: PortfolioAsset, trade?: Trade) {
    const opened = session(currencyOf(nextAsset));
    if (!opened) return;
    const execution = trade?.execution;
    setDraft({
      ...opened,
      kind: "execution",
      asset: nextAsset,
      id: execution?.id ?? "",
      symbol: execution?.symbol ?? "",
      name: execution?.name ?? "",
      market: (execution?.market ??
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
  }
  function openCash(currency: Currency, event?: CashEvent) {
    const opened = session(currency);
    if (!opened) return;
    setDraft({
      ...opened,
      kind: "cash",
      currency,
      id: event?.id ?? "",
      date: event?.date ?? newActualMarketDay(currency),
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
    if (!guard.current.pending) setDraft(null);
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
          throw new Error("종목·원체결 단가·정수 수량·비용을 확인해 주세요.");
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
        if (
          !current.date ||
          current.date < START_DATE ||
          current.date > newActualMarketDay(current.currency)
        )
          throw new Error(
            "발생일은 2026-10-12부터 현지 오늘까지 입력할 수 있습니다. 시작 전 준비는 입금이 아닙니다.",
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
                ? `${draft.id ? "체결 정정" : "실제 체결 입력"} · ${labels[draft.asset]}`
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
              {newActualMarketDay(
                draft.kind === "cash" || draft.kind === "cancelCash"
                  ? draft.currency
                  : currencyOf(draft.asset),
              ) < START_DATE && (
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
