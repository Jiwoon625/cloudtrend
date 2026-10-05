# CM research result report template

Use only completed, hash-verified results. Bracketed fields are placeholders;
this template contains no historical performance results.

## Scope and verification

- Run/plan/strategy identity: [IDs and code SHA]
- Evaluation: 2017-08-21 to 2026-09-11; initial capital KRW100m
- Selected candidate count: [n]; completed verified: [n]; paused/blocked: [n]
- Costs: 0.15% per side, 0.30% round trip; additional FX spread0
- Known-action profile: 25 direct plus2 deferred exact-unit handlers; US cash-merger T+5
- Price exception rule: retrospective last-valid-close exit proxy, current missing
  session recognition, ordinary settlement from that trigger session
- Source/runtime/result hashes: [verified references]
- Disclosure: current-vintage comparison, not certified PIT, actual historical
  execution or complete after-tax wealth; unmodeled rights remain disclosed

## Completed candidate comparison

| Candidate | Total return | CAGR | MDD | Buy fills | Ordinary sell fills | Proxy exits | Mean daily invested weight | Mean daily cash weight | Turnover |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| [ID] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

Definitions and exact sources:

- Total return/CAGR/MDD: `summary.json → performance`; includes the initial
  capital baseline and modeled transaction costs. CAGR is annualized over
  elapsed calendar time; report the exact period alongside it
- Buy/sell fill counts: unique ledger `id` values in `events.csv`, with `kind`
  BUY/SELL. Separate `execution_class=RETROSPECTIVE_EXIT_PROXY` from ordinary
  sells; never count both the SELL event and its extra audit event as two trades
- Mean daily invested/cash weights: average `market_value_krw/gross_nav_krw` and
  `cash_krw/gross_nav_krw` on the common daily cutoff rows in `nav.csv`
- Receivable weight: `receivable_krw/gross_nav_krw`, separate from spendable cash
- Engine NAV shares: `nav_K`, `nav_E`, `nav_U` (or P/Q/E/U) divided by total NAV.
  These include sleeve cash/receivables; do not call them pure invested exposure
- Concentration/position-count diagnostics: `exposure_diagnostics.csv` at its
  recorded market-close times. State the sampling clock; do not silently mix
  these observations with the common daily NAV-cutoff averages
- Turnover: choose and state the convention before comparing candidates.
  Recommended descriptive convention: sum of BUY+SELL gross KRW consideration
  divided by mean daily gross NAV, with annualization separately labeled.
  Include proxy sales, and provide their turnover subtotal. Mandatory nontrade
  corporate-action conversions are separate, not fabricated market fills

## Retrospective exit audit and accounting contribution

| Engine/symbol | Trigger session | Reference-price date | Recognition time | Cash available time | Quantity | Proxy price | Sell fee (KRW) | Realized gross P&L (KRW) |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] | [ ] |

Join `retrospective_exit_proxy_audit.csv.fill_id` to the unique SELL event in
`events.csv`. For each joined event:

- Gross proceeds KRW = quantity × price × event FX
- Sell fee KRW = fee × event FX
- Realized gross P&L KRW = ledger `gross_pnl_krw`
- Sell-side net realized accounting contribution = gross_pnl_krw − sell fee KRW
- Recognition occurs on the trigger session; cash becomes usable only at the
  separately recorded settlement timestamp

Report totals and percentage of initial capital, plus the number of affected
names/strategies. These totals are **accounting contributions of proxy exits**,
not a causal or counterfactual performance benefit from the fallback rule.
Entry fees are already reflected in portfolio NAV and should not be silently
counted twice or described as included in a sell-side-only subtotal. Without a
separately defined comparable alternative path, leave “strategy return gained
because of fallback” as **not estimated**.

## Controls, interpretation and next action

- Reconcile `final_snapshot.bridge_residual_krw` and ledger balance checks
- Confirm no cash was backdated to a reference-price date and no historical NAV
  rows were rewritten
- Summarize known corporate actions and unresolved-rights encounters separately
- Compare S04/S05 controls, return/drawdown/cash-use/turnover and family diversity
- Mark unfinished candidates “not ranked”; do not mix partial-period paths into
  a full-period leaderboard or force a fixed number of finalists
- Record the actual setup/runtime/RSS/disk/checkpoint measurements before wider
  dispatch decisions
- Next step: [specific verified batch or decision], with any remaining gate
