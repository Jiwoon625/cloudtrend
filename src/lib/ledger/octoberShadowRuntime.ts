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

export const REVIEWED_SHADOW_RUNTIME_CODE_HASHES = Object.freeze([
  ADOPTED_SHADOW_FROZEN_CODE_HASH,
  "sha256:ffd26d07d50564c6c734dc9c96ede00f7786e1122df3eb373ad56a4648929033",
  PRE_FIRST_SESSION_KOSPI_CONFIRMATION_FIX_RUNTIME_HASH,
  PENDING_MARKET_CAP_FIX_RUNTIME_HASH,
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
