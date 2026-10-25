# Restricted shortlist14 summary export

This standalone reporting tool is outside engine/input source-hash roots. It reads
exactly the 14 summary/completion pairs identified in the SHA-pinned allowlist
(605,798 bytes), through the unchanged authenticated private Storage adapter.
The public allowlist contains only candidate IDs, hashes of identities and byte
bounds, not private owner/project IDs or original identity paths. Each exact
candidate prefix gets one bounded metadata lookup (100 entries / 64 KiB); only
the identity whose hash matches is accepted. A full page fails closed without
broader listing or pagination. The 28 source bodies remain the entire download.
It neither runs the engine nor reads output ZIPs/checkpoints or changes sources.
No new credentials, grants, policies, bucket settings, or deployment are needed.

## Verification and limits

Every completion identity digest, candidate, plan and summary execution contract
must match. All source sizes, numeric types, yearly rows, evaluation window,
research-only limitations and fee/annualization conventions are checked before
any report write. Duplicate JSON keys and non-finite values are rejected.

**Completion has only an output ZIP hash, not a summary hash.** Therefore this
bounded extraction cannot cryptographically prove that the posted summary is the
one in the ZIP, recompute NAV or audit accounting. Each report explicitly says
`SUMMARY_IDENTITY_VERIFIED_NOT_ARCHIVE_AUDITED`; both posted source hashes and the
unverified declared ZIP hash are retained. These are saved historical metrics,
not new backtests or newly independently audited returns. The saved summaries do
not contain rolling 24-month statistics; those remain unavailable, not estimated.

## Private destination and idempotence

Fourteen small reports are create-only, content-addressed JSON objects beneath
the existing owner's `research/cm/results/reports/shortlist14-summary/<plan>/`.
Only selected aggregate numbers, source digests and fixed research caveats enter
the bounded `x-metadata` header (8,192 bytes maximum). The same data can be read
by existing authorized SQL metadata access; no access rules are altered. No raw
summary, completion, holdings, keys, links or private metric values enter Actions
logs/artifacts. Authenticated readback verifies new object bytes. Existing equal
reports are no-ops; any conflict fails closed. Partial network failures can leave
some reports created; re-running only after checking existing IDs safely reuses
the same deterministic keys.

## Run authorization

The new workflow is **workflow_dispatch only**; PR checks have no credentials.
Publishing this feature does not authorize merge or execution. After specific
approval to merge and run once, dispatch `cmresearchengine-shortlist14-summary-export.yml`
on the reviewed commit. It has no path/bucket/candidate inputs. Existing backend
credentials are supplied only to the final exporter step. Do not invoke the
broad archived-result audit/exporter or research runner for this request.

Success emits only a fixed status/count. On failure it emits a fixed blocked
status without exception contents. Check private metadata/object state before
retrying an uncertain run. After success, read all 14 `user_metadata` reports
through authorized SQL and verify source identities, report SHA and private
bucket state. Do not claim the user's comparison is finished until that readback.

## Local tests

```
PYTHONPATH=research/cmresearchengine python scripts/test_cm06_shortlist14_summary_export.py -v
PYTHONPATH=research/cmresearchengine python -m unittest discover -s research/cmresearchengine/tests
```
