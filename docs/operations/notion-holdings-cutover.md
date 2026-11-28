# Manual security master cutover (active since 2026-11-28)

CloudTrend no longer operates a trade ledger. Actual trades are recorded in Notion (`거래내역DB`, `종목마스터DB`), and CloudTrend keeps only a manually saved aggregate holdings snapshot (`public.manual_security_master`) that it combines with the latest screening to produce real-holdings-based entry and exit candidates. The legacy actual, strategy, Shadow and integrated-allocation ledgers are closed for writing in production and remain as a read-only archive. Screening history, raw signals, source data and research/backtest engines are unchanged.

## Current status

| Item | State |
| --- | --- |
| Code on `main` | `cb46350` — PR #429 (manual security master, dashboard signals, actual-only K4/E4) squash `2d61bb6`, PR #430 (build-gate test isolation) squash `cb46350` |
| Production deployment | Reports commit `cb46350` in `/deployment-manifest.json` and the `x-cloudtrend-code-version` response header |
| Holdings snapshot | `revision 2`, confirmed 2026-11-28 13:46:23 KST — 53 registered symbols, 13 held, reconciled against the 13 positive-quantity rows of the Notion master |
| Legacy ledger writes | Retired in production: `CLOUDTREND_LEDGER_ARCHIVE_ONLY=1` set on Vercel Production on 2026-11-28 |
| `/portfolio?asset=KR` | Shows the retirement notice ("기존 원장 운영은 종료되었습니다. 실제 보유현황은 종목마스터DB에서 수정하세요.") and the actual-fill input is disabled — verified on the production site after the `cb46350` deployment |
| `/assistant-trades` | Archive inbox still readable; no pending approvals were created or approved |
| Screening evidence | KR history 54, US history 43, execution archive 117 — unchanged across the cutover checks |

## Current operating flow

1. Google Drive source files → the existing per-market screening → Supabase result publication and signal history. This path is unchanged.
2. An actual buy or sell is recorded in the Notion `거래내역DB`; the Notion `종목마스터DB` aggregates quantity, average cost, holdings amount and realized P&L.
3. After the trade, the owner updates the CloudTrend `종목마스터DB` screen (`/portfolio?master=1`): paste the Notion table or edit cells, review the change preview, confirm and save. Individual fills are not copied into CloudTrend.
4. The dashboard, the KR/US screeners and the detail pages combine the latest screening projection with the saved holdings snapshot, and show actual entry/exit candidates separately from raw signals. Raw signals are still calculated and kept for every symbol regardless of whether it is held.
5. Backtests and research run separately from the source data and the strategy version of the time; research results are never written into the daily ledger.

A snapshot's `asOf` is the last holdings-change date, not an expiry date. With no trades nothing has to be re-saved or re-confirmed daily, and newer screenings continue to use the last confirmed snapshot. A lookup failure, an unregistered or review-pending snapshot, and integrity or version conflicts suspend holdings-dependent judgement instead of falling back to an empty or legacy position.

## Master snapshot contract

- The editor at `/portfolio?master=1`, the manual-master signals and the price-exit logic read one owner-scoped snapshot table. Access is owner-only: RLS on reads and writes, no anonymous read, no delete right, and direct service-role access is revoked. Two migrations (`20261128022019_manual_security_master_review_snapshot`, `20261128022311_manual_security_master_restrict_service_acl`) install the additive schema, its guards and the ACL restriction.
- In `manualMaster.ts`: strict schema validation, string IDs that preserve leading zeros and alphanumeric ETF tickers, fractional quantities, zero distinguished from missing, no duplicate identity, decimal inputs, preview diff, and holding/recent-sale projection. A missing value is never fabricated as zero, and there is no legacy ledger fallback.
- In `manualMaster.functions.ts` / `manualMaster.server.ts`: authenticated owner only, revision compare-and-set and readback, and validation on every read.
- Cost and aggregate monetary amounts, including the US average acquisition cost, are KRW; the listing currency is the quote currency, not the cost currency. KRW cost cannot be compared directly with USD prices.
- The editor table shows the 18 aggregate columns of the Notion master and the authenticated account as owner. The relation to individual transactions is intentionally excluded. Sold rows are preserved (quantity 0) so that recent-sale dates stay queryable.

## Legacy ledger retirement gate (active in production)

`CLOUDTREND_LEDGER_ARCHIVE_ONLY` is a server-only switch read by `src/lib/legacyLedgerRetirement.server.ts`. It was not set while PR #429 was prepared; on 2026-11-28 the owner set it to `1` on Vercel Production after the holdings snapshot was confirmed, and the production build and runtime now both run with it on.

With the switch on, every call to `assertLegacyLedgerActive()` rejects the mixed load/write legacy portfolio endpoints (including loads that initialize or persist price-exit evidence), the old position-context fallback, capital and allocation edits, integrated initialization, actual performance preview/save, manual ETF membership writes, and assistant proposal/approval operations. The UI surfaces the retirement message; `/api/assistant-trades` approval requests are rejected after authentication with `410 { code: "LEDGER_RETIRED" }` before any ledger read, RPC claim or write. MCP keeps source-file registration and drops the trade proposal tools; archived proposal listing and the existing pure archive readers remain available. No old rows, storage objects or research functions are deleted.

This is an application-ingress barrier, not a claim that all database RPCs, direct Data API writes or explicit CLI/research commands are revoked. Those paths are listed as remaining work below and must not be treated as closed.

### Build gate and PR #430

`npm run build` runs `test:trade-approval` in `prebuild`, inside the deployment environment. Once the switch was set on Production, `src/routes/-api.assistant-trades.test.ts` inherited `CLOUDTREND_LEDGER_ARCHIVE_ONLY=1` and its approval tests received `410` instead of the expected statuses, which failed the production build and left the previous deployment (`2d61bb6`) serving traffic.

PR #430 (`cb46350`, test-only, application code unchanged) clears the variable at the start of each test and restores the original value afterwards, adds three archive-gate cases (410 rejection with no ledger read/RPC/write; archived inbox GET still 200; the same approval is not rejected once the switch is off, pinning the rollback path), and adds `src/lib/legacyLedgerRetirement.test.ts` to the trade-approval gate — that file had been included in no Vitest config and never ran. `CLOUDTREND_LEDGER_ARCHIVE_ONLY=1 npm run test:trade-approval` now passes 142 tests and `CLOUDTREND_LEDGER_ARCHIVE_ONLY=1 npm run build` completes, so a successful production deployment of this commit is itself evidence that the switch is on.

### Rollback

The switch is reversible: remove `CLOUDTREND_LEDGER_ARCHIVE_ONLY` from Vercel Production (or set it to `0`) and redeploy. The legacy writers, endpoints and data were never removed, and the master snapshot is unaffected either way. Rolling back re-opens legacy ledger writes, so it should be a deliberate decision, not a routine deploy step.

## Owner-approved actual holding price-exit simplification

Actual-only policy `master-price-exit-v1`: KOSPI K4 uses the current confirmed KRW average × 0.92; domestic ETF E4 uses the maximum confirmed CLOSE since the current holding start × 0.90. No per-lot peaks and no historical pooled-cost replay. Existing research/backtest engines remain untouched. The final published screening identity and same-date close are required for new signals; E4 requires complete holding-cycle chart coverage. Catch-up only uses observations from the current confirmed master change date; older K4 cost is never reconstructed using today's average. A previous unobserved crossing before the current master revision is not claimed. The first independently verified signal is persisted in owner-scoped storage under its own policy/cycle path, retained through price recovery and partial sales/additions, hidden after a full sale, and restarted with a new holding start for a new cycle. A same-day full sale and repurchase with an identical start date is ambiguous and needs an internal cycle identifier before production certification. No broker order, raw screening change or legacy ledger write is produced. New and score-based exits deduplicate by market/symbol and appear on the existing K4/E4 dashboard alert and exit list. First observed signal persistence happens on a master-based dashboard/screener/preview read, not in a new scheduled job.

## Remaining work

1. **Direct write paths.** Inventory and retire (or explicitly keep) database RPCs, direct Data API writes and CLI/research commands that bypass the application ingress barrier. Keep historical and research data, all original screening rows and strategy versions.
2. **Archive read-only UI.** Provide a dedicated read-only screen for the retired ledgers and old portfolio endpoints; `/portfolio?asset=KR` currently shows only the retirement notice. Verify backup/restore for the archive.
3. **Production approval path check.** The `410 LEDGER_RETIRED` response of `/api/assistant-trades` is pinned by automated tests and the runtime lock was verified through the sharing server environment on `/portfolio?asset=KR`, but a real owner-authenticated approval request has not been exercised against production.
4. **P1 — master screen UX.** Mobile readability, fixed symbol name/code columns, thousands separators, key columns first, paste-error reporting, and a document title that reflects the security master instead of reusing the portfolio title.
5. **P2 — cleanup.** Remove or further isolate the superseded Notion API adapter and the retired ledger UI/automation code, and clear the remaining build warnings (vite-tsconfig-paths resolution).

## Validation

Unit, PGlite RLS/CAS and signal-projection tests for the manual master, the K4/E4 price-exit tests, the archive-gate tests and the existing screening/history regressions run in PR CI (14/14 workflows on PR #429; `lint`, `Ledger foundation`, `verify` and `ui-regression` on PR #430). Production checks after the `cb46350` deployment: `/deployment-manifest.json` commit, the master screen reporting 53 registered / 13 held at `revision 2`, the retirement notice on `/portfolio?asset=KR`, the archive inbox on `/assistant-trades`, and dashboard rendering with the 2026-11-27 screening date. Authenticated end-to-end QA of cell editing and saving was exercised by the owner when the snapshot was confirmed; no automated login-based E2E covers it.

Prior decisions: [screening-only operation](./screening-only-signal-history.md), [current report source contract](../current-report-source-contract.md).
