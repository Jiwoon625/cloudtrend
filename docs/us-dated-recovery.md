# Dated US model recovery

US recovery is a separate, explicit workflow path. It never replaces the ordinary
US ingest pointer, completed screening history, daily result, or actual ledger.
There is no recurring screening schedule.

## Source contract

An owner-private `us-dated-replay-v1` manifest identifies a fixed base session and
all following regular sessions through a fixed final date. Each date has its own
immutable CSV, SHA-256, counts, original capture timestamp, explicit coverage and
quarantine evidence, and a hashed dated roster. The roster includes security
identity, sector, status, share count and tradability metadata. The reviewed
calendar must contain every date, with no gaps or reordering.

A saved atomic daily snapshot retains its original date and bytes. A reconstructed
snapshot must use a roster known before that session's close. Today's master or
revised cache is not evidence of an earlier input. Retrieval time alone does not
prove when a fact became effective. Carrying prior-known metadata forward needs
explicit provenance review; it is not equivalent to a recovered original daily
snapshot. Missing checkpoint, effective-date or price-vintage evidence blocks
recovery. The collector should retain new date-specific atomic snapshots and
receipts so future missed uploads do not require such assumptions.

A `REVIEWED_ATOMIC_QUARANTINE` derivative is a separate source, never an
original atomic snapshot. It binds the original CSV hash and original pre-next-open
capture plus dated official lifecycle evidence. It can only blank market/feature
values and disable the named securities. All other parsed input fields and the
full original universe remain unchanged. It is a reviewed recovery path, not an
automatic permission to revise historic results.

`sourceCoverageComplete=false` is retained honestly. Explicit quarantines must
have null open, close and return inputs. A legacy `toss_tradable=true` flag on such
rows is admitted only because the unchanged scorer excludes null prices from the
ranking universe. A held or pending model security without fresh current prices
blocks the entire batch. No stale-price trading is permitted.

## Read-only preflight

`npm run us:replay -- --user OWNER --manifest OWNER/PRIVATE_PATH --manifest-hash sha256:HASH`

The driver verifies all source bytes and roster metadata, preserves original
screening-result hashes, loads the exact predecessor rank state, and calculates
all three independent Shadow books in memory using the unchanged frozen engine.
It separately plans all four operating books, reconciling shares, cash, fees and
NAV. The service-only RPC is called with `p_apply=false` to validate every planned
snapshot, trade and predecessor without writing rows. A malformed final day does
not publish the valid first day. No bootstrap state or skipped date is allowed.

A dry-run is not evidence that the source's historical provenance was independently
reviewed. The caller must certify that the dates and lineage are genuine.

## Apply and retries

Add `--apply` only for the reviewed exact manifest hash. After preflight, the
driver stores an immutable private prepared plan and all verified continuation
rank states before committing the existing Shadow prepared decisions and calling
the operating RPC with `p_apply=true`. Conflicting continuation artifacts are
checked read-only during preflight.

The operating transaction is atomic, service-only and security-invoker. It uses
predecessor/configuration/PENDING compare-and-swap, immutable plan identity and
accounting checks. It never overwrites prior snapshots or actual execution
columns. Exact completed retries return the original receipt.

Shadow and operating persistence are distinct transactions. A network failure
between them can leave a prepared or partially committed recovery. Do not create
a different manifest to bypass this. Retry the same immutable manifest: completed
Shadow sessions are verified/reused and the operating receipt is idempotent.
Normal screening and recovery share the same GitHub workflow concurrency group.
External/manual writers can still cause a CAS conflict, which fails closed.

Recovered rank state lives under a separate private `results/us-replay-state`
prefix and feeds subsequent sessions. It does not replace a prior ordinary
screening's bootstrap/reset result. The recovery receipt records source coverage,
model identities and preserved original results separately.

## Workflow inputs

`us-prospective-screening.yml` accepts:

- `replay_manifest_path` and exact `replay_manifest_hash`
- `replay_apply`: default false, full preflight only
- `replay_expected_plan_hash`: optionally pins the exact operating plan approved after preflight
- `replay_publish_recovered_view`: default false; after a successful apply, publishes
  the already computed current-date analysis to a separate immutable recovery result
  and the rebuildable screen caches. It requires an existing original dated result.
- `replay_then_screen`: the legacy ordinary-screening chain. Keep this false for
  recovered current-date publication; it must not be combined with the recovered-view flag.

The recovered-view path never recalculates signals or writes model/history rows.
The original daily result and history remain unchanged. Its explicit provenance
and incomplete-coverage status are retained in the cache and shown on the US
screener. A later ordinary same-date refresh reuses the validated recovered view,
instead of restoring the earlier bootstrap presentation. Missing future ordinary
history completion is a separate integration step; this path does not add it.

An empty replay path runs ordinary screening. Replay flags without a manifest
are rejected. CI must not publish raw sources, holdings, private plans or secrets.

## Verification and rollback

Run the US replay Vitest suite, isolated PostgreSQL suite, October Shadow and
ledger integrity suites, dashboard checks, collector tests, lint and build.
The existing calculation manifest and registered frozen contracts stay unchanged.

To suspend a faulty recovery path, remove its workflow dispatch use or restore
the prior deployment. Do not delete completed model sessions, edit an immutable
result, or rewrite a recovery receipt. Correct an implementation through a new
reviewed forward change; investigate and preserve any conflicting evidence first.
