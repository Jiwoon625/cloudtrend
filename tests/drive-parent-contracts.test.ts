import { expect, test } from "vitest";
import { driveFixture } from "./drive-publication-fixture";
import { carryPublishedParentContracts } from "../scripts/drive-parent-contracts";
import type { LoadedSourceInput } from "../scripts/source-registry-store";

function fixture() {
  const publication = driveFixture("FINAL");
  const record = publication.sources[0]!.record;
  const inputs = [
    {
      id: record.id,
      fileHash: record.file_hash,
      dataHash: record.data_hash,
      schemaHash: record.schema_hash,
      sourceRecord: structuredClone(record),
    },
  ] as LoadedSourceInput[];
  return { publication, inputs };
}

test.each(["duplicate", "record-id", "file", "data", "schema"])(
  "ambiguous or mismatched %s input cannot receive a parent contract",
  async (mutation) => {
    const { publication, inputs } = fixture();
    if (mutation === "duplicate") inputs.push(structuredClone(inputs[0]!));
    if (mutation === "record-id") inputs[0]!.sourceRecord!.id = "wrong";
    if (mutation === "file") inputs[0]!.fileHash = "wrong";
    if (mutation === "data") inputs[0]!.dataHash = "wrong";
    if (mutation === "schema") inputs[0]!.schemaHash = "wrong";
    const before = structuredClone(inputs);
    await expect(
      carryPublishedParentContracts(publication, publication.sources, inputs),
    ).rejects.toThrow();
    expect(inputs).toEqual(before);
  },
);
