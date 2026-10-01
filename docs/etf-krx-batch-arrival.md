# ETF newest KRX batch not received (2026-10-02)

## Verified cause
The21:25 KST October1 collector explicitly recorded `latestKrxPublicationPending=true`, `latestKrxPendingDate=2026-10-01`, `krxExpectedPublishedThrough=2026-09-30`. Official coverage CSV: October1 ETF0/0 `empty_unconfirmed`; September30 ETF1171/1171 `received`.
Published CSV SHA256: `27ee64174bc9fceea908a3c7eeb7a4141de0403ae32e1eb2ebaa81d5e08cc945`, exactly matches the active source registry and CI logical-file hash.
September30: ETF cap1171/tradingValue1171/underlying1170 nonmissing. October1: allthree0, although adjusted ETF prices exist for1171. This is not a recurrence of PR150 source-order reversal. No replacement values are fabricated.

## Repair
A new data-arrival classification distinguishes a missing latest market-wide batch from an instrument-level missing-data exit warning. At least10 ETFs, newest quotes for>=80%, ALL latest KRX cap/value/underlying fields absent, and previous-session fully sourced KRX fields for>=80% are required. Partial/isolated omissions, a stale instrument, insufficient prior coverage or a genuine received MA60 breach keep the existing rules.
- `dataStatus=krx_batch_pending`, `krxReferenceDate=previous exact market session`.
- No current M0 imputation, no backdated entry, no actionable buy/normal exit from this state.
- A confirmation awaiting this batch gets `entryState=data_pending`; it can only be recomputed from real dated inputs. Moving to a later signal date does not revive an old candidate queue.
- Screener, portfolio and dashboard warning explain data arrival and last reference date. Portfolio's signal action is disabled for this diagnostic row. Existing manual execution recording remains available.
- Prior M0 is historical context, not today's signal. Actual prices/positions/executions remain unchanged.
- Cache/projection schema versions are bumped; strategy weights/thresholds/ranking stay unchanged.

## What this does not solve
The software cannot create unpublished KRX values. Restoring October1 M0 requires the next successful collection after the source publishes October1 data, followed by normal screening. A calendar time alone is not proof of availability. Existing symbol-specific history/source issues remain independently visible. No new timed screening or collection job is introduced.

## Evidence
Current run folder: https://drive.google.com/drive/folders/1ahpAtlFek4l-rIy6QO1Yrmi-iMBaLR_M
Coverage: https://drive.google.com/file/d/1tKHCMuJwoR4xAiohke6Pw4y2Zk3aJj8D/view
Manifest: https://drive.google.com/file/d/1e9yLF0G5Sf0UPdIHClon9FY0QM6g0TSP/view
Published CSV: https://drive.google.com/file/d/1WLN4xkblq1w8yb4eusGe3LR8mRgXajev/view
