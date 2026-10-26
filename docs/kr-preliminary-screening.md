# KR publication-bound screening

The collector can request screening before current-session KRX publication without impersonating a different collection time. Registration accepts `krPublication` (`kr-screening-publication-v1`) containing `phase`, `requestId`, exact UTF-8 `manifestText` and its `sha256:` digest. The request must match the completed collector run, latest observed session and explicit official-provider publication evidence. The server derives file/data/schema hash bindings before activation; caller-supplied supersession claims are discarded.

## PRELIMINARY

- Verified source bytes produce a normal screening result, analysis-run archive, screening cache and dashboard cache. The result and UI explicitly identify PRELIMINARY and held fields.
- No canonical screening history, October KR/ETF Shadow replay, integrated allocation replay, standalone KOSPI publication, portfolio valuation refresh, strategy refresh or FINAL completion receipt is written.
- The same durable source contract applies to CLI, web rebuild/cache paths and portfolio page loads. Retry or a later clock does not convert it to FINAL. Authoritative user-entered execution corrections remain available.
- Pending raw-source markers without a valid declaration fail closed. Source hashes, manifest digest and actual latest source date remain validated; no arbitrary callback/URL or phase flag bypass exists.

## Exact follow-up

A FINAL source requires exact official current-date capitalization in the actual input, plus explicit exact official publication evidence. Ordinary merge registration can derive `supersedesPending` only when the incoming canonical rows cover every prior source key and repair every affected stock/ETF row at the original pending date. A later multi-day FINAL may repair an older pending date, but merely having a newer maximum date is not sufficient. Each server-derived proof binds the earlier source ID, file/data/schema hashes and original pending date, which must not exceed the incoming FINAL date. An unmarked newer source, missing old-date rows, estimated capitalization, incomplete coverage or caller-supplied proof cannot clear pending historical data. A newer PRELIMINARY continues to hold financial effects, including historical replay, until official evidence is complete. The prior source and preliminary archive remain auditable; no preliminary journal is promoted or rewritten.

Legacy FINAL sources without this new contract retain their prior behavior. Optional standalone source compaction defers phase-bound generations and retains their originals; this does not block upload or screening. Phase-preserving compaction is a separate follow-up, not silently lossy migration.

## Ingestion compatibility

Public CLI registration accepts `--kr-publication <request.json>`; authenticated GPT upload finalization accepts the same optional `krPublication` object. Both forward only request fields to the existing hash/evidence-validated registrar. Source hashes, supersession proofs and callback URLs cannot be supplied through this object. The publication verifier shares the existing source header/date normalization, including JSON, compact dates and supported Korean aliases; unknown or mismatched dates still fail closed.

Before a PRELIMINARY cache replaces the latest view, a digest-verified prior FINAL ETF projection is retained in `cache/screening/confirmed-etf-context.json`. Portfolio reads use those confirmed marks without updating ledgers. Repeated previews cannot overwrite that projection; missing verified prior marks are explicitly labeled unavailable rather than presented as a new valuation.

## Multi-day recovery boundary

A collected range and a completed sequence of model dates are different outcomes. Final Korean inputs are replayed chronologically by `replayKrShadow`; a missing predecessor or unready date is reported rather than skipped. An unresolved latest PRELIMINARY still holds all financial effects, including replay of otherwise complete older dates. Actual trades are never synthesized from these historical signals.

For US inputs, fetching several days of adjusted prices does not recreate the dated roster, eligibility, sector, shares, or lifecycle evidence used for the original screening. The collector must distinguish a verified current-day archive from a complete historical archive chain. An absent or invalid dated input remains `WAITING_INPUT`; current metadata is not relabeled as historical evidence. A dispatch receipt is not server or Shadow completion.

The private collector's ordinary five-trading-day single-file recovery is distinct from generalized multi-part phase-aware ingestion. Oversized phase-bound split output remains explicitly blocked before registration until that separate atomicity contract is implemented.
