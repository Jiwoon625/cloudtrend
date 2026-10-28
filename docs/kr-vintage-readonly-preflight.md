# Read-only adjusted-vintage preflight

This manual diagnostic is not a source approval, operational replay, accounting migration, or permission to replace an immutable session. It performs no database/Storage writes. Existing model and actual ledgers remain untouched.

## Independent gates

1. Review an evidence-only capsule privately before staging it through a separately authorized append-only mechanism. This implementation never stages it. The capsule holds original capture bytes, exact frozen run/config/source identities, and frozen integrated book state hashes. It cannot carry executable code, query expressions, arbitrary URLs, or an alternative normalization policy.
2. Review the exact code/CI head, merge normally, and dispatch only from main after concurrency checks. Supply the independently reviewed **opaque canonical capsule hash** and revision. Do not supply owner IDs, source IDs, prices or other private data as workflow inputs. No secrets are printed.
3. Materialization uses the existing Supabase secrets only in its dedicated step. It checks the exact owner, unique namespace/revision, independently supplied hash and recomputed canonical hash. Conflicting rows fail, never latest-wins. All reads are bounded GET/HEAD, owner-filtered, and limited to constructed existing-table/object paths on the configured project origin. Redirects and RPCs are prohibited.
4. The original completed analysis run and its result bundle must agree with the frozen config, code/data version and **ordered** source roster. A sorted hash multiset is insufficient. Source bytes, canonical data/schema hashes and registered identities are revalidated. No current active/latest input is consulted.
5. Frozen integrated book state hashes bind KR/US evidence through exact session receipts. Original capture files are byte-hashed, raw provider pages reconstruct the full returned window, and the normalized tail is reproduced. Candidate history overlays exactly the existing baseline dates, without trimming uncovered history or inventing extra observations.
6. Credential-free pure computation first reproduces the frozen baseline. Tagged collector proxies can be recomputed only from original verified operands and provenance. Independent observations and actual monetary values are retained. A counterfactual historical clock does not claim the later capture was available at the original decision time.

## Output and isolation

The pure child receives a minimal environment without Supabase/GitHub credentials, proxy variables or caller runtime flags. Its dependency graph rejects server/Supabase/network/process-launch modules. The parent captures and never forwards child stdout, stderr or thrown error messages. Public output is a fixed allowlist of status categories, booleans and counts. The reviewed input digest is an opaque workflow input; source/capture IDs and detailed financial comparisons are not public outputs.

Detailed local results and raw input files are ephemeral runner files (private permissions), never Actions artifacts. Cleanup runs on success/failure. A sanitized failure does not authorize bypassing a guard, changing the data plan, or overwriting history. Persisting detailed results privately would require a separately reviewed and authorized transport.

`PREFLIGHT_COMPARED_NO_OPERATIONAL_APPROVAL` means the pure comparisons ran, not that the candidate is economically equal or safe to publish. Inspect the allowlisted baseline/equality results and resolve the independent operational gates before any new action. Source-hash-only equivalence is a diagnostic finding, never an implicit immutable-history exception.

## Local synthetic checks

```sh
npx vitest run scripts/kr-vintage-preflight
node scripts/build-kr-vintage-preflight.mjs
```

The automatic safety workflow uses only synthetic tests and dependency/runtime checks, with no service secrets. The private-data workflow is manual-only. Public code and tests contain no actual private capsule, source roster or investment values.
