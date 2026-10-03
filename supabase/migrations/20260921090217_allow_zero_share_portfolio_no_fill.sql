
alter table public.portfolio_trades
  drop constraint if exists portfolio_trades_shares_check;

alter table public.portfolio_trades
  add constraint portfolio_trades_shares_check
  check (shares >= 0);

alter table public.portfolio_trades
  drop constraint if exists portfolio_trades_buy_amount_check;

alter table public.portfolio_trades
  add constraint portfolio_trades_buy_amount_check
  check (buy_amount >= 0);
