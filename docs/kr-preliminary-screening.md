# KR publication-bound screening

The collector can request screening before current-session KRX publication without impersonating a different collection time. Registration accepts `krPublication` (`kr-screening-publication-v1`) containing `phase`, `requestId`, exact UTF-8 `manifestText` and its `sha256:` digest. The request must match the completed collector run, latest observed session and explicit official-provider publication evidence. The server derives file/data/schema hash bindings before activation; caller-supplied supersession claims are discarded.

## PRELIMINARY

- Verified source bytes produce a normal screening result, analysis-run archive, screening cache and dashboard cache. The result and UI explicitly identify PRELIMINARY and held fields.
- No canonical screening history, October KR/ETF Shadow replay, integrated allocation replay, standalone KOSPI publication, portfolio valuation refresh, strategy refresh or FINAL completion receipt is written.
- The same durable source contract applies to CLI, web rebuild/cache paths and portfolio page loads. Retry or a later clock does not convert it to FINAL. Authoritative user-entered execution corrections remain available.
- Pending raw-source markers without a valid declaration fail closed. Source hashes, manifest digest and actual latest source date remain validated; no arbitrary callback/URL or phase flag bypass exists.

## Exact follow-up

A FINAL source requires exact official current-date capitalization in the actual input, plus explicit exact official publication evidence. Ordinary merge registration can derive `supersedesPending` only when the incoming canonical rows cover every prior source key and repair every affected same-date stock/ETF row. Each proof binds the earlier source ID, file/data/schema hashes and date. Another date, an unmarked newer source, incomplete coverage or caller-supplied proof cannot clear pending historical data. The prior source and preliminary archive remain auditable; no preliminary journal is promoted or rewritten.

Legacy FINAL sources without this new contract retain their prior behavior. Optional standalone source compaction defers phase-bound generations and retains their originals; this does not block upload or screening. Phase-preserving compaction is a separate follow-up, not silently lossy migration.
