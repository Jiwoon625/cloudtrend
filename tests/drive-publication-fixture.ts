import { createHash } from "node:crypto";
import { preliminarySource } from "./kr-preliminary-fixture";
import { buildKrSourcePublication } from "../src/lib/krScreeningPublication.server";
import {
  type DriveResultPublication,
  type DriveResultSource,
} from "../src/lib/driveResultPublication";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export function driveFixture() {
  const fixture = preliminarySource();
  const raw = fixture.source.validation_result.krPublication;
  const manifest = JSON.parse(raw.manifestText);
  manifest.createdAt = fixture.source.created_at;
  manifest.csv = [
    { file: "input.csv", bytes: Buffer.byteLength(fixture.text), sha256: fixture.source.file_hash },
  ];
  const manifestText = JSON.stringify(manifest);
  const publication = buildKrSourcePublication(
    { ...raw, manifestText, manifestSha256: "sha256:" + sha(manifestText) },
    fixture.source,
  );
  const entry: DriveResultSource = {
    archiveFileId: "syntheticArchive123",
    archiveSha256: sha("archive"),
    csvFile: "input.csv",
    record: {
      id: `drive-${raw.requestId}-${fixture.source.file_hash.slice(7, 23)}`,
      data_hash: fixture.source.data_hash,
      schema_hash: fixture.source.schema_hash,
      file_hash: fixture.source.file_hash,
      max_date: fixture.source.max_date,
      file_size_bytes: Buffer.byteLength(fixture.text),
      created_at: new Date(fixture.source.created_at).toISOString(),
      activated_at: new Date(fixture.source.activated_at).toISOString(),
      storage_bucket: "google-drive",
      storage_path: "drive://syntheticArchive123/kr-outputs/input.csv",
      validation_result: { krPublication: publication },
    },
  };
  return {
    version: "drive-result-publication-v1",
    baseFingerprint: sha("base"),
    asOfDate: fixture.source.max_date,
    phase: "PRELIMINARY",
    sources: [entry],
  } satisfies DriveResultPublication;
}
