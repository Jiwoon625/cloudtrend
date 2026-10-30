import type { MarketDataset } from "../../src/lib/engine/dataset";
import type { ScoringConfig } from "../../src/lib/engine/scoring";
import type { FrozenModelSeries, SeriesHash } from "../../src/lib/ledger/modelSeries";
import type { OctoberRun } from "../../src/lib/ledger/octoberShadowPipeline";
import type { KrDailyInputArchive } from "../../src/lib/ledger/octoberShadowArchive";
import type { KrSourceVintagePrivateApproval } from "../../src/lib/ledger/krSourceVintage";

/** Private capture. Transport must bind every raw byte to its current registered hash and generation. */
export interface FinalCaptureV1 {
  version: "kr-final-retrospective-capture-v1";
  owner: string;
  codeCommit: string;
  runtimeHashes: { october: SeriesHash; kospi: SeriesHash };
  capturedAt: string;
  computedAt: string;
  sourceManifest: unknown;
  captureManifest: unknown;
  preservationBaseline: unknown;
  finalPublication: { hash: SeriesHash; activatedAt: string; asOfDate: string };
  dataset: MarketDataset;
  config: ScoringConfig;
  sourceVintageApproval: KrSourceVintagePrivateApproval;
  predecessors: Array<{ series: FrozenModelSeries; run: OctoberRun; payloadHash: SeriesHash }>;
  archives: Array<{ hash: SeriesHash; payload: KrDailyInputArchive }>;
  legacyObjects: Record<string, { hash: SeriesHash; payload: unknown }>;
}

/** Lossless storage representation; analytical bars reference unchanged observed bars. */
export interface EncodedCaptureDataset {
  version: "kr-final-retrospective-bars-index-v1";
  dataset: Omit<MarketDataset, "bars">;
  barIndices: Record<string, number[]>;
  datasetHash: SeriesHash;
}
export interface FinalCaptureV2 extends Omit<FinalCaptureV1, "version" | "dataset"> {
  version: "kr-final-retrospective-capture-v2";
  dataset: EncodedCaptureDataset;
  decodedCaptureHash: SeriesHash;
}
export type FinalCapture = FinalCaptureV1 | FinalCaptureV2;

/** Public-safe compute protocol: fixed literals only, never arbitrary exception text. */
export const FINAL_COMPUTE_STAGES = [
  "CAPTURE_READ",
  "HYDRATE",
  "IDENTITY",
  "SOURCE_AUTHORITY",
  "CAPTURE_HASHES",
  "ANALYZE_28",
  "ANALYZE_29",
  "SNAPSHOTS",
  "DATE_PROOFS",
  "RETROSPECTIVE_AUTHORITY",
  "ARCHIVE_VERIFY",
  "PREDECESSOR_MEMORY",
  "PRIOR_ANALYSIS",
  "ADOPTED_28",
  "ADOPTED_29",
  "PREFIX_CHECK",
  "LEGACY_CAPTURE",
  "LEGACY_PREPARE",
  "LEGACY_BOUNDARY",
  "PLAN_ASSEMBLE",
  "PLAN_WRITE",
  "DONE",
  "KOSPI_AUTHORITY_SCOPE",
  "KOSPI_CONSECUTIVE_DATES",
  "KOSPI_PROVENANCE_HASHES",
  "KOSPI_ACTUAL_CLOCKS",
  "KOSPI_DATASET_HORIZON",
  "KOSPI_OBJECT_IDENTITIES",
  "KOSPI_PREDECESSOR_VIEW",
  "KOSPI_ORIGINAL_CHAIN",
  "KOSPI_REVISION_CHAIN",
  "KOSPI_EXACT_OBJECT_INVENTORY",
  "KOSPI_REVISION_ANCHOR_VALIDATION",
  "KOSPI_FROZEN_CONFIG",
  "KOSPI_BASELINE_SESSION_BUILD",
  "KOSPI_ADJUSTED_SESSION_BUILD",
  "KOSPI_SESSION_COMPARISON",
  "KOSPI_COMPLETED_BASELINE_BOUNDARY",
  "KOSPI_COMPLETED_ADJUSTED_BOUNDARY",
  "KOSPI_BOUNDARY_DIAGNOSTIC",
  "KOSPI_PREDECESSOR_EQUIVALENCE",
  "KOSPI_MEMORY_SESSION_APPEND",
  "KOSPI_FINAL_REVISION_VALIDATION",
  "KOSPI_IMMUTABLE_PREFIX",
  "KOSPI_EXACT_MEMORY_WRITE_SET",
  "KOSPI_PLAN_HASHES",
  "MODEL_READ_0",
  "MODEL_READ_1",
  "MODEL_READ_2",
  "MODEL_READ_3",
  "MODEL_READ_4",
  "MODEL_APPEND_0",
  "MODEL_APPEND_1",
  "MODEL_APPEND_2",
  "MODEL_APPEND_3",
  "MODEL_APPEND_4",
] as const;
export type FinalComputeStage = (typeof FINAL_COMPUTE_STAGES)[number];
export const FINAL_COMPUTE_CATEGORIES = [
  "GUARD",
  "FROZEN_LEGACY",
  "RANGE_ERROR",
  "SYNTAX_ERROR",
  "TYPE_ERROR",
  "FILE_IO",
  "UNKNOWN",
] as const;
export type FinalComputeCategory = (typeof FINAL_COMPUTE_CATEGORIES)[number];
const FINAL_COMPUTE_ERRORS = {
  "Invalid actual preparation timestamp": {
    category: "FROZEN_LEGACY",
    code: "INVALID_ACTUAL_PREPARATION_TIMESTAMP",
  },
  "Preparation immutable collision": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_IMMUTABLE_COLLISION",
  },
  "Invalid preparation journal chain": {
    category: "FROZEN_LEGACY",
    code: "INVALID_PREPARATION_JOURNAL_CHAIN",
  },
  "Missing preparation journal snapshot": {
    category: "FROZEN_LEGACY",
    code: "MISSING_PREPARATION_JOURNAL_SNAPSHOT",
  },
  "Invalid preparation predecessor chain": {
    category: "FROZEN_LEGACY",
    code: "INVALID_PREPARATION_PREDECESSOR_CHAIN",
  },
  "Invalid bounded preparation authority": {
    category: "FROZEN_LEGACY",
    code: "INVALID_BOUNDED_PREPARATION_AUTHORITY",
  },
  "Exact next-session preparation dates required": {
    category: "FROZEN_LEGACY",
    code: "EXACT_NEXT_SESSION_PREPARATION_DATES_REQUIRED",
  },
  "Preparation provenance hashes required": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_PROVENANCE_HASHES_REQUIRED",
  },
  "Actual final-source and capture clocks required": {
    category: "FROZEN_LEGACY",
    code: "ACTUAL_FINAL_SOURCE_AND_CAPTURE_CLOCKS_REQUIRED",
  },
  "Exact approved final analytical horizon required": {
    category: "FROZEN_LEGACY",
    code: "EXACT_APPROVED_FINAL_ANALYTICAL_HORIZON_REQUIRED",
  },
  "Preparation private object identity mismatch": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_PRIVATE_OBJECT_IDENTITY_MISMATCH",
  },
  "Preparation requires exact unadvanced authoritative predecessor": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_REQUIRES_EXACT_UNADVANCED_AUTHORITATIVE_PREDECESSOR",
  },
  "Preparation object inventory contains missing or orphan snapshots": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_OBJECT_INVENTORY_CONTAINS_MISSING_OR_ORPHAN_SNAPSHOTS",
  },
  "Frozen KOSPI policy/config differs": {
    category: "FROZEN_LEGACY",
    code: "FROZEN_KOSPI_POLICY_CONFIG_DIFFERS",
  },
  "Preparation completed boundary differs from captured session": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_COMPLETED_BOUNDARY_DIFFERS_FROM_CAPTURED_SESSION",
  },
  "Preparation mutated proved target inputs": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_MUTATED_PROVED_TARGET_INPUTS",
  },
  "Preparation outputs differ from original-start continuation proof": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_OUTPUTS_DIFFER_FROM_ORIGINAL_START_CONTINUATION_PROOF",
  },
  "Preparation final projection mismatch": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_FINAL_PROJECTION_MISMATCH",
  },
  "Preparation mutated immutable original prefix": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_MUTATED_IMMUTABLE_ORIGINAL_PREFIX",
  },
  "Preparation write-set escape": {
    category: "FROZEN_LEGACY",
    code: "PREPARATION_WRITE_SET_ESCAPE",
  },
  "Invalid private Shadow object path": {
    category: "FROZEN_LEGACY",
    code: "INVALID_PRIVATE_SHADOW_OBJECT_PATH",
  },
  "Shadow registry/projection mismatch; do not reconstruct or reset capital": {
    category: "FROZEN_LEGACY",
    code: "SHADOW_REGISTRY_PROJECTION_MISMATCH_DO_NOT_RECONSTRUCT_OR_RESET_CAPITAL",
  },
  "Shadow registry is frozen; rule/config mismatch": {
    category: "FROZEN_LEGACY",
    code: "SHADOW_REGISTRY_IS_FROZEN_RULE_CONFIG_MISMATCH",
  },
  "Past Shadow date cannot replace latest": {
    category: "FROZEN_LEGACY",
    code: "PAST_SHADOW_DATE_CANNOT_REPLACE_LATEST",
  },
  "Incomplete initial Shadow snapshot; retry the initialization date first": {
    category: "FROZEN_LEGACY",
    code: "INCOMPLETE_INITIAL_SHADOW_SNAPSHOT_RETRY_THE_INITIALIZATION_DATE_FIRST",
  },
  "Completed Shadow date is immutable (input/config mismatch)": {
    category: "FROZEN_LEGACY",
    code: "COMPLETED_SHADOW_DATE_IS_IMMUTABLE_INPUT_CONFIG_MISMATCH",
  },
  "Completed Shadow snapshot is missing": {
    category: "FROZEN_LEGACY",
    code: "COMPLETED_SHADOW_SNAPSHOT_IS_MISSING",
  },
  "Shadow replay predecessor mismatch": {
    category: "FROZEN_LEGACY",
    code: "SHADOW_REPLAY_PREDECESSOR_MISMATCH",
  },
  "Completed Shadow reuse must not write any object": {
    category: "FROZEN_LEGACY",
    code: "COMPLETED_SHADOW_REUSE_MUST_NOT_WRITE_ANY_OBJECT",
  },
  "Invalid reviewed retrospective source authority": {
    category: "GUARD",
    code: "INVALID_REVIEWED_RETROSPECTIVE_SOURCE_AUTHORITY",
  },
  "Invalid private KR source vintage review": {
    category: "GUARD",
    code: "INVALID_PRIVATE_KR_SOURCE_VINTAGE_REVIEW",
  },
  "Private KR source vintage scope changed": {
    category: "GUARD",
    code: "PRIVATE_KR_SOURCE_VINTAGE_SCOPE_CHANGED",
  },
  "Unapproved private KR source vintage receipt": {
    category: "GUARD",
    code: "UNAPPROVED_PRIVATE_KR_SOURCE_VINTAGE_RECEIPT",
  },
  "Unapproved private KR source vintage successor": {
    category: "GUARD",
    code: "UNAPPROVED_PRIVATE_KR_SOURCE_VINTAGE_SUCCESSOR",
  },
  "Private KR source vintage predecessor changed or missing": {
    category: "GUARD",
    code: "PRIVATE_KR_SOURCE_VINTAGE_PREDECESSOR_CHANGED_OR_MISSING",
  },
  "Private KR source vintage successor scope changed": {
    category: "GUARD",
    code: "PRIVATE_KR_SOURCE_VINTAGE_SUCCESSOR_SCOPE_CHANGED",
  },
  "Unreviewed retained KR source vintage receipt": {
    category: "GUARD",
    code: "UNREVIEWED_RETAINED_KR_SOURCE_VINTAGE_RECEIPT",
  },
  "Only a complete same-session regular close can enter the October journal": {
    category: "GUARD",
    code: "ONLY_A_COMPLETE_SAME_SESSION_REGULAR_CLOSE_CAN_ENTER_THE_OCTOBER_JOURNAL",
  },
  "Duplicate symbols in a completed publication": {
    category: "GUARD",
    code: "DUPLICATE_SYMBOLS_IN_A_COMPLETED_PUBLICATION",
  },
  "US source calendar or row dates do not match the verified session sequence": {
    category: "GUARD",
    code: "US_SOURCE_CALENDAR_OR_ROW_DATES_DO_NOT_MATCH_THE_VERIFIED_SESSION_SEQUENCE",
  },
  "KR dataset/snapshot is synthetic, stale or incomplete": {
    category: "GUARD",
    code: "KR_DATASET_SNAPSHOT_IS_SYNTHETIC_STALE_OR_INCOMPLETE",
  },
  "Stored October session integrity mismatch": {
    category: "GUARD",
    code: "STORED_OCTOBER_SESSION_INTEGRITY_MISMATCH",
  },
  "Prepared October publication integrity mismatch": {
    category: "GUARD",
    code: "PREPARED_OCTOBER_PUBLICATION_INTEGRITY_MISMATCH",
  },
  "Incomplete prepared October book set": {
    category: "GUARD",
    code: "INCOMPLETE_PREPARED_OCTOBER_BOOK_SET",
  },
  "Prepared October contract changed": {
    category: "GUARD",
    code: "PREPARED_OCTOBER_CONTRACT_CHANGED",
  },
  "Prepared October input identity mismatch": {
    category: "GUARD",
    code: "PREPARED_OCTOBER_INPUT_IDENTITY_MISMATCH",
  },
  "Prepared October day conflicts with immutable history": {
    category: "GUARD",
    code: "PREPARED_OCTOBER_DAY_CONFLICTS_WITH_IMMUTABLE_HISTORY",
  },
  "Prepared October predecessor is unavailable": {
    category: "GUARD",
    code: "PREPARED_OCTOBER_PREDECESSOR_IS_UNAVAILABLE",
  },
  "Private KR source vintage approval is not active for this date": {
    category: "GUARD",
    code: "PRIVATE_KR_SOURCE_VINTAGE_APPROVAL_IS_NOT_ACTIVE_FOR_THIS_DATE",
  },
  "Reviewed retrospective predecessor changed": {
    category: "GUARD",
    code: "REVIEWED_RETROSPECTIVE_PREDECESSOR_CHANGED",
  },
  "Reviewed retrospective predecessor registry missing": {
    category: "GUARD",
    code: "REVIEWED_RETROSPECTIVE_PREDECESSOR_REGISTRY_MISSING",
  },
  "Prepared October input is immutable": {
    category: "GUARD",
    code: "PREPARED_OCTOBER_INPUT_IS_IMMUTABLE",
  },
  "ETF completed close/strategy data is still pending": {
    category: "GUARD",
    code: "ETF_COMPLETED_CLOSE_STRATEGY_DATA_IS_STILL_PENDING",
  },
  "Private KR source vintage approval changed or missing": {
    category: "GUARD",
    code: "PRIVATE_KR_SOURCE_VINTAGE_APPROVAL_CHANGED_OR_MISSING",
  },
  "Duplicate retained KR source vintage receipt": {
    category: "GUARD",
    code: "DUPLICATE_RETAINED_KR_SOURCE_VINTAGE_RECEIPT",
  },
  "Duplicate historical KR observations": {
    category: "GUARD",
    code: "DUPLICATE_HISTORICAL_KR_OBSERVATIONS",
  },
  "KR compact publication requires archived predecessor inputs": {
    category: "GUARD",
    code: "KR_COMPACT_PUBLICATION_REQUIRES_ARCHIVED_PREDECESSOR_INPUTS",
  },
  "KOSPI Shadow revision: explicit valid timestamp with timezone required": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_EXPLICIT_VALID_TIMESTAMP_WITH_TIMEZONE_REQUIRED",
  },
  "KOSPI Shadow revision: unsupported revision ID": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_UNSUPPORTED_REVISION_ID",
  },
  "KOSPI Shadow revision: invalid owner": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_OWNER",
  },
  "KOSPI Shadow revision: invalid revision object path": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_REVISION_OBJECT_PATH",
  },
  "KOSPI Shadow revision: malformed revision metadata": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_MALFORMED_REVISION_METADATA",
  },
  "KOSPI Shadow revision: unsupported revision lineage or capital reset": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_UNSUPPORTED_REVISION_LINEAGE_OR_CAPITAL_RESET",
  },
  "KOSPI Shadow revision: invalid code provenance": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_CODE_PROVENANCE",
  },
  "KOSPI Shadow revision: source registration/computation timing is invalid": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_SOURCE_REGISTRATION_COMPUTATION_TIMING_IS_INVALID",
  },
  "KOSPI Shadow revision: missing inherited prefix": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_MISSING_INHERITED_PREFIX",
  },
  "KOSPI Shadow revision: invalid inherited prefix": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_INHERITED_PREFIX",
  },
  "KOSPI Shadow revision: inherited predecessor hash mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INHERITED_PREDECESSOR_HASH_MISMATCH",
  },
  "KOSPI Shadow revision: missing registry": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_MISSING_REGISTRY",
  },
  "KOSPI Shadow revision: frozen registry mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_FROZEN_REGISTRY_MISMATCH",
  },
  "KOSPI Shadow revision: invalid predecessor date": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_PREDECESSOR_DATE",
  },
  "KOSPI Shadow revision: invalid or incomplete journal chain": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_OR_INCOMPLETE_JOURNAL_CHAIN",
  },
  "KOSPI Shadow revision: journal predecessor gap": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_JOURNAL_PREDECESSOR_GAP",
  },
  "KOSPI Shadow revision: journal session count mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_JOURNAL_SESSION_COUNT_MISMATCH",
  },
  "KOSPI Shadow revision: empty journal": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_EMPTY_JOURNAL",
  },
  "KOSPI Shadow revision: authoritative history/trades projection mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_AUTHORITATIVE_HISTORY_TRADES_PROJECTION_MISMATCH",
  },
  "KOSPI Shadow revision: registry revision descriptor mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REGISTRY_REVISION_DESCRIPTOR_MISMATCH",
  },
  "KOSPI Shadow revision: invalid retrospective view": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_RETROSPECTIVE_VIEW",
  },
  "KOSPI Shadow revision: parent registry hash mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_PARENT_REGISTRY_HASH_MISMATCH",
  },
  "KOSPI Shadow revision: registry config content mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REGISTRY_CONFIG_CONTENT_MISMATCH",
  },
  "KOSPI Shadow revision: corrected snapshot provenance mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_CORRECTED_SNAPSHOT_PROVENANCE_MISMATCH",
  },
  "KOSPI Shadow revision: invalid revision namespace": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_REVISION_NAMESPACE",
  },
  "KOSPI Shadow revision: inherited prefix length mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INHERITED_PREFIX_LENGTH_MISMATCH",
  },
  "KOSPI Shadow revision: inherited prefix snapshot hash mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INHERITED_PREFIX_SNAPSHOT_HASH_MISMATCH",
  },
  "KOSPI Shadow revision: corrected journal provenance mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_CORRECTED_JOURNAL_PROVENANCE_MISMATCH",
  },
  "KOSPI Shadow revision: original parent anchors changed or advanced": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_ORIGINAL_PARENT_ANCHORS_CHANGED_OR_ADVANCED",
  },
  "KOSPI Shadow revision: original inherited prefix changed": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_ORIGINAL_INHERITED_PREFIX_CHANGED",
  },
  "KOSPI Shadow revision: original inherited prefix mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_ORIGINAL_INHERITED_PREFIX_MISMATCH",
  },
  "KOSPI Shadow revision: missing approval": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_MISSING_APPROVAL",
  },
  "KOSPI Shadow revision: invalid approval anchors": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_APPROVAL_ANCHORS",
  },
  "KOSPI Shadow revision: correction session does not match approved boundary": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_CORRECTION_SESSION_DOES_NOT_MATCH_APPROVED_BOUNDARY",
  },
  "KOSPI Shadow revision: invalid source registration/computation timing": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INVALID_SOURCE_REGISTRATION_COMPUTATION_TIMING",
  },
  "KOSPI Shadow revision: config content hash mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_CONFIG_CONTENT_HASH_MISMATCH",
  },
  "KOSPI Shadow revision: original registry/latest missing or already revised": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_ORIGINAL_REGISTRY_LATEST_MISSING_OR_ALREADY_REVISED",
  },
  "KOSPI Shadow revision: original registry/projection or newest date mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_ORIGINAL_REGISTRY_PROJECTION_OR_NEWEST_DATE_MISMATCH",
  },
  "KOSPI Shadow revision: approved predecessor/original target hash mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_APPROVED_PREDECESSOR_ORIGINAL_TARGET_HASH_MISMATCH",
  },
  "KOSPI Shadow revision: immutable revision collision": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_IMMUTABLE_REVISION_COLLISION",
  },
  "KOSPI Shadow revision: newer immutable history exists without projection; cannot rewind": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_NEWER_IMMUTABLE_HISTORY_EXISTS_WITHOUT_PROJECTION_CANNOT_REWIND",
  },
  "KOSPI Shadow revision: incomplete or mismatched existing revision projection": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INCOMPLETE_OR_MISMATCHED_EXISTING_REVISION_PROJECTION",
  },
  "KOSPI Shadow revision: revision advanced during initialization; cannot rewind": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REVISION_ADVANCED_DURING_INITIALIZATION_CANNOT_REWIND",
  },
  "KOSPI Shadow revision: revision projection changed during initialization": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REVISION_PROJECTION_CHANGED_DURING_INITIALIZATION",
  },
  "KOSPI Shadow revision: incomplete revision registry/projection": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_INCOMPLETE_REVISION_REGISTRY_PROJECTION",
  },
  "KOSPI Shadow revision: revision journal/projection date mismatch": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REVISION_JOURNAL_PROJECTION_DATE_MISMATCH",
  },
  "KOSPI Shadow revision: revision has more than one pending journal append": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REVISION_HAS_MORE_THAN_ONE_PENDING_JOURNAL_APPEND",
  },
  "KOSPI Shadow revision: cross-owner or unrelated logical path": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_CROSS_OWNER_OR_UNRELATED_LOGICAL_PATH",
  },
  "KOSPI Shadow revision: unrelated session namespace": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_UNRELATED_SESSION_NAMESPACE",
  },
  "KOSPI Shadow revision: registry and inherited prefix writes are forbidden": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REGISTRY_AND_INHERITED_PREFIX_WRITES_ARE_FORBIDDEN",
  },
  "KOSPI Shadow revision: missing authoritative revision projection": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_MISSING_AUTHORITATIVE_REVISION_PROJECTION",
  },
  "KOSPI Shadow revision: immutable revision snapshot collision": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_IMMUTABLE_REVISION_SNAPSHOT_COLLISION",
  },
  "KOSPI Shadow revision: pending authoritative revision snapshot must be projected first": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_PENDING_AUTHORITATIVE_REVISION_SNAPSHOT_MUST_BE_PROJECTED_FIRST",
  },
  "KOSPI Shadow revision: revision cannot rewind or skip its predecessor": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REVISION_CANNOT_REWIND_OR_SKIP_ITS_PREDECESSOR",
  },
  "KOSPI Shadow revision: only latest projection is mutable": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_ONLY_LATEST_PROJECTION_IS_MUTABLE",
  },
  "KOSPI Shadow revision: revision projection cannot reset or rewind": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_REVISION_PROJECTION_CANNOT_RESET_OR_REWIND",
  },
  "KOSPI Shadow revision: newer authoritative revision history exists": {
    category: "FROZEN_LEGACY",
    code: "KOSPI_REVISION_NEWER_AUTHORITATIVE_REVISION_HISTORY_EXISTS",
  },
  FINAL_RETROSPECTIVE_SESSION_DATE: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_SESSION_DATE",
  },
  FINAL_RETROSPECTIVE_CAPTURE_IDENTITY: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_CAPTURE_IDENTITY",
  },
  FINAL_RETROSPECTIVE_RUNTIME: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_RUNTIME",
  },
  FINAL_RETROSPECTIVE_ACTUAL_CLOCKS: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_ACTUAL_CLOCKS",
  },
  FINAL_RETROSPECTIVE_FINAL_HORIZON: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_FINAL_HORIZON",
  },
  FINAL_RETROSPECTIVE_EXACT_FIVE_PREDECESSORS: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_EXACT_FIVE_PREDECESSORS",
  },
  FINAL_RETROSPECTIVE_FROZEN_RUNTIME: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_FROZEN_RUNTIME",
  },
  FINAL_RETROSPECTIVE_CAPTURED_ARCHIVE_HASH: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_CAPTURED_ARCHIVE_HASH",
  },
  FINAL_RETROSPECTIVE_PREDECESSOR_ARCHIVE_REFERENCE: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_PREDECESSOR_ARCHIVE_REFERENCE",
  },
  FINAL_RETROSPECTIVE_EXACT_MODEL_SCOPE: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_EXACT_MODEL_SCOPE",
  },
  FINAL_RETROSPECTIVE_LEGACY_CAPTURE_HASH: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_LEGACY_CAPTURE_HASH",
  },
  FINAL_RETROSPECTIVE_ORIGINAL_CORRECTION_APPROVAL: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_ORIGINAL_CORRECTION_APPROVAL",
  },
  FINAL_RETROSPECTIVE_LEGACY_BOUNDARY_BLOCKED: {
    category: "GUARD",
    code: "FINAL_RETROSPECTIVE_LEGACY_BOUNDARY_BLOCKED",
  },
  PURE_CAPTURE_IDENTITY_REJECTED: {
    category: "GUARD",
    code: "PURE_CAPTURE_IDENTITY_REJECTED",
  },
  PLAN_SIZE_REJECTED: {
    category: "GUARD",
    code: "PLAN_SIZE_REJECTED",
  },
  PLAN_WRITE_REJECTED: {
    category: "GUARD",
    code: "PLAN_WRITE_REJECTED",
  },
  CAPTURE_CODEC_REJECTED: {
    category: "GUARD",
    code: "CAPTURE_CODEC_REJECTED",
  },
  PREFLIGHT_INPUT_REJECTED: {
    category: "GUARD",
    code: "PREFLIGHT_INPUT_REJECTED",
  },
} as const;
const IO_CODES = ["ENOENT", "EEXIST", "ENOSPC", "EMFILE", "ENOMEM", "EACCES"] as const;
export interface FinalComputeFailure {
  category: FinalComputeCategory;
  code?: string;
}
export type FinalComputeDiagnostic =
  | { kind: "STAGE"; stage: FinalComputeStage }
  | ({ kind: "FAILURE"; stage: FinalComputeStage } & FinalComputeFailure);
export function classifyFinalComputeFailure(error: unknown): FinalComputeFailure {
  if (error instanceof Error) {
    if (Object.hasOwn(FINAL_COMPUTE_ERRORS, error.message))
      return { ...FINAL_COMPUTE_ERRORS[error.message as keyof typeof FINAL_COMPUTE_ERRORS] };
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === "string" && (IO_CODES as readonly string[]).includes(code))
      return { category: "FILE_IO", code: "IO_" + code };
    if (error instanceof RangeError) return { category: "RANGE_ERROR" };
    if (error instanceof SyntaxError) return { category: "SYNTAX_ERROR" };
    if (error instanceof TypeError) return { category: "TYPE_ERROR" };
  }
  return { category: "UNKNOWN" };
}
export function parseFinalComputeDiagnostics(stderr: unknown): FinalComputeDiagnostic[] {
  if (typeof stderr !== "string" || stderr.length > 65536) return [];
  const records: FinalComputeDiagnostic[] = [];
  for (const line of stderr.split(/\r?\n/)) {
    if (!line || line.length > 512) continue;
    try {
      const x = JSON.parse(line);
      if (
        !x ||
        typeof x !== "object" ||
        Array.isArray(x) ||
        !(FINAL_COMPUTE_STAGES as readonly unknown[]).includes(x.stage)
      )
        continue;
      const keys = Object.keys(x).sort().join(",");
      if (x.kind === "STAGE" && keys === "kind,stage")
        records.push({ kind: "STAGE", stage: x.stage });
      else if (
        x.kind === "FAILURE" &&
        (keys === "category,kind,stage" || keys === "category,code,kind,stage") &&
        (FINAL_COMPUTE_CATEGORIES as readonly unknown[]).includes(x.category)
      ) {
        if (Object.hasOwn(x, "code")) {
          const known =
            Object.values(FINAL_COMPUTE_ERRORS).some(
              (v) => v.category === x.category && v.code === x.code,
            ) ||
            (x.category === "FILE_IO" && IO_CODES.some((c) => "IO_" + c === x.code));
          if (!known) continue;
          records.push({ kind: "FAILURE", stage: x.stage, category: x.category, code: x.code });
        } else records.push({ kind: "FAILURE", stage: x.stage, category: x.category });
      }
      if (records.length > 256) records.shift();
    } catch {
      /* Ignore raw stacks, malformed JSON and unknown fields. */
    }
  }
  return records;
}
export function summarizeFinalComputeExit(child: {
  status?: unknown;
  signal?: unknown;
  error?: unknown;
}) {
  const signals = [
    "SIGTERM",
    "SIGKILL",
    "SIGABRT",
    "SIGSEGV",
    "SIGINT",
    "SIGBUS",
    "SIGILL",
    "SIGFPE",
  ];
  const errorCode =
    child.error && typeof child.error === "object"
      ? (child.error as { code?: unknown }).code
      : undefined;
  return {
    status: "FINAL_COMPUTE_EXIT" as const,
    exitCode:
      typeof child.status === "number" &&
      Number.isInteger(child.status) &&
      child.status >= 0 &&
      child.status <= 255
        ? child.status
        : null,
    signal:
      child.signal == null
        ? null
        : signals.includes(String(child.signal))
          ? String(child.signal)
          : "OTHER",
    timeout: errorCode === "ETIMEDOUT",
    spawnFailure: !!child.error,
    errorCategory:
      errorCode === "ENOBUFS"
        ? "OUTPUT_LIMIT"
        : errorCode === "ETIMEDOUT"
          ? "TIMEOUT"
          : child.error
            ? "SPAWN_ERROR"
            : "NONE",
  };
}
