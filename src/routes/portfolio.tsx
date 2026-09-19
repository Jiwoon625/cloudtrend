import { StrategyDescription } from "@/components/StrategyDescription";
import { createFileRoute, Link } from "@tanstack/react-router";
import { BriefcaseBusiness, Loader2, Pencil, RefreshCw, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { AppShell } from "@/components/AppShell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatNumber, formatPercent, formatPrice, formatWon } from "@/lib/format";
import { updatePortfolioEntryExecution } from "@/lib/portfolioManualEdit";
import {
  savePortfolioCapital,
  syncPortfolioFromHistory,
  type PortfolioState,
  type PortfolioTrade,
} from "@/lib/portfolioStore";

export const Route = createFileRoute("/portfolio")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "포트폴리오 | CloudTrend V8 Final" },
      {
        name: "description",
        content:
          "스크리닝 이력의 KOSPI / KOSDAQ 8.0 Onset과 Exit 신호를 실제 운용 규칙에 따라 다음 거래일 시가 기준 가상 매매 원장으로 기록합니다.",
      },
    ],
  }),
  component: PortfolioPage,
});

function pnlClass(value: number | null | undefined) {
  if (!value) return "text-muted-foreground";
  return value > 0 ? "text-up" : "text-down";
}

function moneyInputValue(value: number) {
  return String(Math.round(value));
}

function tradeMark(trade: PortfolioTrade, halfCost: number) {
  if (trade.status === "CLOSED") return { marketValue: null, pnl: null, returnPct: null };
  const current = trade.currentPrice ?? trade.entryPrice;
  const marketValue = trade.shares * current;
  const exitFee = marketValue * halfCost;
  const cost = trade.buyAmount + trade.entryFee;
  const pnl = marketValue - exitFee - cost;
  return {
    marketValue,
    pnl,
    returnPct: cost > 0 ? (pnl / cost) * 100 : null,
  };
}

function SummaryItem({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2">
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`num mt-0.5 text-sm font-semibold ${valueClass ?? ""}`}>{value}</p>
    </div>
  );
}

function PortfolioPage() {
  const [state, setState] = useState<PortfolioState | null>(null);
  const [capital, setCapital] = useState("10000000");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editingTrade, setEditingTrade] = useState<PortfolioTrade | null>(null);
  const [editPrice, setEditPrice] = useState("");
  const [editShares, setEditShares] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await syncPortfolioFromHistory();
      setState(next);
      setCapital(moneyInputValue(next.settings.initialCapital));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "포트폴리오 동기화에 실패했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sortedTrades = useMemo(
    () =>
      state
        ? [...state.trades].sort((a, b) => {
            if (a.status !== b.status) return a.status === "OPEN" ? -1 : 1;
            return b.entryDate.localeCompare(a.entryDate) || a.symbol.localeCompare(b.symbol);
          })
        : [],
    [state],
  );

  const saveCapital = async () => {
    const amount = Number(capital.replaceAll(",", ""));
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("운용자금을 올바르게 입력해 주세요.");
      return;
    }
    setSaving(true);
    try {
      await savePortfolioCapital(amount);
      const next = await syncPortfolioFromHistory();
      setState(next);
      setCapital(moneyInputValue(next.settings.initialCapital));
      toast.success("운용자금을 저장했습니다. 이후 신규 진입 수량에 적용됩니다.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "운용자금 저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  };

  const startEntryEdit = (trade: PortfolioTrade) => {
    setEditingTrade(trade);
    setEditPrice(String(Math.round(trade.entryPrice)));
    setEditShares(String(trade.shares));
  };

  const saveEntryEdit = async () => {
    if (!editingTrade) return;
    const price = Number(editPrice.replaceAll(",", ""));
    const shares = Number(editShares.replaceAll(",", ""));
    if (!Number.isFinite(price) || price <= 0) {
      toast.error("실제 진입가격을 올바르게 입력해 주세요.");
      return;
    }
    if (!Number.isInteger(shares) || shares < 0) {
      toast.error("실제 매수수량은 0주 이상의 정수로 입력해 주세요.");
      return;
    }
    setEditSaving(true);
    try {
      await updatePortfolioEntryExecution(editingTrade.id, price, shares);
      const next = await syncPortfolioFromHistory();
      setState(next);
      setEditingTrade(null);
      toast.success(
        shares === 0
          ? "미매수(0주)로 저장했습니다. P30 보유 종목 수에서 제외됩니다."
          : "실제 체결값으로 수정했습니다. 이후 자동 동기화에서도 유지됩니다.",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "체결값 수정에 실패했습니다.");
    } finally {
      setEditSaving(false);
    }
  };

  return (
    <AppShell>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <BriefcaseBusiness className="size-5 text-primary" />
            포트폴리오 · 실제운용 추적
          </h1>
          <p className="text-[12px] text-muted-foreground">
            스크리닝 이력의 KOSPI / KOSDAQ 8.0 Onset은 다음 거래일 시가에 가상 매수하고, Exit 신호는
            다음 거래일 시가에 가상 매도합니다. 60거래일 만기는 해당일 종가로 처리합니다.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          이력 동기화
        </Button>
      </div>

      <StrategyDescription />
      <section className="mb-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[240px] flex-1 text-[12px] font-medium">
            전체 운용자금
            <div className="mt-1.5 flex gap-2">
              <Input
                type="number"
                min="1"
                step="10000"
                value={capital}
                onChange={(event) => setCapital(event.target.value)}
                className="num"
              />
              <Button onClick={() => void saveCapital()} disabled={saving} className="gap-1.5">
                {saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Save className="size-3.5" />
                )}
                저장
              </Button>
            </div>
          </label>
          <div className="min-w-[210px] rounded-lg bg-muted/40 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
            P30 기준 목표금액은 운용자금 ÷ 30입니다. 실제 수량은 다음 거래일 시가에서 목표금액에
            가장 가까운 정수 주식 수로 결정합니다.
          </div>
        </div>
        <p className="mt-2 text-[10px] text-muted-foreground">
          운용자금 변경은 기존 체결기록을 소급 수정하지 않고 이후 신규 진입의 목표금액·수량에
          적용됩니다. 동일 섹터 신규 진입은 최대 30%, 거래비용은 왕복 0.30% 가정입니다.
        </p>
      </section>

      {loading && !state ? (
        <section className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
          <Loader2 className="mx-auto mb-2 size-5 animate-spin" />
          스크리닝 이력과 포트폴리오 원장을 동기화하는 중입니다…
        </section>
      ) : state ? (
        <>
          <section className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <SummaryItem label="기준 운용자금" value={formatWon(state.settings.initialCapital)} />
            <SummaryItem label="1개 슬롯 목표" value={formatWon(state.summary.slotTargetAmount)} />
            <SummaryItem
              label="보유 종목"
              value={`${state.summary.openPositions} / ${state.settings.maxPositions}`}
            />
            <SummaryItem label="현금" value={formatWon(state.summary.cash)} />
            <SummaryItem
              label="총 평가자산"
              value={formatWon(state.summary.equity)}
              valueClass={pnlClass(state.summary.totalPnl)}
            />
            <SummaryItem
              label="평가손익"
              value={formatWon(state.summary.unrealizedPnl)}
              valueClass={pnlClass(state.summary.unrealizedPnl)}
            />
            <SummaryItem
              label="실현손익"
              value={formatWon(state.summary.realizedPnl)}
              valueClass={pnlClass(state.summary.realizedPnl)}
            />
            <SummaryItem
              label="누적손익"
              value={formatWon(state.summary.totalPnl)}
              valueClass={pnlClass(state.summary.totalPnl)}
            />
            <SummaryItem
              label="누적수익률"
              value={formatPercent(state.summary.totalReturn, 2)}
              valueClass={pnlClass(state.summary.totalReturn)}
            />
            <SummaryItem label="최근 반영 데이터" value={state.summary.latestDate ?? "-"} />
          </section>

          {editingTrade ? (
            <section className="mb-4 rounded-lg border border-primary/30 bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">실제 체결값 수정 · {editingTrade.name}</h2>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    신호일 {editingTrade.signalDate} · 진입일 {editingTrade.entryDate}은 전략
                    기록으로 유지합니다. 자동 입력된 다음 거래일 시가와 실제 체결이 다를 때
                    진입가격과 수량만 보정합니다.
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="수정 취소"
                  className="rounded p-1 text-muted-foreground hover:text-foreground"
                  onClick={() => setEditingTrade(null)}
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                <label className="text-[11px] font-medium">
                  실제 진입가격
                  <Input
                    className="num mt-1"
                    type="number"
                    min="1"
                    step="1"
                    value={editPrice}
                    onChange={(event) => setEditPrice(event.target.value)}
                  />
                </label>
                <label className="text-[11px] font-medium">
                  실제 매수수량
                  <Input
                    className="num mt-1"
                    type="number"
                    min="0"
                    step="1"
                    value={editShares}
                    onChange={(event) => setEditShares(event.target.value)}
                  />
                </label>
                <Button
                  className="gap-1.5"
                  disabled={editSaving}
                  onClick={() => void saveEntryEdit()}
                >
                  {editSaving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  체결값 저장
                </Button>
              </div>
              <p className="mt-2 text-[10px] text-muted-foreground">
                실제로 매수하지 않았다면 수량을 0주로 저장하세요. 해당 신호는 원장에는 남지만 P30
                보유 종목 수·섹터 한도·현금·손익 계산에서는 제외됩니다. 1주 이상이면
                매수금액·거래비용·평가손익을 다시 계산하며, 이미 청산된 거래라면 실현손익도 수정된
                실제 체결가와 수량 기준으로 재계산됩니다.
              </p>
            </section>
          ) : null}

          <section className="overflow-hidden rounded-lg border border-border bg-card">
            <div className="border-b border-border bg-surface-strong px-3 py-2">
              <h2 className="text-sm font-semibold">매수·매도 원장 · 전체 거래</h2>
              <p className="text-[11px] text-muted-foreground">
                신호일과 실제 체결일을 분리합니다. 예: 9/17 ONSET → 9/18 데이터를 업로드한 시점에
                9/18 시가로 매수기록 생성. 청산된 거래와 미매수(0주) 신호도 삭제하지 않고 원장에
                계속 남깁니다.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[2140px] text-[11px]">
                <thead>
                  <tr className="border-b border-border bg-card text-muted-foreground [&>th]:text-center">
                    <th className="px-2 py-2 text-left font-medium">종목</th>
                    <th className="px-2 py-2 text-left font-medium">시장</th>
                    <th className="px-2 py-2 text-left font-medium">신호일</th>
                    <th className="px-2 py-2 text-left font-medium">진입일</th>
                    <th className="px-2 py-2 text-right font-medium">진입가격</th>
                    <th className="px-2 py-2 text-right font-medium">진입점수 (기술/우선)</th>
                    <th className="px-2 py-2 text-left font-medium">진입상태</th>
                    <th className="px-2 py-2 text-right font-medium">목표비중</th>
                    <th className="px-2 py-2 text-right font-medium">매수금액</th>
                    <th className="px-2 py-2 text-right font-medium">수량</th>
                    <th className="px-2 py-2 text-right font-medium">현재가</th>
                    <th className="px-2 py-2 text-right font-medium">평가금액</th>
                    <th className="px-2 py-2 text-right font-medium">평가손익</th>
                    <th className="px-2 py-2 text-right font-medium">수익률</th>
                    <th className="px-2 py-2 text-right font-medium">보유일수</th>
                    <th className="px-2 py-2 text-right font-medium">현재 기술점수</th>
                    <th className="px-2 py-2 text-left font-medium">현재 상태</th>
                    <th className="px-2 py-2 text-left font-medium">Exit일</th>
                    <th className="px-2 py-2 text-right font-medium">Exit가격</th>
                    <th className="px-2 py-2 text-left font-medium">Exit사유</th>
                    <th className="px-2 py-2 text-right font-medium">실현손익</th>
                    <th className="px-2 py-2 text-center font-medium">체결수정</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedTrades.length === 0 ? (
                    <tr>
                      <td colSpan={22} className="px-3 py-10 text-center text-muted-foreground">
                        아직 체결된 가상 포지션이 없습니다. KOSPI / KOSDAQ 8.0 Onset이 발생한 다음
                        거래일 데이터가 업로드되면 자동으로 기록됩니다.
                      </td>
                    </tr>
                  ) : (
                    sortedTrades.map((trade) => {
                      const mark = tradeMark(trade, state.settings.roundTripCostRate / 2);
                      const noFill =
                        trade.shares === 0 && (trade.exitReason ?? "").startsWith("미매수");
                      return (
                        <tr key={trade.id} className="border-b border-border/60 last:border-0">
                          <td className="whitespace-nowrap px-2 py-2">
                            <Link
                              to="/instrument/$symbol"
                              params={{ symbol: trade.symbol }}
                              className="font-medium hover:underline"
                            >
                              {trade.name}
                            </Link>
                            <span className="num ml-1 text-[9px] text-muted-foreground">
                              {trade.symbol}
                            </span>
                          </td>
                          <td className="px-2 py-2">{trade.market}</td>
                          <td className="num px-2 py-2">{trade.signalDate}</td>
                          <td className="num px-2 py-2">{trade.entryDate}</td>
                          <td className="num px-2 py-2 text-right">
                            {formatPrice(trade.entryPrice)}
                          </td>
                          <td className="num px-2 py-2 text-right font-medium">
                            {formatNumber(trade.entryTechnicalPoints, 1)} /{" "}
                            {formatNumber(trade.entryPriorityPoints, 1)}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2">
                            <Badge variant="outline" className="text-[9px] text-up">
                              {trade.entryStatus}
                            </Badge>
                          </td>
                          <td className="num px-2 py-2 text-right">
                            {(trade.targetWeight * 100).toFixed(2)}%
                          </td>
                          <td className="num px-2 py-2 text-right">{formatWon(trade.buyAmount)}</td>
                          <td className="num px-2 py-2 text-right">
                            {trade.shares.toLocaleString("ko-KR")}주
                          </td>
                          <td className="num px-2 py-2 text-right">
                            {trade.status === "OPEN" ? formatPrice(trade.currentPrice) : "-"}
                          </td>
                          <td className="num px-2 py-2 text-right">
                            {mark.marketValue === null ? "-" : formatWon(mark.marketValue)}
                          </td>
                          <td
                            className={`num px-2 py-2 text-right font-medium ${pnlClass(mark.pnl)}`}
                          >
                            {mark.pnl === null ? "-" : formatWon(mark.pnl)}
                          </td>
                          <td
                            className={`num px-2 py-2 text-right font-medium ${pnlClass(mark.returnPct)}`}
                          >
                            {mark.returnPct === null ? "-" : formatPercent(mark.returnPct, 2)}
                          </td>
                          <td className="num px-2 py-2 text-right">{trade.holdingDays}</td>
                          <td className="num px-2 py-2 text-right">
                            {formatNumber(trade.currentTechnicalPoints, 1)}
                          </td>
                          <td className="max-w-[220px] px-2 py-2">{trade.currentStatus ?? "-"}</td>
                          <td className="num px-2 py-2">
                            {noFill ? "-" : (trade.exitDate ?? "-")}
                          </td>
                          <td className="num px-2 py-2 text-right">
                            {noFill ? "-" : formatPrice(trade.exitPrice)}
                          </td>
                          <td className="whitespace-nowrap px-2 py-2">{trade.exitReason ?? "-"}</td>
                          <td
                            className={`num px-2 py-2 text-right font-semibold ${pnlClass(trade.realizedPnl)}`}
                          >
                            {trade.realizedPnl === null ? "-" : formatWon(trade.realizedPnl)}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 gap-1 px-2 text-[10px]"
                              onClick={() => startEntryEdit(trade)}
                            >
                              <Pencil className="size-3" /> 수정
                            </Button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </AppShell>
  );
}
