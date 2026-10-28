# Adjusted-history recovery preparation (not operational approval)

The manual, main-only preparation workflow accepts two independently reviewed opaque hashes: an existing private capture capsule and an append-only preparation read-plan. It performs bounded GET-only materialization, credential-free counterfactual computation, then at most one owner-private `ledger_provenance_archive` INSERT in the disjoint `kr-adjusted-recovery-preparation:` namespace. It does not publish source data, approve a vintage, advance a model, clear a hold, or touch actual portfolios.

Before insertion the credentialed boundary rechecks canonical capsule/plan identities, frozen FINAL source metadata, original vintage authority, model/archive pins, integrated evidence and completed books, and all original KOSPI object generations. Missing, changed, ambiguous or later model state fails closed. An uncertain INSERT response is resolved by exact full readback; the write is never blindly retried. An identical existing receipt is reused. Public output contains only fixed categories, booleans, counts and opaque digests. No private reports or raw data are uploaded as Actions artifacts; cleanup runs unconditionally.

The resulting `RECOVERY_PREPARATION_ONLY` receipt retains:

- Exact original/new whole-bar pairs and the unchanged prior review cohort, without creating a new approval.
- Full integrated session input comparisons. Only the top-level provenance `sourceHash` may differ; every other session field must be identical, and both original completed publications must reproduce exactly.
- Dated candidate evidence with explicitly retrospective model clocks. The frozen plan timestamp is a deterministic **model evaluation time**, not actual wall-clock computation. Authenticated Actions job timestamps and archive `recorded_at` provide execution/persistence timing.
- Captured KOSPI journal bodies, opaque object-generation tokens, byte/canonical hashes and a copy-on-write plan when the complete predecessor boundary reproduces. Newly captured journal hashes are **not independently approved** by this step.
- Bounded target-exposure checks over pinned adopted result trees and cumulative KR/integrated records. Day-local ETF/confirmation histories not captured are explicitly not claimed as scanned.
- A `HISTORY_ONLY` CSV proposal that reproduces the **frozen** analytical bundle. It is not authorized for current-active registration. A separate field-mask/precedence review must preserve newer independent observations and any effective PRELIMINARY latest date.

Ordinary publication/immutable-history guards are unchanged. Any later APPLY requires separate exact-hash authority, current-state revalidation, preserved completed history, runtime admission and chronological continuation. The preparation workflow itself supplies no operational approval.

Local checks include strict script TypeScript (standard strict checks; optional index-signature extras remain enabled in the ordinary application project), synthetic transport/clock/exposure/equivalence tests, the pure KOSPI preparation self-test, dependency/AST bundle checks, lint and the application build. All fixtures are synthetic.
