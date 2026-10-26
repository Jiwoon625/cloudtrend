# Lite r3 daily runtime

Daily collector stages used by a small, private Colab notebook. The notebook pins both the repository commit and the SHA-256 of `runtime.zip`; the ZIP contains the `cloudtrend_lite_r3_runtime` Python package.

- Import has no collection or network side effects. Run `STAGES` sequentially with `run_stage(name, notebook_globals)`.
- Account destinations, owner identity, Drive paths and credentials are supplied by the notebook or existing Colab Secrets, not embedded in this package.
- Existing KR publishing and post-upload screening requests are retained. US collection keeps the 400-bar cache and 15-bar incremental request policy.
- US daily inputs are preserved before upload. Automatic catch-up accepts only original dated atomic inputs. Historical reconstruction tooling is deliberately excluded.
- Partial uploads do not trigger screening. Request journals suppress duplicate or uncertain dispatches. An unfinished catch-up blocks advancing ingest until its publication receipt is complete.
- `runtime.zip` is a versioned release artifact, not a mutable dependency. Changes require rebuilding it and updating the notebook's commit and hash together.

The thin notebook reduces notebook source and saved-output size. No measured Colab opening-time or peak-memory improvement is claimed.

## Latest-price-unconfirmed policy (Lite r4 daily v2)

A successful candle response with no positive confirmed-session bar is held as
`latest_price_unconfirmed`, including gaps longer than seven calendar days.
The cache/provider last-bar dates, confirmed session, gap length and error are
recorded separately in dated collection evidence and upload metadata. No
suspension or corporate action is inferred, and no current bar is synthesized.
Held rows carry no executable prices or scores; source coverage remains false.

The existing aggregate limit of 10 symbols is retained across short, long and
empty incremental responses with valid prior cached prices. Missing cached
evidence still blocks upload. SPY is never exempt.
Authentication, HTTP, network, malformed-response and other unexpected failures
remain fatal, including for guarded corporate-action candidates. Rejected
checkpoint bytes are preserved by content hash before retrying. Healthy current
cache rows/checkpoints are reused on same-session reruns.

Build and verify the release with:

```sh
python collectors/lite_r3/build_release.py
python collectors/lite_r3/test_runtime.py
```

Tests require pandas, numpy and pyarrow. The import/package path remains
`cloudtrend_lite_r3_runtime` for existing thin notebooks. Updating source or main
alone cannot update a pinned notebook: replace both its `_RUNTIME_COMMIT` and
`_RUNTIME_SHA256` only after the exact commit is available, preserving the
original notebook and all unrelated cells/settings/outputs.

This policy does not relax original-atomic-input, replay, immutable-source,
upload-readback or screening-dispatch guards. A historical session without a
saved atomic input still requires separate evidence-backed recovery review.

## Verified DBRG common-stock lifecycle (Lite r4 daily v3)

The maintained roster remains in the owner's Drive at
`CloudTrend/미국시장/reference/us_collection_universe_v1.csv`. Generated
`us_universe_seed.csv` and `us_toss_master.parquet` are daily outputs, not the
maintained source list. Verified lifecycle exclusions live in
`runtime/stages/us_setup.py`.

DBRG common stock is excluded from candle requests from 2026-09-30 using
[DigitalBridge's Form 8-K, Item 3.01](https://ir.digitalbridge.com/node/15466/html)
and an issuer-name guard. This exact-symbol event does not cover DBRG preferred
series. Before the effective session, normal collection applies. The roster and
historical cache evidence are retained; no historical source or result is edited.

The published 2026-10-09 source remains immutable. Lite r4 daily v4 handles a
registered same-date DBRG conflict by deriving a separate reviewed CSV from the
hash-verified original archive. It retains every row and all unaffected values;
only conflicting securities from the verified lifecycle registry become non-scoreable with
blank price/score fields. `SUSPENDED` is the engine's existing exclusion state,
not a new exchange-status claim. Existing seven-symbol price holds are retained.

The original CSV, dated `source.json`, roster and ingest pointer are never
replaced. The derivative has its own content hash and reviewed manifest, which
references the original source hash and the already maintained lifecycle
citations. All four objects (original, roster, derivative, manifest) are uploaded
without upsert and read back before dispatch. Same-date reruns reproduce the
same manifest and use the existing request journal to avoid duplicate or
uncertain dispatches. Ordinary same-session price corrections, SPY changes,
unknown lifecycle conflicts and missing/mismatched originals still stop safely.

The paired server change admits this reviewed manifest to daily publication
using the original hash for ingest/history identity and a separate recovered
view. Original results, ledgers and conflicting completed batches remain
immutable. A pending request must finish its publication receipt before the
next collection proceeds. The next new confirmed session uses the existing
lifecycle collection policy without deriving an older source.

Release order matters: merge/deploy the paired server changes before pointing
a notebook at this runtime. Rebuild twice to verify the ZIP hash, publish the
exact commit, then update both private notebook pins together. Never use a
local-only commit as a downloadable notebook pin. No production replay is run
by the release build or tests.

Lite r4 daily v5 also sets the verified derivative Storage path for both final
summary stages. The regression runs every stage from upload through the final
integrated summary in fresh and repeated sessions, without a stale path from
a preceding ordinary upload.

The same-date derivative path is issuer-neutral: adding a verified registry
event does not require another collector exception. Exact registry membership,
valid effective session, HTTPS evidence and mandatory nonempty issuer identity are
checked; future events, unknown events and reused ticker identities cannot
change the frozen source. The WBD-only previously published-view reuse contract
remains supported. Missing provider prices alone remain temporary holds and
never create permanent lifecycle exclusions.

## Bounded recent volume revisions and completion receipts (Lite r4 daily v6)

A new mutable-cache path accepts a **volume-only revision of the immediately
previous confirmed session**, provided the cache's actual latest date is exactly
that previous session. It requires a complete 15-bar response, matching overlap
date sets, at least ten older unchanged bars, unchanged OHLC throughout the
overlap, canonical unique/monotonic dates, matching issuer symbol/currency,
finite positive prices, valid OHLC ranges, and finite nonnegative volumes.
The changed old/new volumes must both be positive and their ratio must be within
0.25–4.0. This bound is a conservative heuristic, not proof that unrequested
older history is unchanged. Every OHLC change, older/multi-date volume revision,
extreme/zero transition, or insufficient/unsafe evidence retains the existing
full-history fallback. Malformed duplicate candle dates fail closed. Existing
ordinary unchanged-window behavior is not broadened.

Accepted revisions are saved as `incremental_recent_volume_revision`, with
policy, date and old/new volume evidence in the checkpoint and dated diagnostics.
Only the rolling mutable cache is merged. Frozen dated input bytes, source
receipts, hashes, same-session publication checks, lifecycle guards, gap limits,
score holds and remote dispatch semantics remain unchanged. Same-session cache
reuse still does not poll the provider for late corrections or rewrite an
already published original.

The collection iterator is explicitly refreshed/closed, including interruption,
and the collector prints a plain-text processed-count receipt followed by a
separate QA-success receipt only after validation. The final notebook summary
counts its ten local stages, reports holds, and continues to distinguish a
remote request being accepted from the remote screening engine completing.
A stale Colab progress widget cannot replace these receipts. Stage completion
and universe coverage are still different claims.

The observed incident had 5,287 volume-first and 39 OHLC-first fallback reasons;
no production-wide request reduction is claimed from those counts. Synthetic
regressions cover bounded increases/decreases, unsafe boundaries, resume,
collection-to-summary flow, immutable-source preservation and duplicate dispatch
suppression. Publication and private notebook replacement remain separate
release steps: a local runtime build is not an installed production update.

### MAMK ongoing trading halt

MAMK / MAXSMAKING INC is classified as `SUSPENDED` with issuer identity guard
`MAXSMAKING`, using Nasdaq's continued-halt date of 2025-12-02. This is an
exchange trading halt, **not completed delisting**. The earlier SEC suspension
started 2025-11-17; the 2026-10-01 F-4 still reports halted trading and a pending
appeal. The registry retains separate citations for these facts:

- [Nasdaq continued halt](https://ir.nasdaq.com/news-releases/news-release-details/nasdaq-halts-maxsmaking-inc)
- [SEC initial suspension](https://www.sec.gov/files/litigation/suspensions/2025/34-104180.pdf)
- [October 1 F-4](https://www.sec.gov/Archives/edgar/data/2008007/000121390026105846/ea0307124-f4_maxsmaking.htm)

Current-provider `ACTIVE` labels or repeated positive-close/zero-volume cached
bars do not override this verified halt. MAMK candle requests stop while this
registry entry applies; raw history and roster identity are retained. No prior
frozen source is rewritten. Same-date status correction uses the existing
verified derivative path and preserves other holds and original receipts.
A future official resumption requires evidence-backed registry maintenance.

### Paired current-ledger boundary

This release also includes the separately reviewed current-ledger/reporting
boundary. `UsArchiveApi.common_base()` uses completed screening plus the exact
October 12 restart US books for current sessions; it does not require stale
September operating or October 5 beta books to advance. Historical predecessor
checks retain their prior path. The paired server replay, publication and
reporting contracts must be deployed before updating the pinned private
notebook. See [current report source contract](../../docs/current-report-source-contract.md).

Collector revision rules and the new-ledger boundary were independently
reviewed, then tested together. The US validation workflow runs both new
TypeScript suites and the Python predecessor tests. This release does not
authorize production data deletion, execute a replay, or erase historical
research/actual records. The retirement planner is read-only.

## Daily v7: explicit price-versus-score quality

New archives and ingest metadata carry `us-source-quality-v1`. A verified
history-length score hold is no longer mistaken for a missing-price quarantine.
The overall coverage flag remains false; all held score inputs remain blank,
`active20=false`, and the frozen engine still cannot create an entry from them.
Unknown quality states and hard identity/hash/session guards remain blocking.
See [the contract and rollout boundary](../../docs/us-source-quality-contract.md).

The paired TypeScript replay/publication adapters must be installed first.
Run `python collectors/lite_r3/test_us_source_quality.py` as well as the existing
runtime suite. The CI replay target includes the Python-to-TypeScript golden
contract test. No recovery or full collection is started by these tests.
