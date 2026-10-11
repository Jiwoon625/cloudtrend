# Replay calculation runtime coverage

The KR replay input slice and scored-versus-execution universe preparation determine calculation inputs. Previously they lived only in `shadowReplay.server.ts`, which was not reachable from the calculation-manifest roots. An upstream filtering change could therefore retain the old reviewed hash.

These two pure functions now live in `shadowReplayCalculation.ts`. The server imports the same functions, and the module is an explicit `SHADOW_ENGINE_ROOTS` entry. This captures dated volatility slicing and missing-close universe policy without importing persistence, authentication, the generated manifest itself or its admission registry into their own hash.

Regression changes either the current-close filter or the dated-volatility boundary in a temporary source copy and requires a different runtime hash. Documentation/format-only changes remain invariant. The existing 79 October Shadow tests passed immediately after extraction, with exact historical five-book golden outputs unchanged before updating runtime provenance.

Generated candidate hashes are not admission approval. Register the final integrated hash only after independent review and full regressions. Keep the original frozen contract identity and existing admitted hashes; never rewrite completed sessions or input archives. No production replay was run for this correction.

Final integrated runtime: `sha256:e1ce0e3d5326c6d57dc2906f4bd42a4a4897ca3eaf2393b998fc09b3b6873869` (44 files). Independent review recomputed the manifest and proved that close-filter, dated-volatility and reference-JSON mutations each change its identity. The final admitted runtime passed all 90 October Shadow and 410 ledger tests.

Canonical upload validation now retains domestic missing-close observations with a warning. The prior strict validator rejected the entire upload; this is not evidence that existing valid source files had silently lost rows. Missing open/volume stay blank and cannot become execution evidence. Original bytes survive upload and reload, and validation-cache keys change with the parser code. Already omitted or compacted historical rows cannot be recovered automatically. No production data migration or replay was performed.

## Missing-close OHLC preservation follow-up

PR255 review found that the parser retained a missing close as zero but included it in `Math.min`, replacing a supplied low with zero. The missing-close branch now keeps supplied/prior high and low unchanged and leaves absent range fields at the existing unknown-zero representation. Positive-close normalization, execution open/volume, observation flags and NAV rules stay unchanged.

The upload fixture no longer overwrites low values before checking them. Full field comparisons cover original bytes, canonical validation, original-source reload, real compaction, replay slicing, daily input archive and JSON serialization. Partial open/high/low, blank and zero close, zero prices, duplicate enrichment and absent volume are covered. A direct before/after case has identical trades, cash and MISSING NAV; only its corrected observed low and archive hash differ. Existing completed archives are not migrated or rewritten.

Independently reviewed runtime: `sha256:6d17bcaf79a6d0f224fce32030a6daf7e2e6a8bbaf4041fe8f90b8f817bcc424` (44 sources). Exact manifest recomputation and 244 parser/source/replay tests passed in an isolated copy with temporary admission, including all 35 replay tests and unchanged positive-close beta/restart goldens. The previous e1ce runtime remains admitted alongside every prior reviewed hash and the unchanged frozen identity.
