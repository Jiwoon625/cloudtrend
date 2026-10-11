# Replay calculation runtime coverage

The KR replay input slice and scored-versus-execution universe preparation determine calculation inputs. Previously they lived only in `shadowReplay.server.ts`, which was not reachable from the calculation-manifest roots. An upstream filtering change could therefore retain the old reviewed hash.

These two pure functions now live in `shadowReplayCalculation.ts`. The server imports the same functions, and the module is an explicit `SHADOW_ENGINE_ROOTS` entry. This captures dated volatility slicing and missing-close universe policy without importing persistence, authentication, the generated manifest itself or its admission registry into their own hash.

Regression changes either the current-close filter or the dated-volatility boundary in a temporary source copy and requires a different runtime hash. Documentation/format-only changes remain invariant. The existing 79 October Shadow tests passed immediately after extraction, with exact historical five-book golden outputs unchanged before updating runtime provenance.

Generated candidate hashes are not admission approval. Register the final integrated hash only after independent review and full regressions. Keep the original frozen contract identity and existing admitted hashes; never rewrite completed sessions or input archives. No production replay was run for this correction.

Final integrated runtime: `sha256:e1ce0e3d5326c6d57dc2906f4bd42a4a4897ca3eaf2393b998fc09b3b6873869` (44 files). Independent review recomputed the manifest and proved that close-filter, dated-volatility and reference-JSON mutations each change its identity. The final admitted runtime passed all 90 October Shadow and 410 ledger tests.

Canonical upload validation now retains domestic missing-close observations with a warning. The prior strict validator rejected the entire upload; this is not evidence that existing valid source files had silently lost rows. Missing open/volume stay blank and cannot become execution evidence. Original bytes survive upload and reload, and validation-cache keys change with the parser code. Already omitted or compacted historical rows cannot be recovered automatically. No production data migration or replay was performed.
