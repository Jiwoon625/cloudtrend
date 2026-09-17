import { supabase, userId } from "@/lib/cloud";

const money = (value: number) => Math.round(value * 100) / 100;
const rate = (value: number) => Math.round(value * 1_000_000) / 1_000_000;

/**
 * 자동 기록된 다음 거래일 시가 체결을 실제 체결가/수량으로 보정한다.
 * 신호일·진입일·전략 신호는 유지하고 체결값만 수정하며, 이후 자동 동기화가 이 값을 덮어쓰지 않는다.
 * 수량 0주는 실제 미매수로 기록해 P30 보유수·현금·손익 계산에서 제외한다.
 * 이미 청산된 거래라면 수정된 원가/수량을 기준으로 실현손익도 즉시 재계산한다.
 */
export async function updatePortfolioEntryExecution(
  tradeId: string,
  entryPrice: number,
  shares: number,
): Promise<void> {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0)
    throw new Error("실제 진입가격은 0보다 큰 금액이어야 합니다.");
  if (!Number.isInteger(shares) || shares < 0)
    throw new Error("실제 매수수량은 0주 이상의 정수로 입력해 주세요.");

  const uid = await userId();
  const [{ data: settings, error: settingsError }, { data: trade, error: tradeError }] =
    await Promise.all([
      supabase
        .from("portfolio_settings")
        .select("round_trip_cost_rate")
        .eq("user_id", uid)
        .single(),
      supabase
        .from("portfolio_trades")
        .select("id,entry_date,entry_status,status,exit_price,exit_reason")
        .eq("user_id", uid)
        .eq("id", tradeId)
        .single(),
    ]);

  if (settingsError) throw settingsError;
  if (tradeError) throw tradeError;

  const roundTripCostRate = Number(settings.round_trip_cost_rate);
  const halfCost = Number.isFinite(roundTripCostRate) ? roundTripCostRate / 2 : 0.0015;
  const buyAmount = money(entryPrice * shares);
  const entryFee = money(buyAmount * halfCost);
  const baseStatus = String(trade.entry_status ?? "KOSDAQ 8 ONSET")
    .replace(/\s*·\s*실제체결 수정$/, "")
    .replace(/\s*·\s*미매수$/, "");

  const patch: Record<string, unknown> = {
    entry_price: money(entryPrice),
    shares,
    buy_amount: buyAmount,
    entry_fee: entryFee,
    updated_at: new Date().toISOString(),
  };

  if (shares === 0) {
    patch.entry_status = `${baseStatus} · 미매수`;
    patch.status = "CLOSED";
    patch.current_status = "미매수 · P30 제외";
    patch.holding_days = 0;
    patch.mark_date = trade.entry_date;
    patch.current_price = null;
    patch.exit_signal_date = null;
    patch.exit_date = trade.entry_date;
    patch.exit_price = money(entryPrice);
    patch.exit_reason = "미매수 · 실제 체결 0주";
    patch.exit_fee = 0;
    patch.realized_pnl = 0;
    patch.realized_return = 0;
  } else {
    patch.entry_status = `${baseStatus} · 실제체결 수정`;

    const wasNoFill = String(trade.exit_reason ?? "").startsWith("미매수");
    if (wasNoFill) {
      patch.status = "OPEN";
      patch.current_status = "보유 · 실제체결 수정";
      patch.holding_days = 1;
      patch.mark_date = trade.entry_date;
      patch.current_price = money(entryPrice);
      patch.exit_signal_date = null;
      patch.exit_date = null;
      patch.exit_price = null;
      patch.exit_reason = null;
      patch.exit_fee = 0;
      patch.realized_pnl = null;
      patch.realized_return = null;
    } else if (trade.status === "CLOSED" && trade.exit_price !== null) {
      const exitPrice = Number(trade.exit_price);
      if (Number.isFinite(exitPrice) && exitPrice > 0) {
        const exitGross = shares * exitPrice;
        const exitFee = money(exitGross * halfCost);
        const costBasis = buyAmount + entryFee;
        const realizedPnl = money(exitGross - exitFee - costBasis);
        patch.exit_fee = exitFee;
        patch.realized_pnl = realizedPnl;
        patch.realized_return = costBasis > 0 ? rate((realizedPnl / costBasis) * 100) : 0;
      }
    }
  }

  const { error } = await supabase
    .from("portfolio_trades")
    .update(patch)
    .eq("user_id", uid)
    .eq("id", tradeId);
  if (error) throw error;
}
