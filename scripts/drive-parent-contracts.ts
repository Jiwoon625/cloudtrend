import {
  drivePublicationSources,
  type DriveResultPublication,
  type DriveResultSource,
} from "../src/lib/driveResultPublication";
import { stableCacheJson } from "../src/lib/screeningCacheContract";
import type { LoadedSourceInput } from "./source-registry-store";

/** Carry contracts only from a CAS-pinned published head, after reproducing every parent byte identity.
 * This verifies source proofs, not the live config/operational baseline: publication checks that
 * independently using the calculated bundle's config and operational identity.
 */
export async function carryPublishedParentContracts(
  publication: DriveResultPublication | undefined,
  parents: DriveResultSource[],
  inputs: LoadedSourceInput[],
): Promise<DriveResultSource[]> {
  if (!publication) {
    if (parents.length) throw new Error("Unpublished Drive parents are not allowed");
    return [];
  }
  const registered = inputs.flatMap((i) =>
    i.sourceRecord && i.sourceRecord.storage_bucket !== "google-drive" ? [i.sourceRecord] : [],
  );
  await drivePublicationSources(
    publication,
    registered,
    publication.baseFingerprint,
    publication.asOfDate,
    publication.phase,
  );
  const carried = publication.sources;

  // A retained parent is identified by the immutable Drive bytes it was published from. Its
  // canonical data/schema hashes are re-derived on every run by the validator in the current
  // runner image, so those derived values can legitimately differ for the very same bytes
  // (for example after a base-image or locale change). Compare the published byte binding,
  // then carry the published contract verbatim: the engine still reads the actual part bytes.
  if (
    stableCacheJson(parents.map(driveByteBinding)) !==
    stableCacheJson(carried.map(driveByteBinding))
  )
    throw new Error("이전 Drive 입력 이력이 누락되거나 변경됐습니다.");
  const ids = new Set<string>();
  for (const input of inputs) {
    if (ids.has(input.id) || (input.sourceRecord && input.sourceRecord.id !== input.id))
      throw new Error("Ambiguous Drive calculation input identity");
    ids.add(input.id);
  }
  // Validate every target before changing any contract.
  const targets = carried.map(({ record }) => {
    const target = inputs.find((i) => i.id === record.id);
    // Byte identity is the contract for a retained parent: the part read here must be the
    // exact Drive bytes the publication recorded. Derived canonical hashes are adopted below.
    if (
      !target?.sourceRecord ||
      target.fileHash !== record.file_hash ||
      target.sourceRecord.file_hash !== record.file_hash
    )
      throw new Error("Published parent differs from calculation input");
    return target;
  });
  carried.forEach(({ record }, index) => {
    const target = targets[index]!;
    // The identity of a retained parent is the contract it was published with, not a value
    // re-derived in this runner image. The bytes are proven identical above by file_hash.
    target.fileHash = record.file_hash as typeof target.fileHash;
    target.dataHash = record.data_hash as typeof target.dataHash;
    target.schemaHash = record.schema_hash as typeof target.schemaHash;
    target.sourceRecord = {
      ...target.sourceRecord!,
      file_hash: record.file_hash,
      data_hash: record.data_hash,
      schema_hash: record.schema_hash,
      validation_result: record.validation_result,
    };
  });
  return carried;
}

export const driveByteBinding = (s: DriveResultSource) => {
  const p = s.record.validation_result.krPublication;
  return {
    archiveFileId: s.archiveFileId,
    archiveSha256: s.archiveSha256,
    csvFile: s.csvFile,
    record: {
      id: s.record.id,
      file_hash: s.record.file_hash,
      file_size_bytes: s.record.file_size_bytes,
      max_date: s.record.max_date,
      storage_bucket: s.record.storage_bucket,
      storage_path: s.record.storage_path,
      created_at: s.record.created_at,
      activated_at: s.record.activated_at,
      publication: {
        phase: p.phase,
        requestId: p.requestId,
        manifestSha256: p.manifestSha256,
        asOfDate: p.asOfDate,
      },
    },
  };
};

export const driveSourceBinding = (s: DriveResultSource) => ({
  ...s,
  record: {
    ...s.record,
    validation_result: {
      krPublication: { ...s.record.validation_result.krPublication, supersedesPending: undefined },
    },
  },
});
