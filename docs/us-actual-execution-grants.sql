revoke update on public.us_portfolio_trades from authenticated, anon;
grant update (actual_price, actual_shares, actual_fee_usd, updated_at) on public.us_portfolio_trades to authenticated;
alter policy us_portfolio_trades_owner_update on public.us_portfolio_trades
using ((select auth.uid()) = user_id and strategy_id = 'A0_QUARTER_PRIMARY' and status in ('EXECUTED','PARTIAL'))
with check ((select auth.uid()) = user_id and strategy_id = 'A0_QUARTER_PRIMARY' and status in ('EXECUTED','PARTIAL'));
