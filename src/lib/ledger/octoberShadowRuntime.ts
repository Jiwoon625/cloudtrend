export const ADOPTED_SHADOW_FROZEN_CODE_HASH =
  "sha256:ca565a5ec7bff10815a4943989ae3b02fd52fd508bbd283ae5c4d23eb79607c6" as const;
/**
 * The 2026-10-07 KOSPI confirmation-threshold correction was reviewed before
 * KR_KOSPI_CONFIRM1_BEAR had any persisted model session. Its runtime hash is
 * therefore admitted as the intended first-record implementation while the
 * already-registered eight-series contract identity remains unchanged.
 */
export const PRE_FIRST_SESSION_KOSPI_CONFIRMATION_FIX_RUNTIME_HASH =
  "sha256:23f73782cb5646002b80b78c027168bb238ec338da87bd247ef1686794c5aa84" as const;

/**
 * Prospective missing-input correction reviewed after the first KR/ETF session.
 * New explicit pending metadata blocks entry only; legacy archived snapshots keep
 * their existing replay semantics, scores and held exits. A clean-main synthetic
 * frozen prefix + next-session continuation is compared byte-for-byte in tests.
 * Frozen contract identity and completed-session artifacts are never rewritten.
 */
export const PENDING_MARKET_CAP_FIX_RUNTIME_HASH =
  "sha256:76e7f82b84ea9fb536cc46cda7d1720c23d63ab5a5184932fd6cf13bbf108d5e" as const;

/** A0 operating-only cost cutover; frozen MODEL calls retain their original execution policy. */
export const A0_OPERATING_COST_ALIGNMENT_RUNTIME_HASH =
  "sha256:e478d2119fe41745dc6e563aed6ee99c0701650d74d53f736b498d3d120daf81" as const;

/** Owner-approved October 12 restart: exact money, normalized prices and liquidity policy.
 * Legacy contract hashes and frozen-prefix continuation remain regression-verified.
 * New execution differences are explicit in the separate restart contract.
 */
export const OCTOBER12_CONSISTENCY_RUNTIME_HASH =
  "sha256:a33c617762d7eefcc55f958a78195bbecec8f264ba670378ec21e04e3bc37f6e" as const;

/** October 9 re-audit: restart continuity, frozen US priority, carried-entry cancellation and H60 retry.
 * Restart-specific branches preserve legacy beta calculations and immutable contract identity.
 */
export const OCTOBER12_REAUDIT_RUNTIME_HASH =
  "sha256:afdb29eb9f475d48658213344fd2d2132245d86ed562a98bf05ae538f38e01f5" as const;

/** Shared UI/engine candidate comparator; existing engine ordering is unchanged. */
export const US_PRIORITY_SHARED_COMPARATOR_RUNTIME_HASH =
  "sha256:db15b9e31a6268cb62d6154eb43c25d12ee0908658dcb2485038648ac6bd4e28" as const;

/** Re-audit metadata: observed-row holding days and distinct signal/execution rank provenance. */
export const REAUDIT_OBSERVATION_METADATA_RUNTIME_HASH =
  "sha256:9a6d89057e7d47667e4e89e127cd64f1a9a9f915dcf4ea43e8b686c3a6480cbe" as const;

/** Naming-only correction: the shared signal policy predicate is not a React Hook. */
export const REAUDIT_SIGNAL_POLICY_NAMING_RUNTIME_HASH =
  "sha256:b6305169cdd429bc314a6e33626718cf0108f97a89be58200d01efba475a4f7b" as const;

/** Reviewed October 11 boundary fixes: exact US preview arithmetic and common KR
 * missing-close observations/valuation. Beta US/KR replay outputs match the clean
 * prior runtime; frozen contract identities and completed artifacts stay unchanged.
 */
export const EXACT_PREVIEW_MISSING_CLOSE_RUNTIME_HASH =
  "sha256:5360df78a2d4f27de2ec0c1cb467baabc63603747b53bf4934d2a91d7b44afd5" as const;

/** Repository-wide lint cleanup: redundant arithmetic grouping and quote-regex
 * escapes only. Executable-tree equivalence and direct quote-normalization tests
 * preserve results. Frozen contracts and all previously reviewed runtimes remain.
 */
export const LINT_EQUIVALENT_SYNTAX_RUNTIME_HASH =
  "sha256:3ebfcb975969aaaff05b358bb6a1d0e9c14e20cb474c10391dcc633dedb264b2" as const;

/** Reviewed restart replay observation transport fix. Current execution observations
 * survive independently of score availability; beta and complete-input replay
 * semantics are golden-verified. Frozen contracts and completed artifacts remain.
 */
export const REPLAY_OBSERVATION_PRESERVATION_RUNTIME_HASH =
  "sha256:269e327dbf3750a7c91933be6e312adae9e19bb5bd6e3d11ba3b931f4879b201" as const;

/** Reviewed canonical observation preservation and dated official membership inputs.
 * Replay calculation helpers and reference JSON are now inside the runtime digest.
 * Existing supplied-input frozen goldens remain exact; newly parsed membership can
 * correct priority/order. Completed histories and contract identities are preserved.
 */
export const VERIFIED_INPUT_PROVENANCE_RUNTIME_HASH =
  "sha256:e1ce0e3d5326c6d57dc2906f4bd42a4a4897ca3eaf2393b998fc09b3b6873869" as const;

/** Missing-close observations retain supplied high/low without mixing unknown
 * sentinels into price ranges. Complete-input goldens and execution/NAV are
 * unchanged; newly built observation archives correctly retain original fields.
 */
export const MISSING_CLOSE_OHLC_PRESERVATION_RUNTIME_HASH =
  "sha256:6d17bcaf79a6d0f224fce32030a6daf7e2e6a8bbaf4041fe8f90b8f817bcc424" as const;

/** Reviewed exact source-vintage separation. Private approval binds whole-bar pairs;
 * frozen execution observations stay immutable, prior economic exposure rejects,
 * and cumulative receipts reject vendor reversion. No automatic normalization.
 */
export const REVIEWED_SOURCE_VINTAGE_RUNTIME_HASH =
  "sha256:cee9c24263a8e1e0ad96975ea9a08c806fea45759a3d8a10072f7e55ec41fa08" as const;

/** Prospective K4/E4 amendment from 2026-10-15; pre-cutover observations and experimental books retain their contract. */
export const PRICE_EXIT_ADDITION_RUNTIME_HASH =
  "sha256:080cb9b033c4c7b6c5d00d02b5e0ef9170f27378e9ccb4f72cf5b84c4a878083" as const;

/** Reviewed append-only private vintage successor; old authority and economic prefixes remain exact. */
export const REVIEWED_SOURCE_VINTAGE_SUCCESSOR_RUNTIME_HASH =
  "sha256:29815e7486243724746c6433aa3ccfdceb4f8667b42dd462f923583a126f7511" as const;

/** Exact reviewed late-source MODEL authority; ordinary availability and immutable prefixes remain unchanged. */
export const REVIEWED_RETROSPECTIVE_SOURCE_RUNTIME_HASH =
  "sha256:9738f045962175e20e34f1ffae330fd36abe1491356fd63957dababd5e15de97" as const;

export const REVIEWED_SHADOW_RUNTIME_CODE_HASHES = Object.freeze([
  REVIEWED_RETROSPECTIVE_SOURCE_RUNTIME_HASH,
  REVIEWED_SOURCE_VINTAGE_SUCCESSOR_RUNTIME_HASH,
  PRICE_EXIT_ADDITION_RUNTIME_HASH,
  ADOPTED_SHADOW_FROZEN_CODE_HASH,
  REVIEWED_SOURCE_VINTAGE_RUNTIME_HASH,
  "sha256:ffd26d07d50564c6c734dc9c96ede00f7786e1122df3eb373ad56a4648929033",
  PRE_FIRST_SESSION_KOSPI_CONFIRMATION_FIX_RUNTIME_HASH,
  PENDING_MARKET_CAP_FIX_RUNTIME_HASH,
  A0_OPERATING_COST_ALIGNMENT_RUNTIME_HASH,
  OCTOBER12_CONSISTENCY_RUNTIME_HASH,
  OCTOBER12_REAUDIT_RUNTIME_HASH,
  US_PRIORITY_SHARED_COMPARATOR_RUNTIME_HASH,
  REAUDIT_OBSERVATION_METADATA_RUNTIME_HASH,
  REAUDIT_SIGNAL_POLICY_NAMING_RUNTIME_HASH,
  EXACT_PREVIEW_MISSING_CLOSE_RUNTIME_HASH,
  LINT_EQUIVALENT_SYNTAX_RUNTIME_HASH,
  REPLAY_OBSERVATION_PRESERVATION_RUNTIME_HASH,
  VERIFIED_INPUT_PROVENANCE_RUNTIME_HASH,
  MISSING_CLOSE_OHLC_PRESERVATION_RUNTIME_HASH,
  "sha256:7986793771f362aaede80425f9259254035443dce0eb67e134ded9271241354d",
  "sha256:a321c97e37a3b55249b23597e811997b089943d8c56cb27088c60a2806691a80",
] as const);

/**
 * The eight already-frozen MODEL contracts keep their original calculation identity.
 * Reviewed runtime changes may have a different transitive runtime hash, which is recorded
 * separately on each publication. Every admitted calculation change needs an explicit review
 * preserving frozen contracts and completed session results. Unknown runtime hashes fail closed.
 */
export function adoptedShadowFrozenCodeHash(runtimeCodeHash: string) {
  if (
    !REVIEWED_SHADOW_RUNTIME_CODE_HASHES.includes(
      runtimeCodeHash as (typeof REVIEWED_SHADOW_RUNTIME_CODE_HASHES)[number],
    )
  )
    throw new Error(
      `Unreviewed October Shadow runtime hash: ${runtimeCodeHash}; frozen contracts cannot advance`,
    );
  return ADOPTED_SHADOW_FROZEN_CODE_HASH;
}

/** Publication admission is independent from a caller-provided frozen registry identity. */
export function assertAdoptedShadowRuntime(runtimeCodeHash: string, frozenCodeHash: string) {
  const reviewedFrozenCodeHash = adoptedShadowFrozenCodeHash(runtimeCodeHash);
  if (frozenCodeHash !== reviewedFrozenCodeHash)
    throw new Error("Frozen October Shadow registry code hash does not match reviewed runtime");
  return reviewedFrozenCodeHash;
}
