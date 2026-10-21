# Assistant trade approval follow-up to PR #317

The US record-transition fix in #320/#321 and ETF precision extension in #323 are preserved. This change closes the remaining cross-book evidence and fixed-point findings, and makes new approvals atomic.

- Both canonical currency documents are read before approval. The other book's Notion source links and allocation references block a reused evidence page.
- A shared owner-scoped transaction lock and database trigger enforce the evidence constraint for all website document writes, including direct writes. Source-link and allocation-reference evidence are normalized without hyphens.
- `assistant_trade_commit` runs as the caller, checks the verified owner/claim/market, updates with CAS through the existing canonical bridge, then calls the canonical record transition. Failure rolls back the document, journal and status together. No service key or additional login is introduced.
- Old PROCESSING fills still use the existing canonical execution, full allocation and source comparison. They are reconciled without inserting another execution. Uncertain results retain PROCESSING for retry.
- Actual money arithmetic converts the unit price to eight-place fixed-point before integer multiplication and checks that the JSON number preserves the exact result. Large USD notionals keep their shortest exact decimal spelling. Frozen Shadow arithmetic is unchanged.

Validation: 123 focused Vitest tests; disposable PostgreSQL integration for KR/US success, precise USD, transition failure rollback, replay rejection, revision conflict, cross-book direct-write duplicate and wrong-owner denial; TypeScript, changed-source ESLint and production build.

Operational checks are separate from synthetic tests. The production schema migration does not rewrite existing documents or executions. A browser owner login is required for live website approval checks; no artificial production fills may be created for testing.
