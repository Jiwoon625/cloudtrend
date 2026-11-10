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

  if (
    stableCacheJson(parents.map(driveSourceBinding)) !==
    stableCacheJson(carried.map(driveSourceBinding))
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
    if (
      !target?.sourceRecord ||
      target.fileHash !== record.file_hash ||
      target.dataHash !== record.data_hash ||
      target.schemaHash !== record.schema_hash ||
      target.sourceRecord.file_hash !== record.file_hash ||
      target.sourceRecord.data_hash !== record.data_hash ||
      target.sourceRecord.schema_hash !== record.schema_hash
    )
      throw new Error("Published parent differs from calculation input");
    return target;
  });
  carried.forEach(({ record }, index) => {
    const target = targets[index]!;
    target.sourceRecord = { ...target.sourceRecord!, validation_result: record.validation_result };
  });
  return carried;
}

export const driveSourceBinding = (s: DriveResultSource) => ({
  ...s,
  record: {
    ...s.record,
    validation_result: {
      krPublication: { ...s.record.validation_result.krPublication, supersedesPending: undefined },
    },
  },
});
