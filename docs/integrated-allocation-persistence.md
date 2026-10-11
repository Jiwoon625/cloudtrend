# Integrated allocation persistence

Status: applied to the existing private project on 2026-10-11 at 13:27:54 UTC as migration 20261011132754_integrated_allocation_owner_append. Readback confirmed body MD5 604613388f3dfac68fafad59ab7f3950, unchanged owner/ACL/search_path, and the exact reviewed runtime sha256:dffdb12c0e7b79ca68d246b0f607b83bf6d1324b90cb7a50bafea79acd2332d4. No integrated registry or session was created by the migration. App deployment and authenticated initialization verification are separate release steps.

## Scope and existing security boundary

The draft extends the existing `public.ledger_append_own_october_model_session(jsonb,date,text)` with a bounded branch for exactly:

- `integrated-allocation-shadow-2026-10-12-v1:O1`
- `integrated-allocation-shadow-2026-10-12-v1:S07`

It uses the existing authenticated, non-anonymous `auth.uid()` owner, the existing `MODEL` tables, and the existing per-owner/series advisory transaction lock. It adds no RPC, role, grant, policy, table, column, index, key, credential or new service-role permission. The function remains owned by `postgres`, `SECURITY DEFINER`, with an empty search path and schema-qualified references. This follows the existing RPC boundary and [Supabase database-function guidance](https://supabase.com/docs/guides/database/functions).

After removing the explicitly marked new branch, the entire previous function body must match the 20261009014910 migration byte for byte. The original eight series, their contracts, their branches, and their rows are unchanged. The apply and rollback scripts refuse an unreviewed function-body, owner, security-mode or search-path drift. `CREATE OR REPLACE` preserves the existing function ACL; the regression suite compares it explicitly.

## Existing automatic service path

Initial empty registration uses only the authenticated owner RPC. Normal scheduled KR/US collectors already run with a trusted service client and a configured owner ID. Their explicit `mode: service` now selects the existing `ledger_append_model_session` RPC, preserving its signature, invoker mode and ACL. Ordinary authenticated clients cannot call that RPC. It appends only after the server has loaded the same owner registry and prepared/verified the complete integrated publication. The generic service SQL supplies registry equality, predecessor locking and exact retry; the stricter integrated envelope checks run in the trusted server preparation, whereas interactive callers also undergo the bounded owner SQL checks. The service path never initializes an absent integrated book.

Synthetic PostgreSQL tests compare identical owner/service publications, check a service JWT with no user sub, reject authenticated direct service calls and retain the existing ALLOCATOR_SHADOW registry role. No service function body is changed by this migration.

## Envelope contract

The outer book is `MODEL`; the engine ledger inside `result` is `ALLOCATION_SHADOW`. Their book IDs and contract hashes must match. The new contract fixes K/US sizing to prior year-end complete NAV and ETF sizing to prior completed close sleeve NAV × volatility weight; queued budgets remain frozen through carryover. The registry has exactly these fields:

```text
book, bookId, version, accountingStartDate, policy, contract,
contractHash, configHash, codeHash, sourceHash
```

`policy` is `{kind: O1|S07, market: GLOBAL}`; `configHash` equals the new integrated contract hash. The contract is compared to the exact canonical engine contract template, with the supplied code hash substituted, and its SHA-256 is recomputed. The registry source hash must equal the exact initial target/reference hash produced by the real publication factory. Registered provenance is immutable. The new integrated runtime manifest and server admission gate must be reviewed separately; a SQL shape/hash check does not certify engine calculations or source-data truth.

### Fresh initialization

An initialization envelope contains exactly `book`, `bookId`, `contractHash`, `action: INITIALIZE`, `registry`, `result`, `stateHash`, `canonicalPayload`, and `resultCanonicalPayload`. Both predecessor arguments are null. The result must equal the engine's exact fresh cash state, including the inner state hash. The RPC creates only an owner registry with role `ALLOCATOR_SHADOW`, scheduled for 2026-10-12. It creates no session, receipt, transaction, holding, or false execution history. This permits registration on October 11. An exact retry reuses the registry, including after daily sessions exist, and never resets those sessions.

### Completed daily batch

A daily envelope contains `book`, `bookId`, `contractHash`, `registry`, `result`, `receipt`, `previousStateHash`, `calendar`, `publication`, `stateHash`, `canonicalPayload`, and `resultCanonicalPayload`. No `action` is allowed. Its receipt is the canonical hash of exactly `book`, `bookId`, `date`, `contractHash`, `codeHash`, `configHash`, and `sourceHash`.

`canonicalPayload` is `canonicalSeriesJson(envelope without stateHash and canonicalPayload)`. The SQL verifies that parsing those bytes equals the submitted JSONB and that their SHA-256 equals `stateHash`. `resultCanonicalPayload` is the corresponding canonical inner ledger without its `stateHash`; it is included in the outer hash, and the SQL verifies the inner JSON and inner hash independently. Both canonical byte strings are reconstructed by an inline JSON token walk; noncanonical whitespace/order, non-ASCII object keys, or non-round-tripping numeric values, numeric magnitudes above 9,007,199,254,740,991, or nesting depths of 64 or more fail closed. Known schema property names are ASCII; ordinary Unicode string values remain supported. The supported numeric renderer uses the JavaScript decimal/exponent thresholds and requires PostgreSQL [shortest-round-trip float output](https://www.postgresql.org/docs/current/datatype-numeric.html), with `extra_float_digits >= 1`. The numeric-rendering repair scopes `extra_float_digits=1` transaction-locally to the integrated canonical-validation block and restores the exact caller value on both success and exception; function configuration, existing eight-book code, and role/database defaults stay unchanged. The payload is bounded to 16 MiB. This avoids hashing database-specific whitespace or JSONB object-key order while binding the complete outer payload, including the complete inner ledger. Unsupported numeric encodings are rejected rather than silently normalized to a different application value.

`publication` has exactly `version: integrated-allocation-publication-v1`, `batchHash`, ordered `markets`, `availableAt`, and `decisionAt`; `batchHash` must equal the receipt's complete input `sourceHash`. The inner session receipts are an unchanged old prefix plus exactly one `session:K|E|U:YYYY-MM-DD` per open market. Exactly one `month:YYYY-MM` receipt must follow for O1 on the final union session of each month, as the last event. Missing whole-market input still produces the core engine's explicit hold/issue receipt. The new live O1 policy derives next-month targets from delivered entry-condition signals whose confirmation/session date falls in the previous calendar month (including the October 12–31 partial opening month); the actual delivery can occur on the next session morning in the following month, retaining the agreed 60% cap and active-market equalization; it does not claim equivalence to the earlier research performance. Earlier O1 reviews and all S07 monthly receipts are forbidden. The outer availability is the latest input availability; the outer decision is the latest completed calculation, so inner market decisions must not exceed the outer decision. The delivered-signal and per-market COMPLETE/MISSING observation histories preserve exact prior prefixes; new deliveries require the current session, an open market, COMPLETE evidence and a unique market/symbol/origin key. Each market's session history is append-only. A closed market's session date and decision timestamp cannot advance.

The predecessor date/hash must identify the current owner/series head. A new batch cannot skip a reviewed union session. Exact same-date retries succeed even after the head advances; changed same-date payloads fail. Registry creation and the first daily append can also occur in one atomic transaction. A failure inserts neither row. The per-series advisory lock serializes initialization, duplicate and cross-date append attempts.

## Calendar and publication limits

The submitted calendar must exactly reference `exchange-calendar-2026-q4-v1`, coverage 2026-10-05 through 2026-12-31, with hash:

```text
sha256:44af9615519b8808515ec4213d0ba7e4941ac2b6dfe315e1b16fcf6ef73eab7d
```

The server and SQL derive open markets from that reviewed evidence. A weekday alone is not evidence of an open session. Records before 2026-10-12, beyond 2026-12-31, in the future, on a fully closed date, or with unavailable publication timestamps are rejected. The reviewed US early closes on November 27 and December 24 are 13:00 New York time. KR/ETF observations require the next reviewed KR session morning before 09:00 Seoul time.

November 19 has unresolved official special hours. It cannot be processed; a November 18 KR/ETF batch requiring that next morning also fails closed. The series cannot skip the blocked date. December 30 KR/ETF next-session evidence would lie beyond the reviewed Q4 coverage and is likewise blocked until calendar coverage and the runtime/contract continuation are explicitly reviewed. Since codeHash is part of this immutable contract, a changed runtime does not automatically continue the registered book: a reviewed compatibility or new-contract transition is required. Pure-engine tests in 2027 do not authorize live calendar use in 2027.

## Local verification and migration preparation

1. Run `vitest run --config vitest.integrated-allocation-postgres.config.ts` with the already declared, locked `@electric-sql/pglite@0.5.8` dependency available. The tests use disposable embedded PostgreSQL with synthetic owners. They do not accept a database URL or access credentials.
2. The suite installs the existing foundation/migration chain locally, captures ACL/RLS/policies/triggers/indexes/constraints, applies the draft twice, and compares catalogs and the old function body. It exercises initialization, owner isolation, permission failures, immutable registry/head/prefix, conflicts and duplicate requests, real core monthly-review receipts, inner/outer canonical hashes, reviewed holiday/early-close behavior, calendar expiry, unknown clock fields, function drift, and rollback.
3. The test clock replacement exists only inside the disposable test database. The checked-in SQL has no clock override parameter. A holiday fixture seeds a synthetic prior head to isolate calendar behavior; it does not claim live progress past the unresolved November special-hours boundary.
4. PGlite runs requests through one embedded connection. Duplicate request promises verify serialized idempotent behavior, not independent PostgreSQL-backend advisory-lock contention. Before production application, a disposable local Supabase/PostgreSQL instance should run a two-connection same-date/cross-date race and verify one immutable head.
5. After the integrated engine, adapter and policy manifest is final, review its exact runtime hash and the application admission path. Regenerate/recheck the exact contract and initial-state fixtures whenever those engine shapes change. Do not edit any frozen original-eight manifest merely to admit the new namespace.
6. Generate a migration using the project's supported official migration workflow. Compare the generated SQL to this reviewed draft, perform a local apply/rollback/reapply, and separately review the deployment action. These draft files do not authorize a live apply.

If the shared checkout lacks the locked test dependency, it may be materialized in a separate temporary test directory from the official npm registry without changing the repository package/lock files. An ephemeral Vitest alias can point only this test to that copy.

## Rollback

`integrated-allocation-owner-append.rollback.sql` restores the exact prior function after verifying the expected function boundary. It preserves ACL and every registry/session row. It removes the new append capability, so a rolled-back application must stop integrated writes and keep the saved rows read-only. It never deletes or rewrites a ledger. Reapplying the reviewed draft re-enables the same owner namespace and exact-retry behavior.

Any unexpected live definition, ACL/RLS drift, missing reviewed runtime/calendar, or request to broaden grants is a release blocker. Preserve the rows and stop for review rather than weakening the boundary.

## Production numeric-rendering repair

The first authenticated initialization after PR257 reached the owner RPC but failed before any registry write with `Canonical numeric rendering unavailable` (2026-10-11 13:55:58.746 UTC). The production session used `extra_float_digits=0`, unlike the embedded test default. The bounded repair and exact rollback are `integrated-allocation-numeric-rendering.sql` and `.rollback.sql`. Expected body MD5 changes from `604613388f3dfac68fafad59ab7f3950` to `d96be8e4843146bc5278d56aaca2c7c1`; runtime identity is unchanged. Applied as migration `20261011140518_integrated_allocation_numeric_rendering` at 14:05:18 UTC. Readback confirmed body MD5 `d96be8e4843146bc5278d56aaca2c7c1`, unchanged owner/ACL/proconfig, and caller `extra_float_digits=0`. Twenty disposable PostgreSQL tests and independent review passed. Authenticated UI retry then created exactly O1 and S07 registries. Database readback confirmed each initial capital KRW30,000,000, targets 1/3 each and 60/20/20, unchanged reviewed runtime, and zero sessions. No actual cash or trading event was fabricated. To roll back the complete allocation capability after this repair, first apply the numeric-rendering rollback, then the original owner-append rollback; neither operation deletes model records.
