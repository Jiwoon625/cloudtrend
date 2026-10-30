# Separate-file final retrospective recovery

This is **not** a collector modification or an ordinary FINAL/pre-open path. It never activates HISTORY sources or rewrites historical availability. The frozen scope is five adopted KR/ETF books × 2026-10-28/29 plus two legacy KOSPI sessions, based on their 2026-10-27 predecessors. All outputs state `historicalAvailabilityClaim: false` and retain actual capture/computation times.

## Authority and phases

1. Independently review generic code before publication. No secrets, owner IDs, raw market data, or private receipts belong in the repository.
2. Stage an owner-private `kr-final-retrospective-request-v1` with the exact admitted commit, configuration, source/registry/actual full-row aggregate digests, the explicit PLAN-only `series-date-state-recorded-v1` model-head digest, and full legacy namespace generation inventory. The final capture and APPLY preservation baseline still contain every field of all 128 model rows; no head-only proof can authorize APPLY. Aggregate digests use `hashSeriesValue` (canonical JSON), **not** PostgreSQL text serialization hashes.
3. `PLAN` captures and validates source bytes, full reference-aware dataset, current generations, whole model/registry/actual rows and artifact inventory. Computation runs in a child environment without credentials. It stores only immutable owner-private compressed capture and plan evidence; no model/source/actual changes.
4. Review the exact private plan and separately stage its exact approval. No PLAN output automatically approves APPLY.
5. `VALIDATE` checks authority and freshness without publication. `APPLY` is only for separately approved exact outputs, under shared whole-job serialization and the existing per-model transactional advisory-lock/predecessor-CAS protections; multi-resource apply is non-atomic and exact partial prefixes must be inspected. A failure or uncertain response is not completion; inspect exact persisted state before any further action.

The workflow uses the same `kospi-prospective-shadow` concurrency group as existing legacy writers. Do not invoke a write-capable entry outside that admitted workflow. Private temporary files are removed on success and failure and are never uploaded as Actions artifacts.

## Evidence

Content-addressed `ledger_provenance_archive` namespaces are `kr-final-retrospective-{request,capture,plan,approval,execution,completion}:<digest>`, revision `1`. Compressed evidence binds both canonical logical and stored-envelope SHA256 hashes. Source reads pin info → bytes/hash → info. Existing full rows remain immutable; only exact planned artifact/model additions and legacy projections may appear.

No public operational dispatch, database insert, or Storage mutation is part of local development/testing. Existing collector, notebook, runtime code, actual portfolios, source registry, integrated books and US books are outside the mutation scope.

## Local verification

```sh
npx vitest run scripts/kr-final-retrospective
npx tsc --noEmit -p scripts/kr-final-retrospective/tsconfig.json
node scripts/build-kr-final-retrospective.mjs
```

The bundler rejects server/Supabase imports from PLAN and network/process imports from the pure calculation bundle. Test fixtures are synthetic and contain no private owner data.
