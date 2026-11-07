import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseKrPublicationRequest } from "../src/lib/krScreeningPublication";
import {
  krSourcePublication,
  validateKrPublicationManifest,
} from "../src/lib/krScreeningPublication";
import { trustedSupabaseClient } from "./analysis-run-store";
import {
  registerSourceBytes,
  listSourceRecords,
  loadAnalysisSourceInputs,
  recordFor,
  type SourceRecord,
} from "./source-registry-store";
import { validateSourceBytes, compareSourceRows } from "../src/lib/sourceData";
import { buildKrSourcePublication } from "../src/lib/krScreeningPublication.server";
import { runScreening } from "./run-screening";
import { publishDriveResult, maybeDriveHead } from "./publish-drive-result";
import { stableCacheJson } from "../src/lib/screeningCacheContract";
import type { DriveResultSource } from "../src/lib/driveResultPublication";

interface PreparedRun {
  version: string;
  runId: string;
  mode: "drive" | "supabase" | "publish";
  parents?: string[];
  expectedHeadHash?: string | null;
  archiveFileId: string;
  archiveSha256: string;
  manifestSha256: string;
  parts: Array<{ path: string; sha256: string }>;
}
interface CollectorManifest {
  createdAt: string;
  actualLatestPriceDate: string;
  krxPublicationEvidence: { phase: string };
  csv: Array<{ file: string; sha256: string; bytes: number }>;
}

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

async function readPreparedGroup(directory: string) {
  const spec = JSON.parse(
    await readFile(path.join(directory, "input.json"), "utf8"),
  ) as PreparedRun;
  if (
    spec.version !== "drive-screening-input-v1" ||
    !["drive", "supabase", "publish"].includes(spec.mode) ||
    !Array.isArray(spec.parts) ||
    !spec.parts.length
  )
    throw new Error("Invalid prepared Drive run");
  const manifestText = await readFile(path.join(directory, "collector-manifest.json"), "utf8");
  if (sha(manifestText) !== spec.manifestSha256)
    throw new Error("Collector manifest changed after preparation");
  const manifest = JSON.parse(manifestText) as CollectorManifest;
  const publication = parseKrPublicationRequest({
    version: "kr-screening-publication-v1",
    requestId: spec.runId,
    phase: manifest.krxPublicationEvidence?.phase,
    manifestText,
    manifestSha256: `sha256:${spec.manifestSha256}`,
  });
  validateKrPublicationManifest(publication, manifest.actualLatestPriceDate);
  // Validate every part before making any registry changes.
  const parts = await Promise.all(
    spec.parts.map(async (part) => {
      if (
        typeof part.path !== "string" ||
        path.basename(part.path) !== part.path ||
        !part.path.endsWith(".csv")
      )
        throw new Error("Invalid prepared source path");
      const bytes = new Uint8Array(await readFile(path.join(directory, part.path)));
      const entry = manifest.csv.find((entry) => entry.file === part.path);
      if (
        !entry ||
        sha(bytes) !== part.sha256 ||
        entry.sha256.replace(/^sha256:/, "") !== part.sha256 ||
        bytes.byteLength !== entry.bytes
      )
        throw new Error("Drive CSV does not match collector manifest");
      return {
        ...part,
        bytes,
      };
    }),
  );
  if (
    parts.length !== manifest.csv.length ||
    new Set(parts.map((p) => p.path)).size !== parts.length
  )
    throw new Error("Prepared CSV part set differs from manifest");
  return { spec, manifest, publication, parts };
}

export async function runDriveScreening(root: string, upload = true) {
  const directory = path.resolve(root);
  const { spec, manifest, publication, parts } = await readPreparedGroup(directory);
  const userId = process.env["SUPABASE_USER_ID"];
  if (!userId || !/^[a-f0-9-]{36}$/i.test(userId)) throw new Error("Missing SUPABASE_USER_ID");
  const client = trustedSupabaseClient();
  if (spec.mode === "supabase" && (await maybeDriveHead(client, userId)))
    throw new Error(
      "Drive 게시 이력이 있습니다. 원천 재등록 방식과 섞지 말고 v1.1 결과 게시를 사용해 주세요.",
    );
  // Never let an old checkpoint replace a more recent operational screen.
  const active = await listSourceRecords(client, userId, "screening");
  if (active.some((s) => s.max_date && s.max_date > manifest.actualLatestPriceDate))
    throw new Error(
      "선택한 저장자료보다 최신 스크리닝이 있습니다. 과거 자료로 현재 화면을 덮어쓸 수 없습니다.",
    );
  const sourceReceipts: Record<string, unknown>[] = [];
  const receipt: Record<string, unknown> = {
    runId: spec.runId,
    mode: spec.mode,
    phase: publication.phase,
    status: spec.mode !== "supabase" ? "LOADING_HISTORY" : "REGISTERING",
    archiveFileId: spec.archiveFileId,
    archiveSha256: spec.archiveSha256,
    manifestSha256: spec.manifestSha256,
    startedAt: new Date().toISOString(),
    sources: sourceReceipts,
    sourceStorage: spec.mode !== "supabase" ? "GOOGLE_DRIVE" : "SUPABASE_STORAGE",
    dashboardPublished: false,
  };
  const receiptPath = path.join(directory, "execution-receipt.json");
  await mkdir(directory, { recursive: true });
  const save = () => writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  await save();
  try {
    if (spec.mode !== "supabase") {
      // Use the established historical sources, then overlay verified Drive daily rows.
      // Virtual descriptors exist only in this process: the collector registry is untouched.
      const inputs = await loadAnalysisSourceInputs(client, userId, "screening", { compact: true });
      const baseline = inputs.map((i) => ({
        id: i.id,
        fileHash: i.fileHash,
        dataHash: i.dataHash,
      }));
      const groups: Array<Awaited<ReturnType<typeof readPreparedGroup>>> = [];
      if (spec.mode === "publish") {
        if (
          spec.expectedHeadHash === undefined ||
          !Array.isArray(spec.parents) ||
          spec.parents.length > 64
        )
          throw new Error("Missing Drive input head checkpoint");
        const head = await maybeDriveHead(client, userId);
        if ((head ? sha(stableCacheJson(head)) : null) !== spec.expectedHeadHash)
          throw new Error("Drive input head changed after preparation");
        for (const parent of spec.parents) {
          if (!/^parent-\d{3}$/.test(parent)) throw new Error("Invalid parent directory");
          groups.push(await readPreparedGroup(path.join(directory, parent)));
        }
      }
      groups.push({ spec, manifest, publication, parts });
      const proofSources: DriveResultSource[] = [];
      const seen = new Set<string>();
      for (const group of groups)
        for (const part of group.parts) {
          const validation = await validateSourceBytes({
            bytes: part.bytes,
            filename: part.path,
            streamingCsv: true,
          });
          if (!validation.valid) throw new Error(`Saved CSV validation failed: ${part.path}`);
          const id = `drive-${group.spec.runId}-${part.sha256.slice(0, 16)}`;
          if (seen.has(id)) continue;
          seen.add(id);
          const record = recordFor({
            id,
            userId,
            sourceType: "screening",
            origin: "github_action",
            storagePath: `drive://${group.spec.archiveFileId}/kr-outputs/${part.path}`,
            validation,
            overlap: compareSourceRows([], []),
          });
          const krPublication = buildKrSourcePublication(group.publication, record);
          const savedAt = new Date(group.manifest.createdAt).toISOString();
          const source = {
            ...record,
            storage_bucket: "google-drive",
            status: "active",
            created_at: savedAt,
            activated_at: savedAt,
            updated_at: savedAt,
            superseded_by: null,
            validation_result: { ...record.validation_result, krPublication },
          } as SourceRecord;
          proofSources.push({
            archiveFileId: group.spec.archiveFileId,
            archiveSha256: group.spec.archiveSha256,
            csvFile: part.path,
            record: {
              id: source.id,
              data_hash: source.data_hash,
              schema_hash: source.schema_hash,
              file_hash: source.file_hash,
              max_date: source.max_date!,
              file_size_bytes: source.file_size_bytes,
              storage_bucket: "google-drive",
              storage_path: source.storage_path,
              activated_at: savedAt,
              created_at: source.created_at,
              validation_result: { krPublication },
            },
          });
          inputs.push({
            id,
            fileName: part.path,
            bytes: part.bytes.byteLength,
            savedAt,
            text: validation.canonicalCsv,
            fileHash: validation.fileHash,
            dataHash: validation.dataHash,
            schemaHash: validation.schemaHash,
            validation: { ...validation, rows: [] },
            sourceRecord: source,
          });
          sourceReceipts.push({
            id,
            fileHash: validation.fileHash,
            dataHash: validation.dataHash,
          });
        }
      receipt["status"] = "SCREENING";
      await save();
      if (spec.mode === "publish" && process.env["CT_PREPARE_CHARTS"] === "true") {
        const cache = path.join(directory, "chart-inputs");
        await mkdir(cache, { recursive: true });
        const files = [];
        for (let i = 0; i < inputs.length; i++) {
          const name = `${String(i).padStart(4, "0")}.csv`,
            text = inputs[i]!.text;
          await writeFile(path.join(cache, name), text);
          files.push({ file: name, sha256: sha(text) });
        }
        await writeFile(path.join(cache, "index.json"), JSON.stringify(files));
      }
      const result = await runScreening(
        ["--supabase-user-id", userId, "--output", path.join(directory, "results"), "--force"],
        inputs,
        {
          kind: "GOOGLE_DRIVE_WITH_REGISTERED_HISTORY",
          collectorRunId: spec.runId,
          archiveFileId: spec.archiveFileId,
          archiveSha256: spec.archiveSha256,
          manifestSha256: spec.manifestSha256,
          historicalSources: baseline,
        },
      );
      receipt["phase"] = result?.summary.krPublication?.phase ?? "FINAL";
      if (spec.mode === "publish") {
        if (!result) throw new Error("Calculated Drive result is missing");
        const published = await publishDriveResult({
          client,
          owner: userId,
          outputDir: result.outputDir,
          inputs,
          sources: proofSources,
          expectedHeadHash: spec.expectedHeadHash!,
        });
        receipt["publication"] = published;
        receipt["dashboardPublished"] = true;
        receipt["sourceUploads"] = 0;
      }
    } else {
      for (const part of parts) {
        const exact = active.find((source) => source.file_hash === `sha256:${part.sha256}`);
        if (exact) {
          const saved = krSourcePublication(exact);
          if (
            !saved ||
            saved.manifestSha256 !== publication.manifestSha256 ||
            saved.requestId !== publication.requestId
          )
            throw new Error("Identical registered bytes have a different publication contract");
          sourceReceipts.push({ id: exact.id, hash: exact.file_hash, reused: true });
        } else {
          const registered = await registerSourceBytes({
            client,
            userId,
            sourceType: "screening",
            mode: "merge",
            origin: "github_action",
            filename: part.path,
            bytes: part.bytes,
            syncLegacy: false,
            krPublication: publication,
          });
          active.push(registered.source);
          sourceReceipts.push({
            id: registered.source.id,
            hash: registered.source.file_hash,
            reused: registered.reused,
          });
        }
        await save();
      }
      receipt["status"] = "SCREENING";
      await save();
      await runScreening([
        "--supabase-user-id",
        userId,
        "--output",
        path.join(directory, "results"),
        ...(upload ? ["--upload"] : []),
      ]);
      receipt["dashboardPublished"] = upload;
    }
    receipt["status"] = "COMPLETED";
    receipt["completedAt"] = new Date().toISOString();
    await save();
  } catch (error) {
    receipt["status"] = "FAILED";
    // Raw server errors can contain credentials or URLs; keep the durable receipt bounded.
    receipt["error"] =
      "스크리닝 실행 실패. GitHub 작업 로그에서 실패 단계를 확인하고 같은 실행을 재개해 주세요.";
    await save();
    throw error;
  }
}
