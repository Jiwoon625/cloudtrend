/* eslint-disable @typescript-eslint/no-explicit-any -- owner-private hashed capture */
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import {
  captureCanonicalChunks,
  captureCanonicalProof,
} from "../kr-final-retrospective/capture-codec";
import { validateSourceBytes, SOURCE_MAX_FILE_BYTES } from "../../src/lib/sourceData";
import { parseManualMarketDataWithReferences } from "../../src/lib/krxReviewReferenceParser";
import {
  krSourcePublication,
  unresolvedKrPendingSources,
} from "../../src/lib/krScreeningPublication";
import { buildKospiShadowSession } from "../../src/lib/engine/kospiShadowDataset";
import { DEFAULT_SCORING_CONFIG } from "../../src/lib/engine/scoring";
import { computeKrCompanion } from "../kr-nov3-recovery/entry";
import { prepareNov3Recovery } from "./core";
import runtime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
const H = (v: unknown) => captureCanonicalProof(v).hash;
const raw = (v: Uint8Array | string) => "sha256:" + createHash("sha256").update(v).digest("hex");
const need = (v: unknown) => {
  if (!v) throw Error("NOV3_CAPTURE_REJECTED");
};
export const NOV3_PRIOR_REFS = {
  capsuleHash: "sha256:7b4f3d5a2984e4091b7d6a01211ade5d8877c3f1f737b3d1030848845f4ccfcc",
  planHash: "sha256:aafc077261a8679574f7abce520516dea36efe835da0d75a789dcb4adba05057",
  approvalHash: "sha256:c32a5bd7cfaca0e04612d2f7dc53736e7f676ee43c7b2d7373bfb0ef5e045f9a",
  completionHash: "sha256:b12096b28b1923b0159f9a6fe8c312ff3dbbc56b131ae484e9ca39052ee45f55",
};
export function savePrivate(file: string, value: unknown) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    for (const b of captureCanonicalChunks(value)) fs.writeSync(fd, b);
  } finally {
    fs.closeSync(fd);
  }
}
/** Run in a separate process with no credentials and network disabled. */
export async function computeNov3Capture(dir: string) {
  const c = JSON.parse(fs.readFileSync(path.join(dir, "capture.json"), "utf8"));
  need(c.version === "kospi-nov3-readonly-capture-v1");
  need(Array.isArray(c.sourceRows) && c.sourceRows.length > 0 && c.sourceRows.length <= 128);
  const texts: string[] = [];
  const sourceObjects: any[] = [];
  for (const r of c.sourceRows) {
    need(
      /^[a-f0-9-]{36}$/.test(r.id) &&
        r.user_id === c.owner &&
        r.storage_bucket === "cloudtrend-data" &&
        r.storage_path.startsWith(c.owner + "/source/screening/"),
    );
    let bytes = fs.readFileSync(path.join(dir, "sources", r.id));
    need(raw(bytes) === r.file_hash);
    const gzip = r.canonical_format === "csv.gz" || r.storage_path.endsWith(".gz");
    if (gzip) bytes = gunzipSync(bytes, { maxOutputLength: SOURCE_MAX_FILE_BYTES });
    const v = await validateSourceBytes({
      bytes,
      filename: r.original_filename.replace(/\.gz$/i, ""),
      contentType: gzip ? "text/csv" : r.content_type,
      streamingCsv: true,
    });
    need(
      v.valid &&
        v.dataHash === r.data_hash &&
        v.schemaHash === r.schema_hash &&
        v.stats.rowCount === Number(r.row_count) &&
        v.stats.minDate === r.min_date &&
        v.stats.maxDate === r.max_date,
    );
    sourceObjects.push({
      id: r.id,
      path: r.storage_path,
      generation: c.sourceObjectPins.find((pin: any) => pin.path === r.storage_path).generation,
      storedHash: r.file_hash,
      logicalHash: raw(bytes),
      canonicalHash: raw(v.canonicalCsv),
    });
    texts.push(v.canonicalCsv);
  }
  for (const [i, r] of c.sourceRows.entries()) {
    const p = krSourcePublication(r);
    if (p) need(raw(p.manifestText) === p.manifestSha256);
    if (!p || p.phase !== "PRELIMINARY" || unresolvedKrPendingSources(c.sourceRows).includes(r))
      need(!/PENDING_PUBLICATION|KRX_PENDING|KRX_PUBLICATION_PENDING/i.test(texts[i]));
  }
  const dataset = parseManualMarketDataWithReferences(texts).dataset;
  need(dataset.asOfDate === "2026-11-03");
  const datasetHash = H(dataset),
    sourceHash = raw(
      c.sourceRows
        .map((r: any) => r.data_hash)
        .sort()
        .join("\n"),
    );
  const sourceCollectedAt = c.sourceRows
    .filter((r: any) => {
      const p = krSourcePublication(r);
      return p?.phase === "FINAL" && p.asOfDate === "2026-11-03";
    })
    .map((r: any) => r.activated_at ?? r.created_at)
    .sort((a: string, b: string) => Date.parse(a) - Date.parse(b))
    .at(-1);
  need(Number.isFinite(Date.parse(sourceCollectedAt)));
  const root = `${c.owner}/shadow/kospi-confirm1-bear-rsaccel-v1/revisions/october14-retrospective-v1`;
  const view = c.capturedObjects.find((x: any) => x.path === root + "/latest.json").payload;
  const manifest = {
    version: c.version,
    owner: c.owner,
    sourceRowsHash: H(c.sourceRows),
    sourceObjectPinsHash: H(c.sourceObjectPins),
    journalHash: H(c.capturedObjects),
    generationPinsHash: H(c.generationPins),
    datasetHash,
    capturedAt: c.capturedAt,
    publication: c.publication,
    historicalAvailabilityClaim: false,
  };
  const authority = {
    owner: c.owner,
    predecessorDate: "2026-11-02",
    targetDates: ["2026-11-03"],
    baselineSourceHash: sourceHash,
    adjustedBasisHash: datasetHash,
    sourceManifestHash: H(c.sourceRows),
    captureManifestHash: H(manifest),
    baselineCollectedAt: sourceCollectedAt,
    adjustedCapturedAt: c.capturedAt,
    computedAt: new Date().toISOString(),
    codeVersion: c.codeVersion,
    runtimeCodeHash: runtime.codeHash,
  };
  const build = (date: string) =>
    buildKospiShadowSession(
      dataset,
      DEFAULT_SCORING_CONFIG,
      {
        sourceHash,
        configHash: view.registry.configHash,
        codeVersion: c.codeVersion,
        sourceCollectedAt,
        now: authority.computedAt,
      },
      date,
    );
  const baselineSession = build("2026-11-02"),
    adjustedSession = {
      ...baselineSession,
      sourceHash: datasetHash,
      sourceCollectedAt: c.capturedAt,
    };
  const target = {
    ...build("2026-11-03"),
    sourceHash: datasetHash,
    sourceCollectedAt: c.capturedAt,
    lateRecovery: {
      version: "kospi-final-retrospective-v1",
      historicalAvailabilityClaim: false,
      retrospective: true,
      sourceDataAsOf: "2026-11-03",
      sourceCollectedAt,
      captureObservedAt: c.capturedAt,
      computedAt: authority.computedAt,
      sourceManifestHash: authority.sourceManifestHash,
      captureManifestHash: authority.captureManifestHash,
      adjustedBasisHash: datasetHash,
      runtimeCodeHash: runtime.codeHash,
      predecessorDate: authority.predecessorDate,
      predecessorHash: H(view.latest),
    },
  };
  const input = {
    authority,
    baselineSession,
    adjustedSession,
    targetSessions: [target],
    capturedObjects: c.capturedObjects,
    generationPins: c.generationPins,
    priorRecovery: c.priorRecovery,
  };
  const result = await prepareNov3Recovery(input);
  const receipt = {
    version: "kospi-nov3-recovery-preparation-v1",
    kind: "RECOVERY_PREPARATION_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    input,
    result,
  };
  savePrivate(path.join(dir, "receipt.json"), receipt);
  const { priorRecovery: _prior, ...compact } = input;
  void _prior;
  const capsule = {
    version: "kospi-nov3-recovery-capsule-v1",
    owner: c.owner,
    sourceRows: c.sourceRows,
    sourceObjectPins: c.sourceObjectPins,
    input: compact,
    priorRecoveryRefs: NOV3_PRIOR_REFS,
    result,
    materialization: manifest,
  };
  const selectedFinalIndex = c.sourceRows.findLastIndex((r: any) => {
    const p = krSourcePublication(r);
    return p?.phase === "FINAL" && p.asOfDate === "2026-11-03";
  });
  need(selectedFinalIndex >= 0);
  const selectedFinalSourceRow = c.sourceRows[selectedFinalIndex];
  const companion = await computeKrCompanion(
    {
      ...c,
      sourceObjects,
      selectedFinalSourceRow,
      selectedFinalSourcePin: c.sourceObjectPins.find(
        (pin: any) => pin.path === selectedFinalSourceRow.storage_path,
      ),
    },
    dataset,
    DEFAULT_SCORING_CONFIG,
    path.join(path.dirname(dir), "kr-nov3-private"),
    texts[selectedFinalIndex],
  );
  savePrivate(path.join(dir, "companion-status.json"), companion);
  if (result.status !== "PROVEN_NOV3_RETROSPECTIVE_CONTINUATION")
    return {
      status: "BLOCKED",
      blockedAt: result.blockedAt,
      checks: result.checks,
      historicalAvailabilityClaim: false,
    };
  savePrivate(path.join(dir, "capsule.json"), capsule);
  return {
    status: "PREPARED",
    capsuleHash: H(capsule),
    preparationHash: H(receipt),
    planHash: result.planHash,
    historicalAvailabilityClaim: false,
  };
}
