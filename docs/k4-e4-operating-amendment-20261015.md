# K4 / E4 operating amendment

Owner instruction: add KOSPI K4 and ETF E4 to the existing operating exits and deploy, preserving historical records and unrelated strategies.

## Contract

`holding-price-exit-k4-e4-v1`, effective from the confirmed domestic close on **2026-10-15**. It is not an intraday stop order. K4 compares close × remaining quantity with 92% of acquisition cost including entry fees. E4 compares close with 90% of the maximum of entry price and all subsequent valid closes, never intraday High. Comparisons use the shared eight-decimal fixed-point representation and exact cross multiplication before display rounding. One close suffices; the entire remaining position exits at the next observed executable open.

U9.5, H60 and MA60 remain. The existing earliest execution planner resolves H60 close versus following-open exits. Same-time existing reasons retain priority. Pending exits survive missing opens and price recovery, and a completed exit cannot create another sale. Existing model-only missing-observation liquidation remains explicitly a model assumption; it is not an exchange fill.

## Scope and continuity

- Current mixed Korean and KOSPI strategy ledgers, restart KR_MIXED / KR_KOSPI / ETF_V02, and integrated O1 / S07 receive the dated amendment. Asset weights, entry filters, slot sizing, cash accounting and transaction costs are unchanged.
- KOSDAQ, US strategies, pre-cutover records, research backtests without explicit opt-in, and the separate KR_KOSPI_CONFIRM1_BEAR experiment retain their rules.
- Original frozen base contracts and completed sessions are not edited. New October publications include a `priceExitAmendment` with version, effective date and previous state hash; integrated session receipts include `priceExitPolicy`. Updated executable digests are explicitly admitted; unknown digests continue to fail closed. This is a prospective supplementary policy, not a claim that the original contract itself contained K4/E4.
- Existing ETF positions require an entry-to-cutover peak reconstructed from dated data. Missing observations cause basis-pending rather than peak reset. Persistent position state maintains the peak when rolling source windows shorten. Seed reconstruction excludes future rows.

## Actual holdings and display

Only the website's allocated, canonical actual positions supply actual cost and quantities. Actual positions are not replaced by model holdings or imported historical Notion positions. The production preflight found **zero domestic actual executions in the website's new series**; therefore a real held KOSPI/ETF signal cannot be claimed as verified from that empty book. Historical actual holdings remain in Notion and need their own verified acquisition/price evidence before website monitoring can cover them.

Single-buy holding cycles use the actual entry fee and remaining cost. Multi-buy cycles are explicitly basis-pending; no unapproved average-cost/FIFO E4 convention is invented. Stock/ETF signals, thresholds and ETF peaks appear in actual portfolio, dashboard and held screener/detail contexts. Original price-only screening observations are not overwritten with account-dependent signals.

Private derived evidence is appended under `<owner>/holding-price-exits/holding-price-exit-k4-e4-v1/<cycle-hash>/`. A single immutable `signal.json` latches the exit intent until the holding cycle closes. Daily peak checkpoints retain their source overlap close. Revised overlap prices require reconciliation instead of silently resetting a peak. Failed checkpoints are reported. This path contains no broker orders and does not modify actual fills, cash or quantities. ETF price exits are independent of KRX entry eligibility. Today's quotes before 15:30 KST are excluded from actual close decisions.

## 2026-10-15 actual-holding follow-up: four scoped improvements

1. **Actual multiple buys** — Rebuild independent acquisition-lot identities from canonical allocated BUY and SELL fills. All partial sales use the exact existing proportional pooled-cost deduction (including entry fees); reconstructed remaining lot quantity and cost must equal the canonical position to eight decimals. K4 uses that remaining **pooled per-share acquisition basis**. E4 observes each open lot's individual entry price and dated close peak, and the first triggered lot raises one **whole-remaining-symbol review/sale intent**. This E4 multi-buy extension applies only to actual-account monitoring; it is not claimed to have been simulated by the historical single-buy backtest. Closed holding cycles cannot revive an older stop.
   For K4 catch-up/replay, the acquisition cost and remaining quantity are also reconstructed **as of each historical close** from fills recorded on or before that date. A later same-symbol purchase never increases/decreases an earlier close's K4 threshold; first-crossing signal dates cannot move merely because a user enters a subsequent BUY. The single-buy and E4 per-lot semantics remain unchanged.
2. **First confirmed close reconciliation** — On the first available confirmed price observation from 2026-10-15 onward, each actual holding checks canonical remaining quantity/cost, daily-source decision-date close against a same-date actual quote when available, and saved checkpoint source overlap before displaying an actionable new price exit. A mismatch stays visibly pending and is recorded as a pool issue; neither past fills nor held Shadow sessions are rewritten. Newly generated evidence carries decision date, observed close, lot count, threshold and explicit parity status. The same checks repeat on subsequent actual-load/dashboard refreshes. Market-session model replay retains its own versioned K4/E4 regression gates; different actual and model books are **not** expected to have equal holdings or identical signals.
3. **Pending and alert consistency** — A generated stop is latched as an immutable `signal.json` through recovery, missing prices or price rebound, and is removed from the actionable display only when the canonical actual holding cycle closes. Dashboard K4/E4 alerts are deduplicated by market and symbol and remain distinct from score/MA60 reasons. Stale cached screening rows do not pretend to observe a newer actual stop; the newer persisted signal is displayed with its own date. A failed private price read must remain unknown, never become a confirmed negative exit. These are **in-app alerts**, not broker orders, external push messages, or ChatGPT reminder schedule changes.
4. **Price evidence UI** — New actual portfolio shows threshold, historical ETF peak and date, observation close/date, percentage cushion to the most restrictive actionable line, acquisition-lot method and explicit source/parity status. The dashboard presents actionable pending executions prominently and requests actual broker fill confirmation.

No new Supabase migration, actual fill, funding event, historical replay mutation, model allocation change or K4/E4 core threshold change is part of this follow-up. The initial real October-15 close still requires live data publication and separate source/receipt readback before declaring the production run verified.

## Verification and remaining evidence

Tests cover exact boundaries, fractional costs, missing/unconfirmed closes, future exclusion, high-water retention, missing-history refusal, checkpoint recovery, duplicate observations, acquisition-cycle separation, next-open gaps, delayed fills, price recovery, and unchanged allocation/cash before execution. Legacy ledger and integrated economic publication fixtures remain comparison gates. Use the repository's dedicated Vitest configurations, not an indiscriminate default run over Node test scripts and framework mocks.

Deployment acceptance also requires TypeScript, lint, build and the exact executable-manifest preflight. Stored production session dates/hashes are read before and after release; this implementation does not rewrite them. First real 2026-10-15 close behavior is observable only after that confirmed data exists.

Research limitations remain: full total-return/corporate-action/raw-execution-price reconciliation, point-in-time universe certification and fresh untouched OOS were not certified by the referenced research. This implementation is not a new claim of research certification. The user elected operational adoption with those limitations noted.

## Rollback

Disable **new trigger generation** with `HOLDING_PRICE_EXIT_POLICY.enabled = false`, regenerate and review the executable digests, run the same gates, then release. Existing E4/K4 pending intents and their validators must remain supported. Do not revert to a binary unable to read E4 orders after they exist. Never remove real fills, original frozen sessions, or latched signals as a rollback shortcut. A correction to an actual fill must use the existing canonical correction workflow.

Sources: owner attachment; Notion KOSPI follow-up `3fad908cac2f81919145f6a38bbec3ec`; ETF follow-up `3fad908cac2f81f09a22dbc6136c3704`; operating rules `3f4d908cac2f816db9f8e1cd69dbf999`.
