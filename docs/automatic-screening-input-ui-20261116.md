# Website screening inputs retired (2026-11-16)

## Decision
The owner has automated collection/calculation/publication and explicitly chose to remove all manual screening source-input controls from the website. Restoring a manual calculation button for PR #422's review finding is therefore not the desired remedy.

## Change
- Data management retains automatic pipeline status and saved-result navigation.
- Remove the active CSV/XLSX/JSON/paste input section, its source restoration, and its visit-time screening/cache reset.
- Remove manual JSON artifact installation from underlying-index diagnostics while preserving read-only comparisons and report download.
- Remove unused legacy US input and collector-snippet widgets to prevent accidental reintroduction.
- Empty/loading guidance now describes automatic publication and result reading rather than requesting an upload.

## Preserved boundaries
No stored source files, registry records, screening histories, research results, or actual trades are deleted.
No collector, Drive executor, scheduled workflow, scoring strategy, publication contract, permissions, or secret is changed.
Backend ingestion/API/MCP routes remain available for existing automated integrations.
Manual recording of actual trades is a different feature and is preserved.
The existing explicit dashboard re-screen action is not changed by this source-input UI removal.
No actual screening run or data publication is needed for this change.

## Verification
Use the UI regression suite, read-only screening client/server tests, portfolio refresh non-mutation tests, TypeScript, lint and full build. All service behavior in tests must use fixtures/mocks; do not upload an operational file to test removal.

### Completed local validation
- UI regression: 152/152.
- Portfolio freshness/source boundary: 76/76 with one worker and a 20-second per-test timeout. Initial concurrent execution hit a 5-second timeout in the large CLI fixture and a subsequent mock-count spillover; isolated rerun passed without code changes to that suite.
- Full build/prebuild passed: screening identity 23/23 and trade-approval 137/137 plus atomic record tests. Latest UI-only rebuild passed, 294.3 KiB gzip initial dashboard against 320 KiB budget.
- TypeScript and changed-file lint passed.
- Independent review caught the underlying-index manual JSON installer; it was removed and regression coverage added. No remaining functional blocker.
- No live workflow, data write, upload or source deletion was used for validation. Authenticated live UI remains a separate read-only check.
