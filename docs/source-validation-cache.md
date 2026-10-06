# Verified source reuse and upload recovery

This changes source transport/validation work only. It does not change trading rules,
Shadow timing, overlap precedence, source hashes, or analysis calculations.

## Source validation cache

- `SourceValidationCache` is screening-only. Backtest/gzip migration paths keep their
  existing behavior.
- The first pass downloads fresh bytes (`cacheNonce` plus `cache: no-store`), verifies
  the registered file/logical/data/schema hashes and runs the existing validator.
- Authenticated Storage `info()` must show the same object ID and version UUID before
  and after that pass. Supabase gives each uploaded object generation a new UUID.
- Reuse requires a fresh matching ID/version and the same registry identity plus
  validator fingerprint. Size and modification time are never identity proofs.
- The validator fingerprint covers the actual validator, transitive relative and
  `@/` mapping imports, dependency lockfile, Node version and collation locale.
- Cached normalized values are independently checked against the registered data
  and schema hashes. Rows retain their original order. Bad entries fall back to full
  validation; explicit authorization/RLS denial stops rather than trying another path.
- Missing revision information or unavailable validator source files disables the
  optimization and preserves full validation. This matters in bundled server deployments.
- Format `cloudtrend-source-validation-cache-v2-fresh-origin` rejects older proofs that
  did not require origin-fresh downloads.

`registerSourceBytes` automatically shares a request-scoped cache between its initial
source load and legacy synchronization. It re-reads the uploaded raw bytes before
reusing the already-validated new input. Cold source validation is sequential to avoid
expanding every large history file at the same time.

For separate CLI/Colab invocations, set `SOURCE_VALIDATION_CACHE_DIR` to a private,
runner-owned directory outside the checkout. The default is memory-only. A new runtime
with no cache must validate once; old Colab notebooks pinned to earlier commits do not
gain this feature merely because the repository changed. Upgrade the notebook's pin
only after the combined changes are reviewed and deployed. The revised notebook must
also explicitly reconcile its raw header aliases with canonical compaction columns,
preserving all existing nonempty values; old strict schema-equality publishers cannot
be assumed compatible with canonical compacted files.

The cache is a disposable optimization, not an authoritative data store. It is intended
for a trusted private directory, not a shared or externally editable folder. Cache
checksums detect corruption; they are not signatures authenticating arbitrary edits to
metadata or row order. Keep original source objects and registry records authoritative.
The code creates new cache files with private modes but does not change an existing
directory's permissions. Never put credentials in cache files.

## Measured regression fixtures

The synthetic integration fixture verifies exact legacy CSV and full analysis parity,
including conflicting overlapping rows and activation order. With two old inputs and
one new input, source downloads drop from the former 2+3 passes to three total. A separate
subsequent cache instance with a new input downloads only that new stored object.
An additional separate-Node-process test verifies cache reuse after process restart.
These are test counters, not a claim about live production elapsed time; the real source
compaction/apply run must record its own metrics.

Run `npx vitest run --config vitest.source-pipeline.config.ts` and the existing
`vitest.screening-memory.config.ts` suites before rollout.

## Idempotent JSON uploads

JSON storage upserts serialize once and retry the same bytes/path/options only:

- Explicit transient HTTP/network/timeout failures: at most three attempts
- Empty or opaque SDK diagnostics: at most two attempts, without assuming a root cause
- Auth/RLS, validation, cancellation and configuration failures: no retry

Errors/logs retain allowlisted status/code/name, attempt counts, elapsed times, object
location and byte count. Raw error messages, bodies, headers and nested causes are not
logged. URLs, tokens and accidental credentials in location metadata are redacted.
This does not retry non-idempotent registry inserts or change permissions.

## Read-only hosted measurement

After a successful cutover, `scripts/run-source-validation-profile.ts` runs one cold
and one warm read in separate cache instances, compares their complete input identity,
and prints only aggregate counters/timing. Use `vite-node --config
vitest.source-pipeline.config.ts scripts/run-source-validation-profile.ts`, without
`--script` (that mode discards the explicit Vite configuration in the installed version).
The compaction workflow treats a profile failure separately from an already committed
cutover. Do not replay cutover just to recover timing evidence.
