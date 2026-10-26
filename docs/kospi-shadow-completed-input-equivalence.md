# KOSPI completed-input equivalence (read-only)

## Problem and boundary

The prospective KOSPI journal records the full registered KR source-set hash. An
ETF-only enrichment or re-registration can change that provenance without changing
this model's inputs. Do not weaken the journal's immutable-source guard globally,
filter raw data to only KOSPI rows, or replace old provenance with a new hash:
KOSDAQ and sector/market context can affect derived KOSPI scores and priorities.

This change adds a narrowly scoped, **zero-write no-op** for an already completed
latest ordinary prospective session. It does not introduce a new economic policy,
migrate any journal, or change the actual ledger or adopted model books.

## Equivalence proof

1. Read the authoritative dated snapshot, registry, current projection, and (unless
   this is the proven initialization date) the authoritative predecessor. Existing
   revision-chain validation remains in force. The projection must match its
   authoritative snapshot; it is never used as historical input evidence.
2. Require the same date, schema, full frozen policy, config hash **and config
   content**, initialization identity, predecessor date and session count.
3. Compare every materialized input: full source payload and all original rows
   retained in `state.previousRows`. Required fields must exist; missing evidence
   cannot be default-filled. Only `sourceHash`, `codeVersion`, and
   `sourceCollectedAt` are excluded from the comparison. Gate evidence, benchmark,
   calendar, names, sectors, nullable values, flags, and unknown additive fields
   remain binding. The one previously supported display-only policy field,
   `researchReference`, may be omitted from the policy comparison only if it is a
   string; the original value remains untouched. All economic policy fields and
   every other unknown policy field remain binding.
4. Independently re-step the incoming session with its own honest provenance from
   the immutable predecessor. Compare the **entire** resulting snapshot with the
   original, excluding only those same three source provenance fields on both
   sides. This includes state, daily values, candidates, trades and array ordering.
   In particular, symbol-keyed rows cannot prove original row-array order; the full
   replay must prove that order effects have not changed any output.
5. Return the original view without a single `putImmutable` or `putLatest`. Its
   original code/source provenance remains unchanged. Logs distinguish
   `VERIFIED_EQUIVALENT_INPUT` from `EXACT_SOURCE`, with recorded and observed
   provenance separately reported.

Changed KOSPI economics, shared-context effects, config/policy changes, malformed or
missing evidence, unexpected metadata, or replay disagreement fail closed. This is
not proof that all raw source bytes are equal, nor a full-history independent
recalculation. It is a proof of complete effective-input and one-step output
identity against the immutable predecessor for this completed session.

## Timing and recovery

An after-open duplicate may attempt the same proof through
`reuseCompletedKospiShadow`, a completed-only API whose two write methods always
throw. An uncompleted date still follows the existing strict late-recovery path;
a conflicting completed date fails rather than falling through to recovery.

Snapshots carrying `lateRecovery` metadata do not enter the new ordinary-input
exception. Their existing full-source freeze and dedicated recovery-evidence
validation remain unchanged, including idempotent retries with a later computation
clock. Interrupted initialization and projection repair also retain the original
source-hash contract; this exception cannot repair or overwrite them.

## Bounded operational verification

The `KOSPI prospective Shadow` manual workflow now accepts:

- `verify_completed: true`
- one explicit `as_of` date
- no correction initialization or recovery mode

Equivalent CLI: `--verify-completed --as-of YYYY-MM-DD`.

This mode uses existing configured credentials, verifies runtime admission before
private reads, and emits `COMPLETED_INPUT_VERIFIED` only after the proof. Both
Storage writers explicitly reject calls. It cannot initialize or advance a date,
repair a projection, call late recovery, or write an actual ledger. A missing or
changed completion is a failure, not a request to publish. The current input must
still be an exact-date source snapshot; the mode does not pretend today's inputs
are an older historical snapshot.

## Verification

Tests cover ETF-underlying-only changes, real full-market KOSDAQ-to-KOSPI
calculation dependencies, prices/scores/priority/flags, gate/calendar/benchmark,
missing or extra symbols, numeric-key row-order ambiguity, full policy/config,
unknown/missing fields, malformed predecessors, correction revision immutability,
late-recovery retries, dynamic after-open runner routing, and strict verify-only
argument and no-write behavior. Operational private data is not included in tests.

The runtime admission is explicit and exact-hash reviewed; generating a new
manifest never self-admits executable code. No operational dispatch is implied by
this document or by passing local tests.
