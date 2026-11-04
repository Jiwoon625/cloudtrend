# KR November 3 recovery

This is a new, bounded retrospective recovery for exactly November 3, 2026 after the immutable November 2 predecessor. It proposes one new session for each of the five adopted KR/ETF MODEL books. It cannot initialize registries, rewrite previous sessions, change source registration, alter integrated/actual books, or write KOSPI Shadow objects. Earlier bounded recovery scripts are unchanged.

## One source capture, independent decisions

The KOSPI Nov3 authenticated capture downloads the 47 registered source objects once. Its credential-free compute passes the already validated dataset, the selected FINAL canonical CSV, its raw-file/generation/canonical-hash pins, full preservation inventory, immutable archived inputs, v1/v2 private vintage records and November lineage into `entry.ts`'s `computeKrCompanion`.

The companion independently extracts the three raw Unison auxiliary observations, converts the shared capture to the existing lossless FinalCapture codec, and computes a five-book KR plan. It stores a new actual computation clock in that capture. Full November predecessor payloads are validated once during capture conversion but represented in the KR capture by exact content hashes, avoiding a redundant approximately 100 MiB lineage body in every artifact.

All files are exclusive mode 0600 under the separate mode 0700 `$RUNNER_TEMP/kr-nov3-private` directory. The source CSV files are not duplicated. PLAN produces `capture.json`, `plan.json`, and `approval-candidate.json`. A candidate hash is a review proposal, not operational authority. An expected pure proof failure instead creates `diagnosis.json`, emits fixed status/phase/hash fields, and leaves no executable plan. Malformed input, resource and file errors still abort.

## Official authenticated commands

Build `transport.ts` as the authenticated bundle and invoke with `KR_NOV3_AUTH_ENTRY=true`. Imports alone never run the CLI. Runtime requires workflow dispatch on main, the exact admitted SHA, and the existing `kospi-prospective-shadow` concurrency group with cancellation disabled.

- `archive-plan`: accepted from the exact shared `KOSPI Nov3 reviewed recovery` workflow, or the KR workflow below. Rechecks preserved state and stores the private capture plus plan or blocked diagnosis. Never stages approval or vintage authority.
- `kr-plan-evidence`: same evidence action, restricted to `KR November 3 reviewed recovery PLAN APPLY`.
- `kr-materialize`: read-only materialization of the independently pinned original capture and plan. The official workflow then reproduces them in a separate environment-cleared pure process. Each authenticated action defensively reproduces again before any write.
- `kr-stage-approval`: operator must provide the independently reviewed `EXPECTED_PLAN_HASH` and `EXPECTED_APPROVAL_HASH`. The exact candidate is regenerated, checked against that supplied hash, and appended to the private immutable evidence archive.
- `kr-stage-authority`: independently reads those stored approvals, rechecks plan and live preservation, then separately appends the exact v3 receipt and registry to the owner-private audit. Existing v1/v2 rows remain untouched. It cannot write MODEL sessions.
- `kr-validate`: independently rereads stored approval and staged v3 authority, checks all five predecessors, existing target/prepared conflicts and the full preservation baseline. It calls no writer, including provenance, archive, preparation or authority writers.
- `kr-apply`: repeats VALIDATE, then applies only the approved exact input archive, prepared publication and five MODEL sessions through the existing `ledger_append_model_session` RPC-backed repository. Every write has a fresh preservation gate and exact readback. Uncertain outcomes are read back, never blindly retried. A completed or partial exact prefix is resumable with the same pins.

All commands other than shared `archive-plan` require the exact KR workflow. Official environment credentials remain in the authenticated runner; no credentials are printed, exported to compute, or stored in files. Public diagnostics are fixed statuses and content hashes only. Evidence uses the existing chunk-capable content-addressed private archive, with distinct `kr-nov3-recovery-*` versions. A blocked diagnosis cannot be read as a plan or approval.

## Order and readback

Apply KR first while the 25 captured KOSPI objects remain byte/generation-identical. The separate KOSPI recovery can then take a fresh full-model preservation baseline that includes the completed KR additions. KR never relaxes its legacy-object allowlist to accommodate another operation.

Completion is claimed only after all five exact Nov3 sessions and latest heads read back, every earlier full row remains unchanged, and source generations, actual books, integrated MODEL rows, other series, archived inputs, prepared artifacts, old authorities and legacy object inventory remain within the captured/approved set. New sessions are labeled retrospective, with `historicalAvailabilityClaim: false`; modeled decision clocks are never claims that recovered data was historically available.

## Tests

Run the focused suites serially:

`node_modules/.bin/vitest run scripts/kr-nov3-recovery/core.test.ts scripts/kr-nov3-recovery/apply.test.ts scripts/kr-nov3-recovery/transport.test.ts --maxWorkers=1 --minWorkers=1`

`node_modules/.bin/tsc -p scripts/kr-nov3-recovery/tsconfig.json`

Tests use the real frozen MODEL engine and synthetic private inputs. They cover zero-write VALIDATE, independent authority, exact five-book append, unchanged prefixes, existing conflicts in every book, latest-head drift, altered review/runtime pins, bounded writer escape, uncertain append readback and explicit partial resume, exact workflow separation, canonical source binding and raw evidence corruption.
