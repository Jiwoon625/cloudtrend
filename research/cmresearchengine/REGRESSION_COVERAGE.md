# Development-note regression coverage

This maps current-contract checks to the note-driven tests. Historical findings
are evidence for regression design, not automatically current defects or new
strategy assumptions. The synthetic checks do not certify full historical data,
PIT availability, vendor universes or production performance parity.

## Reproduced and corrected in this revision

| Sequential bounded batches let one long candidate consume nearly the whole job, preventing later candidates from starting | Add explicit `workers=1..2`; static non-reference candidates may run in isolated child processes after one shared input restore/preflight, while each keeps its own ledger/checkpoint scope | `DispatchRequestTests.test_two_workers_are_explicitly_bounded` + full synthetic suite |
| S05 completed and wrote a valid completion marker/output, but runner compared the in-memory completion document to its JSON round-trip with Python `==`; tuple/list normalization could raise a false RuntimeError after completion | Compare completion readback using canonical JSON bytes, matching the checkpoint identity contract | `RunnerTests.test_completion_readback_tolerates_json_tuple_normalization` |
| Repeated OPEN/CLOSE/proxy reads rebuilt the same session DataFrame and row dictionaries several times | Keep a bounded one-session/month cache and reuse explicit row-record snapshots through panel wrappers; strategy logic and row values are unchanged | `MonthlyPanelFastPathTests` + full synthetic suite |
| Full checkpoint snapshots were emitted roughly every 180s/63 snapshots even though bounded-stop always forces a final checkpoint | Increase periodic checkpoint spacing to 600s/252 snapshots while preserving forced checkpoint on pause/stop and final completion | existing pause/resume/idempotence regressions |
| Real S05 resume reached a held successor created by a documented LINEAR_EXCHANGE with no `entry_meta`; the next ordinary CLOSE indexed `entry_meta[(U,symbol)]` and raised KeyError | When a terminal linear exchange creates a successor, initialize successor metadata at the legal effective date with zero valid bars; preserve existing successor metadata if already held | `LinearExchangeEntryMetaTests` |
| Finding | Correction | Focused regression |
| --- | --- | --- |
| A persisted checkpoint identity containing tuples is JSON-normalized to lists, so direct Python equality falsely rejects the first commit on a fresh process even though the canonical identity hash is unchanged | Compare persisted identity/host-binding documents by canonical JSON bytes at journal and codec restore boundaries | `JournalIntegrityTests.test_json_roundtrip_identity_with_tuples_resumes` |
| Finding | Correction | Focused regression |
| --- | --- | --- |
| ETF Onset observed while held could be reused after a sale during its confirmation window | Record the blocked origin and consult holding spans before admitting that confirmation; a later fresh Onset remains usable | `ETFLifecycleNoteTests.test_onset_while_held_cannot_be_reused_after_next_open_sale` |
| A preloaded/stale `cm06` module, or a cwd module ahead of an already-present reviewed root, could survive import setup | Reject CM preloads before controlled initialization, pin initialized source hashes, and move all reviewed roots ahead of cwd; use a fresh process | `ImportIsolationNoteTests.test_preloaded_foreign_cm06_is_rejected_not_silently_reused` |

ETF requirement source: [V0.2 implementation note](https://app.notion.com/p/3ecd908cac2f81dc954fd037e45adbd4).
Runtime requirement source: [runtime correction note](https://app.notion.com/p/3efd908cac2f81678a4ecd533739ec55).

## Existing behavior protected by the new tests

All names below are in `tests/test_note_regressions.py`.

| Area | Protected behavior | Test group |
| --- | --- | --- |
| ETF index inputs | Zero/missing/NaN underlying index or MA60 does not create a normal MA60 sale; missing confirmation never revives later | `ETFLifecycleNoteTests` |
| Fresh imports | A fresh CLI from an unrelated cwd selects reviewed CM source, not the cwd's fake package | `ImportIsolationNoteTests` / `ImportPathPriorityNoteTests` |
| Execution timing | Current-session close/features do not affect its already scheduled opening fills; future-available close observations are rejected | `ExecutionClockNoteTests` |
| Ordinary tradability | Zero-volume opening row does not fill an ordinary entry; this is separate from the approved missing-close price proxy | `ExecutionClockNoteTests` |
| Combined Korea | Shared30 positions; count both markets' same-sector holdings and apply the incoming KOSPI3/KOSDAQ6 limit; deterministic priority ties | `KoreanBudgetSlotNoteTests` |
| Sizing/costs | Whole-unit floor, no forced minimum1, original H60 valid-bar horizon, delayed settlement and modeled fees charged once | `KoreanBudgetSlotNoteTests` |
| US identifiers | Literal ticker NA survives rank selection, fills, serialization and an identifier-safe report join | `USIdentifierNoteTests` |
| US residual orders | Partial target buys and sales survive every-event checkpoint/resume; a cap that never binds does not change path/costs | `USDemandPersistenceNoteTests` |
| Allocator demand | Repeated pending demand is not a new O2 event; future updates/reference values do not affect current targets | `AllocationAndCashNoteTests` |
| Shared cash | Only idle settled nonreserved cash moves; fixed initial sleeve budgets remain fixed; target changes do not force holding sales | `AllocationAndCashNoteTests` |
| Same-open accounting | A sale does not fund another purchase before its settlement time | `AllocationAndCashNoteTests` |
| Korea signal boundaries | Overshoot entry differs from a later U9 recross/D3 crossing; failed KOSPI confirmation cannot revive an old Onset | `KoreanSignalBoundaryNoteTests` |

Underlying input archives and mapping/universe changes remain bound by the
existing exact source hashes and independent checkpoint identities. Existing
resume/proxy/storage tests remain in the aggregate suite. Same-contract
cash/holdings/orders/NAV equality is required by resume tests; this is not a
requirement to reproduce old production NAV under deliberately different,
approved CM settlement or price-proxy assumptions.

## Explicitly unchanged interpretations

- Original period, KRW100m, registered weights/families and 15bp side fees
- Known27 event profile, exact mandatory entitlement units, US cash-mergerT+5
- Uniform retrospective missing-close exit convention and its limitations
- K H60 counts the frozen model's qualifying positive open/close bars, including
  entry; it has not been silently changed into 60 calendar days
- K target budget remains initial KRW/30 fee-inclusive. The frozen U_A0 target
  remains initial USD/20 gross, with purchases separately bounded by available
  cash including fees. Later prose about a fee-inclusive U target lacks an
  explicit revised formula; this revision does not silently change that choice
- No additional tax, dividend, distribution, source-universe or strategy model

Current tests and the exact revision CI result should be reported separately
from pending real-input preflight, S05 resource measurement and historical runs.
