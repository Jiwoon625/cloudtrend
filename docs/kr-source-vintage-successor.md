# Append-only KR source-vintage successor

This extends private review authority, not prices, frozen calculation contracts, or actual trading ledgers.

## Authority and bounds

- The existing `reviewed-kr-vintage-v1` approval and receipt remain unchanged: two exact historical observations from one symbol and one effective date.
- A separately approved `reviewed-kr-vintage-v2` pair is stored under its own strategy version. Its registry binds `parentRegistryHash` and the complete new `receiptHash`; its receipt binds `parentReceiptHash`.
- The v2 receipt begins with the byte-equivalent canonical v1 review list, including original review IDs. It adds 1–256 explicitly dated whole-bar hash pairs for exactly one different symbol and one later `notBefore` date. There are no wildcard symbols, dates, factors, or future vendor revisions.
- Both original authority records must be independently present in the same owner's append-only registry. An embedded predecessor or a receipt's self-declared digest is not sufficient. Conflicting records, missing halves, altered parent reviews and duplicate observations fail closed; no newest-record-wins rule exists.
- The reader selects the original authority before the new cohort's activation. Direct publication with a premature successor is rejected. Selection does not depend on an arbitrary aggregate review's position.

## Continuation invariants

A retained receipt may continue from the current approval hash or the exact verified predecessor registry hash, never an arbitrary supplied ancestor list. Each retained receipt must still match one complete review. Already accepted vendor values may neither change nor revert. A previous trade (open or closed) or candidate originating before the basis change still blocks this policy and requires separate corporate-action accounting.

The incoming dataset is used for new analysis, while archived execution observations and completed sessions remain unchanged. Approval grants no permission to normalize, rescale or overwrite archived data. Retry and rolling-input omission retain accumulated receipts.

## Operational prerequisites

A tested contract is not authorization or evidence that any particular source is ready:

1. Verify official corporate-action evidence, complete analytical lookback coverage, the authoritative source identity, every impacted exact pair and lack of prior economic exposure.
2. Compare newly prepared integrated evidence with any already frozen same-date evidence and sessions. A changed payload needs a separately reviewed correction/versioning path; this contract must not bypass immutable integrated storage.
3. Obtain independent review of code, private receipt scope and runtime identities. Keep private symbols, source identifiers and financial values out of public code and tests.
4. Append the independently approved v2 registry and receipt without changing v1. Verify owner scope and readback. Do not dispatch collection as a substitute for source verification.
5. Continue the missing regular sessions in order. Verify all dated model receipts and actual-ledger invariants after execution. Never claim full restoration from a workflow success alone.

The change itself does not provision approval records, run recovery, modify source files, or write actual ledgers.
