# Screening-only daily operation (2026-11-04 cutover)

Daily KR/ETF CLI, authenticated web screening, and US screening no longer call strategy/Shadow replay, actual valuation refresh, allocated performance publishing, or benchmark accounting. Integrated allocation was already disconnected. Existing ledgers and evidence are preserved under the archive navigation; quarterly research remains an explicit backtest-collector operation, not a scheduled model writer.

The scheduled signal-only workflow checks available owner-private source data daily at 22:25 UTC (07:25 KST). It does **not** run or modify the Colab collectors. Without source data, it reports pending dates; it cannot produce contemporaneous market observations. Upload-triggered and browser executions also update the journal. KR reconstruction processes at most five missing dates per invocation and checkpoints each completed date. Retries reuse completed markers instead of recalculating prior days.

## Preserved evidence

Owner-private files live under `results/screening/signal-journal/{KR|US}` within existing Storage RLS scope. Strategy activation events capture configuration, executable source hash, source commit, version, and effective date. Daily records are write-once per date/rule, with source identity, observation/reconstruction distinction, and all signal evidence. Verified records are indexed in the existing immutable screening execution archive. Same-day revisions have separate rule identities; neither replaces prior evidence.

Date-bound activation prevents newer settings being silently applied to older gaps. A missing date whose executable code is no longer installed is reported as pending and must be reconstructed using its preserved commit. A future strategy release must close pending dates using the previous runtime before deployment, or retain that runtime for explicit historical reconstruction. US daily state contains only prior ranks and streaks, never cash, positions, quantity, NAV, fees or returns.

## Meaning and limits

These are screening entry/exit **conditions**, not simulated/actual fills. Holding-dependent exits (e.g. H60, acquisition-price stops), position selection/caps, corporate-action-adjusted quantities and returns remain quarterly research responsibilities. This distinction is displayed in history. Missing US predecessor data cannot become an empty confirmed signal or a reset streak.

KR historical calculations slice dated bars/index/volatility inputs. Later source vintages, current metadata and historical-universe availability cannot prove what a vendor actually supplied on the original date; reconstructed records explicitly say so. Earlier-than-cutover history is retained as recorded and is not relabeled or rewritten. No new claim of full historical point-in-time equivalence is made.

`historical-us-screening.ts` retains the old **explicit, pre-October-12-only** recovery orchestrator for its frozen historical repair tests. No ordinary entrypoint, web handler or scheduler imports it. Existing approved recovery tools remain available separately.

Verification covers disabled financial writers, immutable retries after archive failure, version activation, missing-session coverage, reconstruction versus current configuration, US predecessor gaps, browser/CLI admission and historical recovery compatibility.
