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
- 2026-11-01: Appended the complete official **2026-10-30** snapshot after explicitly querying `20261030` in the KRX constituents UI before each CSV download. All three series pages showed October 30 as their latest data date. KOSPI200 / KOSDAQ150 / KRX300 contain **201 / 150 / 301** unique constituents; the union remains **384**. Compared with October 8, additions, removals and name changes are all **zero**. The CSVs do not contain a date column; the JSON retains query-date evidence, actual UTC download intervals, official URLs and each complete CSV's SHA-256. Only symbol/name and provenance are copied into the repository; raw market-value fields remain outside it.

### October 30 reference maintenance boundary

The October 8 snapshot is preserved exactly. Analysis through October 29 continues
to select it; October 30 and later select the new snapshot (with explicit forward
carry after October 30). Both snapshots were observed after their query dates;
neither claims contemporaneous pre-open availability. No historical archive,
price, source, ledger or research result is rewritten or recomputed by this update.

The three live cache revision strings advance to
`*-cache-v8-verified-kr-index-20261030-v1`. This refreshes the displayed provenance,
not the scoring rule: every membership and index-priority score is unchanged.
The existing +2 OR rule, US A0 rules, allocation/cost rules, collection universe
and original collectors/notebooks remain unchanged. Frozen strategy identities
and previous runtime admissions are retained. New exact runtime manifests require
separate independent review before admission and deployment.

Tests pin the original snapshot hash and check all 384 members plus a nonmember
across the October 29/30 boundary, unchanged scores, reverse-sliced tagged
instruments, forward carry and original untagged historical inputs.

Independent staged review on November 1 approved these exact executable hashes:

- October Shadow: `sha256:6b5ebf3f2cfe28f48586900276a7117fd52ac40c1e66835ccf7d4ca58c686a9d`.
- Integrated allocation: `sha256:beab26ef5b4cbab6d4f34b31ac443b14d427d91856f67a6d63b6276e279e91c2`.
- KOSPI publication: `sha256:55dcf41767160a6b507422447ee6a4818b34a41a55205128086bbce6d058c990`.

The official reference remains inside each transitive calculation digest. The
existing admission guards, frozen identities and previous admissions are unchanged;
only these separately verified hashes are appended. Deployment is tracked separately.

## Local verification

- Focused membership/scoring/impact/history tests: 78 passed.
- Existing unchanged-input complete-input replay goldens: 2 passed with original expected hashes.
- Repository TypeScript check: passed.
- Repository ESLint: no errors; 9 pre-existing Fast Refresh warnings.
- Production build: passed before final review handoff.
- Final integrated admission: ledger 410, October Shadow 90, source pipeline 103, screening memory 163, UI reorganization 136 and dashboard 549 passed. Final integrated type check, ESLint (zero errors; 9 existing warnings), and production build also passed. Publication is tracked separately.

## November 8 maintenance: November 6 official snapshot

All three official KRX constituents tabs were explicitly queried with `20261106`
before CSV export on November 8. Each series displayed November 6 as its latest
data date. The CSVs have no date column: the UI query supplies the date evidence.
KOSPI200 / KOSDAQ150 / KRX300 have 201 / 150 / 301 rows and unique codes, union
384, with no additions, removals or name changes compared with October 30.
This verifies the endpoint snapshot, not every possible intermediate event.

The JSON appends the complete November 6 snapshot and preserves both prior
snapshots exactly. It retains only symbol/name and official provenance, not raw
prices or market values. Two exports have observed UTC intervals; KRX300 has
only its filesystem download-completion timestamp, explicitly not an invented
observation interval. Download was November 8, not contemporaneous November 6
knowledge. Analyses through November 5 continue to select the older snapshot.

The live cache revision is advanced within v9-current-price (not reverted to v8)
to `v9-current-price-verified-kr-index-20261106-v1`. Membership scoring, US A0,
allocation/cost rules, frozen identities, and historical prices, sources, ledgers
and research results remain unchanged. No historical calculation is rerun.

Separate collection-universe review found November 6 US ingest price coverage
complete for 5,303 symbols, with zero price failures/provider gaps. VJET and WQEY
remain scoring holds (25 verified post-event bars versus 253 required), not new
delistings or price failures. The latest maintained US roster could not be
retrieved: local copies do not match the production roster hash, so none were
used to overwrite the current roster. No new US index admission condition is
introduced.

Korean active source registry has 614 stocks and 1,184 ETFs for November 6,
versus 1,188 ETFs in the differently-windowed November 5 source. The four-count
difference is not proof of four daily price gaps or delistings; exact source
symbol-set reconciliation remains pending. Both source lifecycle metadata are
absent, and the separate lifecycle/halts tables are empty, which is not proof
that repository date-effective ETF policies are absent. Existing policies are
preserved. Official ACE evidence identifies 0259R0 as a November 3 new listing;
its presence in the latest source and collection eligibility still need checking.
Other unverified IPO candidates are not automatically admitted.

Collection-target additions, exclusions and status changes applied in this run:
zero. This is a partial collection-universe audit, not certification that no
eligible new instruments exist. Runtime review, regression and deployment results
are recorded separately after verification.

Independent November 8 review verified all three CSV hashes and exact constituent
sets against the appended snapshot and approved these exact executable digests:

- October Shadow: `sha256:c76bfb242a0a5b8f55c4a96ad07a9804f40b153f23b1e33a81a26c5cdf2d315d`.
- Integrated allocation: `sha256:6010730627ad80716a4b5e574996dffcd20b850315e120d5113a074d08fc95bb`.
- KOSPI publication: `sha256:a7be012bc6aa82613b981251a74756434224c31d7f76f8c3ded260acf85648e0`.

Only final reviewed digests are admitted; previous admissions/frozen identities
remain. Both Shadow preflight and native KOSPI runtime verification passed.
Focused tests 53, source pipeline 161, screening memory 357, UI reorganization
147, dashboard 783, ledger 506 and October Shadow 183 passed (suite counts overlap).
TypeScript and changed-file ESLint passed. Runtime generation also refreshes the
KR signal manifest; US signal codeHash remains unchanged. Deployment is recorded
in the private maintenance notes after live verification.
