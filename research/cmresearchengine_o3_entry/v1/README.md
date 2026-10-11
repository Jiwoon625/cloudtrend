# O3: frozen-market ENTRY counts, calendar-month allocation

Status: user approved definition and publication/execution on 2026-10-12 KST. Local implementation only; parent owns final review, remote publication and run submission. This package has not run against the actual private research inputs.

## Approved definition

- Start K/E/U at one third each, KRW100,000,000 total.
- Observe original CM market ENTRY conditions before holdings, cash, pending reservations, portfolio/sector slots, sizing and actual fills. This is not a REF ledger demand count.
- Count first delivery of each engine+symbol+origin_date once. Assign it to its confirmation/session calendar month, including US deliveries whose timestamp falls on the following UTC date. Require availability before the review decision.
- Following-month targets equal each market's count divided by total count, capped separately at60%. Leave excess in central cash. Complete zero-entry month targets cash100%; no forced liquidation of existing positions.
- Consume the complete defined research prefix of the first month, 2017-08-21 onward. Dates before research start are not missing observations. Missing sessions inside an expected window keep the previous target.
- At target0 cancel unfilled BUYs and release their reservations; retain SELLs and existing holdings. Use original monthly settled idle-cash movement, not a holdings rebalance.
- Original period2017-08-21–2026-09-11, fee0.15% each direction, FXspread0, initial fixed K/30 and U/20 sleeve budgets, original ETF prior-close NAV/volatility sizing, known corporate actions and retrospective exit convention remain unchanged.

The original o3_extension/ proposal is untouched. O3 remains separate from representative300; order is D2→O3→split25(70)→split10(100)→fine78. The existing52 completed strategies are not recomputed.

## Signal-source distinctions

Original research O1: independent REF_K/E/U positive executable demand over20 market sessions, then equal weights for active markets. This O3: original frozen models' intrinsic ENTRY count over the previous calendar month, proportionate weights. Current live O1: current live ENTRY definitions and calendar month, but equal weights among active markets; current live capital, budget/year rules, model adoption dates and other contracts differ. O3 is not a reproduction of either O1.

K's actual original execution is mixed: K→KR_MIXED over the full fixed panel, with288 KOSPI and325 KOSDAQ symbols. The old descriptor label KR_KOSPI_CONFIRM1_BEAR does not restrict that executable panel to KOSPI. See SOURCE_BOUNDARY.md and FROZEN_SOURCE_VERIFICATION.json for exact source, input hashes, function boundaries and remote byte comparisons.

Source code is imported from the repository's frozen vendor tree at feb420594935151770a03f9bced171061799b59c. The private evidence ZIP supplies JSON/JSONL contracts and evidence only; ingestion explicitly rejects code. Do not infer the runtime bytes from UPSTREAM_SOURCE_MANIFEST alone. Actual runtime.code_hashes(), input manifest fingerprints and the extension code hashes bind the identity.

The observer preserves original gates: KOSPI confirmed/eligible score+RSAccel+market-gate conditions; KOSDAQ eligible8-point crossing; ETF confirmed80-point crossing plus original readiness, MA60, volatility and liquidity validity; US a0Entry over the unchanged full normalized universe. It consumes the same dated/quote-filtered U panels and all warmup sessions. Complete-source receipts mean consumption of nonempty verified original panels; they do not certify historical PIT completeness. Portfolio-independent data gates stay in the original functions. Execution comparison_close is never added as an ENTRY requirement.

## Work and checkpoint model

A single O3 replay observes signals as its portfolio advances. There is no independent REF run and no full signal preprocessing pass. The existing frozen one-session US memo API shares the one exact US analysis between the observer and executor. It verifies all input rows and the prior market-rank state on reuse. The scope is one close event, clears in finally, and rejects joining an already active external cache. No function is monkeypatched. Tests prove one computation per U session and byte-identical final result ZIP versus cache disabled.

Observer rank/feature state, accumulated deliveries and coverage receipts are encoded in the same exact O3 checkpoint as the portfolio. On retry, the verified checkpoint continues from its last committed event. Completed months and US history are not recomputed; only work after the last successful checkpoint may repeat. Checkpoints remain create-only and code/input/plan bound. A cached in-memory US result is never persisted or reused across identities.

Each submitted segment uses the original run_strategy3000-second compute bound and original600-second/252-snapshot checkpoint cadence. Private input restoration and preflight occur before that compute timer, as in existing research. Actual wall time is unmeasured. It requires one additional O3 historical replay; no promise of completion in one segment is made. Initial progress and checkpoint timestamps should determine an estimate. Repeated Actions attempts still restore the same fixed private inputs, without changing their source or storage.

## Publication and execution paths

Copy the code, contract, tests, request, synthetic_support.py and review documents listed in PUBLICATION_FILES.json to research/cmresearchengine_o3_entry/v1/. Put cmresearchengine-o3-entry-run.yml at .github/workflows/cmresearchengine-o3-entry-run.yml. Do not copy __pycache__ or modify research/cmresearchengine/, the representative300 manifest, existing request files, completed results or old o3_extension/.

The workflow checks out the frozen engine separately from the new extension commit. It uses only existing secrets, contents:read and the existing cmresearchengine-private-research concurrency group with cancel-in-progress:false. A request-file push on main or manual dispatch starts one bounded segment; no schedule/self-dispatch is included. Publication containing the request file can trigger execution, so the parent should publish only after independent review passes.

Existing private cloudtrend-data owner research/cm/ prefix remains unchanged. New objects are scoped to:

- results/plans/{new_plan_sha256}.json
- results/{new_plan_sha256}/O3/{new_identity}/summary.json and completion.json
- existing scoped_checkpoints(new_plan_sha256, O3) create-only journal
- results/reports/o3-entry-extension/{new_plan_sha256}/O3/{new_identity}/{report_sha256}.json

The final audit checks original accounting/fees and independently re-reads the serialized ENTRY, coverage and calendar evidence to reproduce every monthly count and target. Only allowlisted aggregate fields enter private report metadata. No public artifact/cache or raw-result log output.

## Local verification

From the repository root, with the frozen engine tree available as engine/:

    PYTHONPATH=engine/research/cmresearchengine:research/cmresearchengine_o3_entry/v1 python -m unittest discover -s research/cmresearchengine_o3_entry/v1 -p 'test_o3_*.py' -v

56 synthetic tests passed after US memo integration, including portfolio independence,30 US ENTRYs despite20 executable slots, exact original executor parity before first review, original ETF gates, missing sessions, calendar/UTC boundaries, first partial month, cap/cash rules, zero-target orders, before/after-review checkpoint ZIP equivalence, bounded resume and idempotent completion, exact single-call US memo parity, final ENTRY recount and immutable/private metadata protections.

The local synthetic fixture supplies its documented PyArrow stub when PyArrow is absent; the stub rejects Parquet I/O. Thus this is not actual-input preflight or a production dependency-stack test. The workflow installs the exact frozen requirements and reruns the suite. The local checkout HEAD differs from the frozen commit, while13 relevant source files were independently fetched at the frozen commit and byte-compared. Runtime actual execution additionally checks exact checkout HEAD, clean engine path and base plan identity before private I/O.
