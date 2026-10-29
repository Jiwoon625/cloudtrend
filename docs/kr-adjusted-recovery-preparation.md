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

## Immutable evidence storage and diagnostic iterations

Large preparation and full-plan receipts use the owner-private provenance archive's
`kr-recovery-evidence-gzip-v1` envelope, not a public artifact or a new storage service.
The row `source_hash` hashes the canonical **stored envelope**. Its `receiptHash`
hashes the complete canonical **decoded receipt**, which remains the operation
manifest's authority pin. The decoder validates both domains, exact fields,
base64, compressed length/SHA-256, bounded expansion, fatal UTF-8 and canonical
JSON round-trip before the existing full receipt verifier runs. Encoding does not
increase the original full-row logical limits (24 MiB preparation, 32 MiB full
plan), change database timeouts, or alter RLS/permissions.

Preparation identity is content-addressed:
`kr-adjusted-recovery-preparation:<read-plan-hash-hex>:<receipt-hash-hex>`, revision 1.
A blocked diagnostic receipt and a later corrected candidate are distinct immutable
objects. Reads derive this exact identity from both approved manifest pins: no
latest selection, implicit plan-only fallback, overwrite, or relaxed duplicate
comparison. Full-plan identity remains keyed by its exact operation manifest.
Legacy raw encoding is decoded only when explicitly selected by the same exact
identity and matching logical/stored hash.

Each append still makes at most one fixed-path INSERT, then exact readback even
if the response is uncertain. Public diagnostics contain only finite phases,
byte counts, HTTP status/category and allowlisted KOSPI guard booleans/counts.
Full KOSPI baseline/adjusted predecessor sessions and captured revision registry,
completed/prior snapshot references stay private. Receipt verification rehashes
and recomputes this evidence. A blocked KOSPI plan remains `null`, review-required
and operationally unapproved; storing it never bypasses the original equivalence
guard or authorizes recovery execution.
