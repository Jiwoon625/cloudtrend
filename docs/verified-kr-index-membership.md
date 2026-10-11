# Verified Korean index membership

## Correction and dated evidence

The manual-price parser previously assigned `KOSPI200` and `KRX300` to every ordinary stock. It now looks up the stock code in the verified, dated KRX constituent reference. The scoring rule remains an OR across KOSPI200, KOSDAQ150 and KRX300: the default +2 is awarded once, even with overlapping memberships.

Reference: `src/lib/engine/verifiedKrIndexMembership.generated.json`. The first snapshot is **2026-10-08**, downloaded from the official KRX index portal on 2026-10-11. The authenticated browser explicitly entered `20261008`, queried, and then downloaded each CSV. **The CSV files have no date column**; the UI query establishes the snapshot date. Every index retains its official source URL, observed download interval and source-file SHA-256. Repository constituents contain only symbol and name. Raw prices, trading values and capitalization were not copied into the reference.

- KOSPI200: 201 unique constituents
- KOSDAQ150: 150 unique constituents
- KRX300: 301 unique constituents
- Union: 384 stocks
- KOSPI200 / KRX300 overlap: 177
- KOSDAQ150 / KRX300 overlap: 91
- KOSPI200 / KOSDAQ150 overlap and triple overlap: 0
- 033340 (좋은사람들): absent from all three; known nonmember, zero index points
- Official alphanumeric codes are preserved, including 0126Z0, 0220W0 and 0009K0. Do not restrict future imports to six numeric digits.

## Runtime semantics

`resolveVerifiedKrIndexMembership(symbol, analysisDate)` uses the last complete verified snapshot on or before the analysis date. For dates before 2026-10-08, invalid dates, or invalid codes, membership is unknown (`NO_DATA`, zero points, excluded from available maximum). A known nonmember is `FAIL`, zero points, with the index component still included in available maximum.

After 2026-10-08, the same snapshot is carried forward until a later verified snapshot is appended. The rule detail explicitly shows **KRX 공식 2026-10-08 확인 (최신 확인본 이월)** when carried forward. This is a last-verified reference, not a claim that KRX was rechecked each day. The lookup date is the snapshot date, not the download timestamp; this reference alone does not certify that the list was known prospectively on October 8.

The parser attaches `indexMembershipsProvenance`. The analysis pipeline re-resolves only instruments carrying this marker against the requested analysis date, preventing current metadata from leaking backward when a dataset is sliced. Explicit, legacy or frozen inputs without the marker remain unchanged. The source dataset is not mutated. The three lists establish no Korea Value-Up membership; the parser leaves that separate, non-scoring reference item `NO_DATA`.

No technical 10-point component, Onset/entry/exit rule, universe filter or portfolio allocation formula was changed. Priority ordering and technical-score tie-breaks can change because nonmembers lose the incorrect two points.

## Measured local impact

Run `node_modules/.bin/vite-node --script scripts/audit-verified-index-membership.ts` for a reproducible local-only comparison. It does not read production data, call a database, replay any ledger, or upload results.

- Repository-reviewed sector master plus additional reviewed codes: 627 codes; 355 retain +2, 272 lose the fabricated +2. This is **not a count of the current production screening universe**.
- Synthetic full-engine fixture: 20 existing mock stocks plus one deliberately cloned nonmember 033340 stress case. All prices remain synthetic; the clone is not actual 033340 market data.
- 20 synthetic stocks keep their priority; the nonmember loses exactly 2.
- Changed technical scores / Onset / entry / exit / hard-filter outcomes: 0.
- Technical-then-priority order: 3 positions move. Priority-only order with symbol tie-break: 13 positions move. These demonstrate possible ordering effects, not production trades or returns.

## Cache and history boundary

All three live representative cache versions change from `*-cache-v8-universe-pending-v1` to `*-cache-v8-verified-kr-index-20261008-v1`:

- `cache/screening/latest.json`
- `cache/dashboard/latest.json`
- `cache/instruments/<symbol>.json.gz`

The shared screening input fingerprint and the React-query keys include these versions, so old +2 results are not silently reused after deployment. The new manifest also changes `SCREENING_CALCULATION_VERSION`, invalidating publication receipts for the old calculation. No cache object was deleted or rebuilt during this local preparation. No research/runtime-feature cache or immutable archive version was changed.

A cache miss uses the existing normal refresh/publication flow; invalidation is not a historical migration. That flow can generate a **new** run archive and can update the same-day daily representative on/after 2026-10-02. The existing pre-adoption guard preserves an already-stored representative before that date. Immutable run-ID records remain protected by `ignoreDuplicates: true`; they are not recalculated or overwritten by this change.

The history list and detail routes continue to read stored `screening_run_archive` / `screening_history` records. They do not invoke the new lookup to reconstruct old scores. An old date-only link whose representative was replaced fails its stored-time identity check instead of substituting current results. Use a run-ID archive for durable per-execution identity. Tests verify both read routes and this fail-closed behavior.

## Runtime admission and rollout review

The final integrated runtime is `sha256:e1ce0e3d5326c6d57dc2906f4bd42a4a4897ca3eaf2393b998fc09b3b6873869`, with 44 calculation sources. Independent review approved this exact hash before admission. Lookup/reference JSON and the extracted replay calculation helpers are included; neither reference data nor replay input filtering is exempted from hashing.

This is not blanket byte-equivalence with reparsing old CSV: before October 8 the old parser fabricated +2, while the corrected parser reports unknown. The complete-input replay goldens explicitly supply the original historical memberships and omit the new lookup marker; their exact expected hashes and frozen registry identities remain unchanged. Separate tests verify corrected parser inputs and the intentional priority/order effect. Existing saved archives and supplied untagged historical memberships retain their original interpretation.

No remote repository changes, Supabase writes, production screening, research reruns or ledger replays were performed for this preparation.

## Monthly maintenance checklist

1. Retrieve all three official constituent lists with an explicitly recorded query date. Record the fact that the CSV does not itself contain a date, download time, official URL, file hash, observed row count and unique code count. Do not force 200/150/300 row counts when the official export legitimately differs.
2. Append a new complete snapshot to the reference array. Keep prior dated snapshots and their contents unchanged; do not overwrite October 8 with a later list or backdate a current list. Keep only symbol, name and provenance. Preserve leading zeros and official alphanumeric codes.
3. Check all three counts, duplicates, additions, removals and overlaps. Confirm the latest eligible snapshot is selected for each date, and that an earlier analysis never receives a later snapshot. Run the focused tests and the local impact script.
4. Separately reconcile the screening/collection code roster. Missing collection alone never authorizes removing a stock. Distinguish transient missing data from verified suspension, delisting, code changes or newly listed stocks using official evidence. Index membership and the collected stock universe are different things. Preserve historical instruments and ledgers rather than deleting their identifiers.
5. Bump the three live representative cache versions for the new reference revision. Regenerate the current engine manifest with `node_modules/.bin/vite-node --script scripts/build-october-shadow-manifest.ts`; the new JSON must contribute to the hash. Review the runtime before admission, preserving frozen identities and existing artifacts. Do not automatically rerun historical screens or research.
6. Record the dated additions/removals, coverage limitations, effective snapshot date, cache version and reviewed runtime in this document or a new dated review document. Publish only within the authorized rollout scope.

### Changelog

- 2026-10-11: Initial official snapshot for 2026-10-08; replaces blanket stock membership in new manual-data calculations. Independently reviewed and admitted locally; deployment is recorded separately.

## Local verification

- Focused membership/scoring/impact/history tests: 78 passed.
- Existing unchanged-input complete-input replay goldens: 2 passed with original expected hashes.
- Repository TypeScript check: passed.
- Repository ESLint: no errors; 9 pre-existing Fast Refresh warnings.
- Production build: passed before final review handoff.
- Final integrated admission: ledger 410, October Shadow 90, source pipeline 103, screening memory 163, UI reorganization 136 and dashboard 549 passed. Final integrated type check, ESLint (zero errors; 9 existing warnings), and production build also passed. Publication is tracked separately.
