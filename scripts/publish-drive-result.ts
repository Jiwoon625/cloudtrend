import { verifiedCalculationEngineIdentity } from "./screening-engine-identity";
import {
  assertScreeningEngineIdentity,
  type ScreeningEngineIdentity,
} from "../src/lib/screeningEngineIdentity";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  drivePublicationSources,
  currentDriveGeneration,
  type DriveResultPublication,
  type DriveResultSource,
  krResultPhase,
} from "../src/lib/driveResultPublication";
import { classifyKrScreeningPublication } from "../src/lib/krScreeningPublication";
import { savedOperationalIdentity } from "../src/lib/screeningInputIdentity";
import { stableCacheJson, deterministicAnalysis } from "../src/lib/screeningCacheContract";
import { buildSnapshot } from "../src/lib/screeningSnapshot";
import { listSourceRecords, type LoadedSourceInput } from "./source-registry-store";
import { downloadJson, uploadJson, sha256 } from "./analysis-run-store";
import { uploadScreeningJsonFile } from "./screening-json-file";
import {
  preflightWebScreeningCaches,
  inputFingerprint,
  type ExistingScreeningCache,
} from "./web-screening-cache-store";
import { liveRegistryInput } from "./live-registry-timestamp";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { ScoringConfig } from "../src/lib/engine/scoring";

import { carryPublishedParentContracts } from "./drive-parent-contracts";

export const DRIVE_INPUT_HEAD = "results/drive-screening/input-head/latest.json";
export async function maybeDriveHead(client: SupabaseClient, owner: string) {
  try {
    return await downloadJson<{ version: string; drivePublication: DriveResultPublication }>(
      client,
      `${owner}/${DRIVE_INPUT_HEAD}`,
    );
  } catch (error) {
    if (error instanceof Error && /Object not found|not_found|404/i.test(error.message))
      return null;
    throw error;
  }
}
export async function publishDriveResult(input: {
  client: SupabaseClient;
  owner: string;
  outputDir: string;
  inputs: LoadedSourceInput[];
  sources: DriveResultSource[];
  expectedHeadHash: string | null;
}) {
  const { client, owner } = input;
  // Compare registry identity in the form a live read produces (see liveRegistryTimestamp).
  const inputs = input.inputs.map(liveRegistryInput);
  const file = path.join(input.outputDir, "screening-bundle.json");
  const bundle = JSON.parse(await readFile(file, "utf8")) as {
    engineIdentity: ScreeningEngineIdentity;
    result: AnalysisResult;
    config: ScoringConfig;
    run: { id: string; kind: string };
    summary: Record<string, unknown>;
    data: {
      asOfDate: string;
      sources: Array<{ id: string; fileHash: string; dataHash: string; schemaHash: string }>;
    };
  };
  assertScreeningEngineIdentity(bundle.engineIdentity);
  const verifiedEngine = await verifiedCalculationEngineIdentity();
  if (bundle.engineIdentity.codeHash !== verifiedEngine.codeHash)
    throw new Error(
      "Calculated engine differs from publishing engine; recalculate without relabelling the bundle",
    );
  if (bundle.run.kind !== "SCREENING" || !bundle.result.asOfDate)
    throw new Error("Missing calculated Drive result");
  const sourceIdentity = (s: {
    id: string;
    fileHash: string;
    dataHash: string;
    schemaHash: string;
  }) => ({ id: s.id, fileHash: s.fileHash, dataHash: s.dataHash, schemaHash: s.schemaHash });
  if (
    bundle.data.asOfDate !== bundle.result.asOfDate ||
    stableCacheJson(bundle.data.sources.map(sourceIdentity)) !==
      stableCacheJson(inputs.map(sourceIdentity))
  )
    throw new Error("Saved calculation and verified input identities differ");
  const live = await listSourceRecords(client, owner, "screening");
  const registered = inputs.filter((i) => i.sourceRecord?.storage_bucket !== "google-drive");
  const op = savedOperationalIdentity(bundle.result);
  const baseline = inputFingerprint(registered, bundle.config, op);
  const liveInputs = live.map((sourceRecord) => ({ sourceRecord })) as LoadedSourceInput[];
  if (inputFingerprint(liveInputs, bundle.config, op) !== baseline)
    throw new Error("게시 중 기준 원천이 변경됐습니다. 다시 실행해 주세요.");
  const head = await maybeDriveHead(client, owner);
  if ((head ? sha256(stableCacheJson(head)) : null) !== input.expectedHeadHash)
    throw new Error("Drive 게시 이력이 갱신됐습니다. 새 이력으로 다시 실행해 주세요.");
  if (head) {
    await drivePublicationSources(
      head.drivePublication,
      live,
      baseline,
      head.drivePublication.asOfDate,
      head.drivePublication.phase,
    );
    const count = head.drivePublication.sources.length;
    const carried = await carryPublishedParentContracts(
      head.drivePublication,
      input.sources.slice(0, count),
      inputs,
    );
    input.sources = [...carried, ...input.sources.slice(count)];
  }
  const actual = inputs.flatMap((i) => (i.sourceRecord ? [i.sourceRecord] : []));
  const verifiedPhase = classifyKrScreeningPublication(actual, bundle.result.asOfDate).phase;
  if (krResultPhase(bundle.result) !== verifiedPhase)
    throw new Error("Calculated result phase differs from verified source contracts");
  const proof: DriveResultPublication = {
    version: "drive-result-publication-v1",
    baseFingerprint: baseline,
    asOfDate: bundle.result.asOfDate,
    phase: verifiedPhase,
    sources: input.sources,
  };
  const combined = await drivePublicationSources(
    proof,
    live,
    baseline,
    proof.asOfDate,
    proof.phase,
  );
  const expected = inputFingerprint(
    combined.map((sourceRecord) => ({ sourceRecord })) as LoadedSourceInput[],
    bundle.config,
    op,
  );
  if (expected !== inputFingerprint(inputs, bundle.config, op) || combined.length !== actual.length)
    throw new Error("Calculated inputs differ from Drive publication evidence");
  let latest: ExistingScreeningCache | null;
  try {
    latest = await downloadJson(client, `${owner}/cache/screening/latest.json`);
  } catch (error) {
    if (error instanceof Error && /Object not found|not_found|404/i.test(error.message))
      latest = null;
    else throw error;
  }
  if (
    head &&
    (!latest?.inputFingerprint ||
      !latest.resultDigest ||
      !currentDriveGeneration(head, {
        ...latest,
        inputFingerprint: latest.inputFingerprint,
        resultDigest: latest.resultDigest,
        drivePublication: latest.payload?.source?.drivePublication,
      }))
  )
    throw new Error(
      "Drive head and predecessor cache generation differ; recover before publication",
    );
  const old = latest?.payload?.analysis;
  if (
    old &&
    (old.asOfDate > bundle.result.asOfDate ||
      (old.asOfDate === bundle.result.asOfDate &&
        krResultPhase(old) === "FINAL" &&
        proof.phase === "PRELIMINARY"))
  )
    throw new Error("현재 홈페이지의 최신·확정 결과를 덮어쓸 수 없습니다.");
  // This bounded metadata head retains prior Drive deltas without copying their CSV bytes.
  // Complete all cache guards before head mutation. Multi-object storage is not atomic.
  const generationId = crypto.randomUUID();
  const next = {
    version: "drive-input-head-v1",
    engineIdentity: bundle.engineIdentity,
    drivePublication: proof,
    publicationId: generationId,
    inputFingerprint: expected,
    resultDigest: sha256(stableCacheJson(deterministicAnalysis(bundle.result))),
  };
  const cacheInput = {
    client,
    userId: owner,
    inputs,
    config: bundle.config,
    analysis: bundle.result,
    engineIdentity: bundle.engineIdentity,
    snapshot: buildSnapshot(bundle.result, undefined, bundle.run.id),
    previous: null,
    resultOnly: proof,
    generationId,
  };
  const publishCaches = await preflightWebScreeningCaches(cacheInput);
  const prewriteSources = await listSourceRecords(client, owner, "screening");
  if (
    inputFingerprint(
      prewriteSources.map((sourceRecord) => ({ sourceRecord })) as LoadedSourceInput[],
      bundle.config,
      op,
    ) !== baseline
  )
    throw new Error("Publication source registry changed during preflight");
  // Recheck the checkpoint after preflight reads and before the first write.
  if (stableCacheJson(await maybeDriveHead(client, owner)) !== stableCacheJson(head))
    throw new Error("Drive publication head changed during preflight");
  await uploadJson(client, `${owner}/${DRIVE_INPUT_HEAD}`, next);
  if (stableCacheJson(await maybeDriveHead(client, owner)) !== stableCacheJson(next))
    throw new Error("Drive input head readback mismatch");
  const published = await publishCaches();
  const dashboard = await downloadJson<{
    publicationId: string;
    engineIdentity: ScreeningEngineIdentity;
    inputFingerprint: string;
    resultDigest: string;
    drivePublication?: DriveResultPublication;
  }>(client, `${owner}/cache/dashboard/latest.json`);
  if (
    dashboard.publicationId !== generationId ||
    stableCacheJson(dashboard.engineIdentity) !== stableCacheJson(bundle.engineIdentity) ||
    dashboard.inputFingerprint !== published.inputFingerprint ||
    dashboard.resultDigest !== published.resultDigest ||
    stableCacheJson(dashboard.drivePublication) !== stableCacheJson(proof)
  )
    throw new Error("Drive dashboard readback mismatch");
  const resultPath = `${owner}/results/screening/${bundle.run.id}.json`;
  await uploadScreeningJsonFile(client, resultPath, file);
  await uploadJson(client, `${owner}/results/screening/latest.json`, {
    run: bundle.run,
    resultPath,
    summary: bundle.summary,
    publication: { kind: "DRIVE_RESULTS_ONLY", ...published },
  });
  const current = await listSourceRecords(client, owner, "screening");
  if (
    inputFingerprint(
      current.map((sourceRecord) => ({ sourceRecord })) as LoadedSourceInput[],
      bundle.config,
      op,
    ) !== baseline
  )
    throw new Error("게시 확인 중 원천이 변경됐습니다. 최신 자료로 다시 실행해 주세요.");
  const receipt = {
    version: "drive-result-receipt-v1",
    ...published,
    date: proof.asOfDate,
    phase: proof.phase,
    sourceUploads: 0,
    sourceRegistryWrites: 0,
    financialHistoryWrites: 0,
    rows: bundle.result.rows.length,
    resultPath,
  };
  const receiptPath = `${owner}/results/drive-screening/receipts/${bundle.run.id}.json`;
  await uploadJson(client, receiptPath, receipt);
  if (stableCacheJson(await downloadJson(client, receiptPath)) !== stableCacheJson(receipt))
    throw new Error("Drive publication receipt readback mismatch");
  return receipt;
}
