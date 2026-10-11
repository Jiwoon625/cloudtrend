# Comprehensive audit follow-up corrections

Baseline audit: fecea1ff. First cleanup/replay batch: PR253, production b6426c.

## Current second batch

- Source precedence remains activation time, creation time, then source ID. All query paths use the same final tie-break. Input fingerprints preserve the actual calculation order and creation timestamp rather than sorting away precedence. This intentionally invalidates prior representative caches; immutable historical runs are not rewritten.
- Korean quality checks use the actual Asia/Seoul check date separately from the file's as-of date. A late upload of past observations is not future data. Quality-cache keys include this local date so midnight cannot retain yesterday's warning.
- Current-date market-cap and investor-flow coverage counts actual finite fields, including valid zero flows. Partial input is shown as partial, with current valid entities / total entities.
- Replay's legacy volatility array is rebuilt only from dated observations no later than the replay date. Undated-only values do not acquire invented chronology. Existing strict provenance diagnostics remain. Stored archives are unchanged; correcting a newly computed previously future-contaminated slice may change its hash.
- KR/US screeners restore owner-scoped search/filter/sort/page, including mode and account transitions. Sector summaries select actual inflow/outflow status sets, provide keyboard buttons and empty-state guidance, and accept dashboard sector deep links.
- Technical completeness and missing-input summary text explicitly describe their scope. Technical-score filter input is bounded to 0–10.
- Historical test expectations are separated from current V8 contracts; see engine-contract-regressions-20261011.md.

## Explicitly held separately

Index-membership correction is not included in this batch. A historical user-supplied KOSPI200 universe snapshot has been located in Git; its effective date and exact membership authority remain under investigation. No current constituent list is being retroactively applied to historical calculations. The old parser assumption remains pending that decision.

## Calendar maintenance boundary

The verified calendar intentionally ends 2026-12-31. KR 2026-11-19 special-session hours remain pending official confirmation and fail closed; the Shadow screen already discloses this. No guessed hours or 2027 Korean holidays were added.

Read-only checks on 2026-10-11: NYSE's official calendar confirms the stored 2026 Q4 US holidays/early closes and publishes later years (https://www.nyse.com/trade/hours-calendars). The available KRX general page is not a dated CSAT special-session notice. A new reviewed exchange notice is required to remove that pending boundary. This is an outstanding evidence dependency, not a repaired runtime defect.

All tests use synthetic inputs or in-memory stores. No production replay, raw-data modification, research rerun, CM input change, or frozen-contract rewrite is part of this batch.
