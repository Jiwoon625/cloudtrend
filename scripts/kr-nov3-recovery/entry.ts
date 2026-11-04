/* eslint-disable @typescript-eslint/no-explicit-any -- owner-private hash-bound capture */
/** Credential-free companion compute. No authenticated transports or network imports. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { visitDelimitedRows } from "../../src/lib/sourceData";
import path from "node:path";
import type { MarketDataset } from "../../src/lib/engine/dataset";
import type { ScoringConfig } from "../../src/lib/engine/scoring";
import { hashSeriesValue, type SeriesHash } from "../../src/lib/ledger/modelSeries";
import {
  verifyKrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApprovalV2,
} from "../../src/lib/ledger/krSourceVintage";
import {
  classifyKrScreeningPublication,
  krSourcePublication,
  unresolvedKrPendingSources,
} from "../../src/lib/krScreeningPublication";
import {
  encodeFinalCapture,
  captureCanonicalChunks,
  captureCanonicalProof,
} from "../kr-final-retrospective/capture-codec";
import type { FinalCapture, FinalCaptureV1 } from "../kr-final-retrospective/contracts";
import { check, same, KINDS, PREDECESSOR, DATES, prepareKrNov3Recovery } from "./core";
import { krNov3ApprovalCandidate } from "./apply";
import octoberRuntime from "../../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import kospiRuntime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";
const admittedRuntimeHashes = {
  october: octoberRuntime.codeHash as SeriesHash,
  kospi: kospiRuntime.codeHash as SeriesHash,
};
export function vintageFromCapturedRows(
  rows: any[],
  owner: string,
): KrSourceVintagePrivateApprovalV2 {
  check(
    Array.isArray(rows) &&
      rows.length > 0 &&
      rows.every(
        (r) =>
          r.user_id === owner &&
          r.market === "KR" &&
          ["reviewed-kr-vintage-v1", "reviewed-kr-vintage-v2"].includes(r.strategy_version),
      ),
    "VINTAGE_ROWS",
  );
  const read = (key: string, id: string) => {
    const values = rows
      .filter((r) => r.strategy_version === id && r.details?.[key]?.reviewId === id)
      .map((r) => r.details[key]);
    check(
      values.length > 0 && values.every((v) => same(v, values[0])),
      "VINTAGE_AUTHORITY_CONFLICT",
    );
    return values[0];
  };
  return {
    registry: read("krSourceVintageApproval", "reviewed-kr-vintage-v2"),
    receipt: read("krSourceVintageReview", "reviewed-kr-vintage-v2"),
    predecessor: {
      registry: read("krSourceVintageApproval", "reviewed-kr-vintage-v1"),
      receipt: read("krSourceVintageReview", "reviewed-kr-vintage-v1"),
    },
  };
}
/** c is the KOSPI transport's authenticated capture. Dataset is already validated
 * from the exact pinned local bytes by that capture's credential-free compute step. */
export async function buildKrCompanionCapture(
  c: any,
  dataset: MarketDataset,
  config: ScoringConfig,
): Promise<FinalCapture> {
  check(
    c.version === "kospi-nov3-readonly-capture-v1" &&
      typeof c.owner === "string" &&
      typeof c.codeVersion === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(c.owner) &&
      /^[a-f0-9]{40}$/.test(c.codeVersion) &&
      c.historicalAvailabilityClaim === false,
    "SHARED_CAPTURE_IDENTITY",
  );
  check(
    c.sourceRows.length === 47 &&
      c.capturedObjects.length === 25 &&
      c.sourceObjectPins.length === 47 &&
      c.generationPins.length === 25 &&
      same(c.sourceRows, c.baseline.sources),
    "SHARED_CAPTURE_INVENTORY",
  );
  for (const key of ["models", "registries"])
    check(
      Array.isArray(c.baseline[key]) && c.baseline[key].every((r: any) => r.user_id === c.owner),
      "BASELINE_OWNER",
    );
  check(
    c.baseline.actual &&
      Object.values(c.baseline.actual).every(
        (rows: any) => Array.isArray(rows) && rows.every((r: any) => r.user_id === c.owner),
      ),
    "ACTUAL_OWNER",
  );
  const publication = classifyKrScreeningPublication(c.sourceRows);
  check(
    same(publication, c.publication) &&
      publication.phase === "FINAL" &&
      publication.asOfDate === DATES[0] &&
      dataset.isLive === true &&
      dataset.asOfDate === DATES[0] &&
      unresolvedKrPendingSources(c.sourceRows).length === 0,
    "FINAL_PUBLICATION",
  );
  const sourceObjects = c.sourceRows.map((r: any) => {
    const pins = c.sourceObjectPins.filter((p: any) => p.path === r.storage_path);
    check(
      r.user_id === c.owner &&
        r.storage_bucket === "cloudtrend-data" &&
        r.storage_path.startsWith(c.owner + "/source/screening/") &&
        pins.length === 1 &&
        pins[0].hash === r.file_hash,
      "SOURCE_OBJECT_BINDING",
    );
    return {
      id: r.id,
      path: pins[0].path,
      storedHash: pins[0].hash,
      generation: pins[0].generation,
    };
  });
  const predecessors: FinalCaptureV1["predecessors"] = [];
  for (const kind of KINDS) {
    const rows = c.baseline.registries.filter(
      (r: any) => r.series_id === "adopted-shadow-2026-10-12-v1:" + kind,
    );
    check(rows.length === 1 && rows[0].payload.policy.kind === kind, "FIVE_SERIES");
    const sessions = c.baseline.models
      .filter((r: any) => r.series_id === rows[0].series_id)
      .sort((a: any, b: any) => a.session_date.localeCompare(b.session_date));
    const last = sessions.at(-1);
    check(
      last?.session_date === PREDECESSOR &&
        last.payload.receipt.date === PREDECESSOR &&
        last.payload.stateHash === last.state_hash &&
        last.payload.bookId === rows[0].series_id,
      "EXACT_PREDECESSOR",
    );
    predecessors.push({
      series: rows[0].payload,
      run: last.payload,
      payloadHash: await hashSeriesValue(last.payload),
    });
  }
  check(Array.isArray(c.archiveRows) && Array.isArray(c.preparedRows), "CAPTURED_ARTIFACTS");
  const archives: FinalCaptureV1["archives"] = [];
  for (const row of [...c.archiveRows, ...c.preparedRows]) {
    check(
      row.user_id === c.owner &&
        row.source_revision === "1" &&
        (await hashSeriesValue(row.payload)) === row.source_hash,
      "ARTIFACT_HASH_OWNER",
    );
  }
  for (const row of c.archiveRows) {
    check(
      row.source_id === `october-input:KR:${row.payload.date}:${row.source_hash.slice(7)}`,
      "ARCHIVE_IDENTITY",
    );
    archives.push({ hash: row.source_hash, payload: row.payload });
  }
  const sourceVintageApproval = vintageFromCapturedRows(c.vintageRows, c.owner);
  await verifyKrSourceVintagePrivateApproval(sourceVintageApproval);
  const legacyObjects: FinalCaptureV1["legacyObjects"] = {};
  for (const item of c.capturedObjects) {
    check(
      item.path.startsWith(c.owner + "/shadow/kospi-confirm1-bear-rsaccel-v1/") &&
        !Object.hasOwn(legacyObjects, item.path) &&
        (await hashSeriesValue(item.payload)) === item.hash &&
        c.generationPins.filter((pin: any) => pin.path === item.path && pin.hash === item.hash)
          .length === 1,
      "CAPTURED_KOSPI_OBJECT",
    );
    legacyObjects[item.path] = { hash: item.hash, payload: item.payload };
  }
  const activatedAt = c.sourceRows
    .filter((r: any) => {
      const p = krSourcePublication(r);
      return p?.phase === "FINAL" && p.asOfDate === DATES[0];
    })
    .map((r: any) => r.activated_at ?? r.created_at)
    .sort()
    .at(-1);
  check(
    Number.isFinite(Date.parse(c.capturedAt)) &&
      Number.isFinite(Date.parse(activatedAt)) &&
      Date.parse(c.capturedAt) >= Date.parse(activatedAt),
    "CAPTURE_CLOCK",
  );
  for (const role of ["plan", "approval", "completion"])
    check(
      c.priorRecovery?.[role]?.hash === captureCanonicalProof(c.priorRecovery[role].payload).hash,
      "NOVEMBER_LINEAGE_HASH",
    );
  return encodeFinalCapture({
    version: "kr-final-retrospective-capture-v1",
    owner: c.owner,
    codeCommit: c.codeVersion,
    runtimeHashes: admittedRuntimeHashes,
    capturedAt: c.capturedAt,
    computedAt: new Date().toISOString(),
    sourceManifest: c.sourceRows,
    captureManifest: {
      version: "kr-nov3-shared-capture-manifest-v1",
      sharedCaptureHash: captureCanonicalProof(c).hash,
      sourceObjects,
      legacy: c.generationPins,
      novemberLineage: {
        version: "kr-nov3-november-lineage-pins-v1",
        planHash: c.priorRecovery.plan.hash,
        approvalHash: c.priorRecovery.approval.hash,
        completionHash: c.priorRecovery.completion.hash,
      },
      unisonRawEvidence: c.unisonRawEvidence,
    },
    preservationBaseline: {
      ...c.baseline,
      archiveRows: c.archiveRows,
      preparedRows: c.preparedRows,
      vintageRows: c.vintageRows,
    },
    finalPublication: {
      hash: await hashSeriesValue(publication),
      activatedAt,
      asOfDate: DATES[0]!,
    },
    dataset,
    config,
    sourceVintageApproval,
    predecessors,
    archives,
    legacyObjects,
  });
}

export function extractUnisonRawEvidence(c: any, canonicalCsv: string) {
  const candidates = c.sourceRows.filter((r: any) => {
    const p = krSourcePublication(r);
    return p?.phase === "FINAL" && p.asOfDate === DATES[0];
  });
  const row = candidates.at(-1),
    pin = c.sourceObjectPins.find((p: any) => p.path === row?.storage_path);
  check(
    row &&
      pin &&
      same(row, c.selectedFinalSourceRow) &&
      same(pin, c.selectedFinalSourcePin) &&
      pin.hash === row.file_hash,
    "SELECTED_RAW_SOURCE",
  );
  const validated = (c.sourceObjects ?? []).filter(
    (x: any) =>
      x.id === row.id &&
      x.path === row.storage_path &&
      x.storedHash === row.file_hash &&
      same(x.generation, pin.generation),
  );
  check(
    validated.length === 1 &&
      validated[0].canonicalHash ===
        "sha256:" + createHash("sha256").update(canonicalCsv).digest("hex"),
    "RAW_CANONICAL_HASH",
  );
  const expected = ["2026-10-12", "2026-10-13", "2026-10-14"];
  let columns: string[] = [];
  const rows: Array<{
    date: string;
    symbol: string;
    shortSellingVolume: number;
    tradingValueSource: string;
    investorValueSource: string;
  }> = [];
  visitDelimitedRows(canonicalCsv, (cells, index) => {
    if (index === 0) {
      columns = cells;
      for (const name of [
        "symbol",
        "date",
        "shortSellingVolume",
        "tradingValueSource",
        "investorValueSource",
      ])
        check(columns.filter((c) => c === name).length === 1, "RAW_EVIDENCE_COLUMNS");
      return;
    }
    const get = (key: string) => cells[columns.indexOf(key)];
    if (get("symbol") !== "018000" || !expected.includes(get("date"))) return;
    const n = get("shortSellingVolume");
    check(/^\d+$/.test(n) && Number.isSafeInteger(Number(n)), "RAW_SHORT_VOLUME");
    rows.push({
      date: get("date"),
      symbol: "018000",
      shortSellingVolume: Number(n),
      tradingValueSource: get("tradingValueSource"),
      investorValueSource: get("investorValueSource"),
    });
  });
  rows.sort((a, b) => a.date.localeCompare(b.date));
  check(
    same(
      rows.map((r) => r.date),
      expected,
    ),
    "RAW_EVIDENCE_DATES",
  );
  return { sourceId: row.id, sourceHash: row.file_hash, rows };
}
export function saveKrPrivate(file: string, value: unknown) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    for (const chunk of captureCanonicalChunks(value)) fs.writeFileSync(fd, chunk);
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}
/** Runs even if the independently computed KOSPI proof is blocked. */
export async function computeKrCompanion(
  c: any,
  dataset: MarketDataset,
  config: ScoringConfig,
  outputDir: string,
  selectedFinalCanonicalCsv?: string,
) {
  check(path.isAbsolute(outputDir), "PRIVATE_OUTPUT_PATH");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);
  check(typeof selectedFinalCanonicalCsv === "string", "RAW_EVIDENCE_REQUIRED");
  const enriched = {
    ...c,
    unisonRawEvidence: extractUnisonRawEvidence(c, selectedFinalCanonicalCsv),
  };
  const captured = await buildKrCompanionCapture(enriched, dataset, config);
  saveKrPrivate(path.join(outputDir, "capture.json"), captured);
  let plan;
  const stages = new Set([
    "HYDRATE",
    "IDENTITY",
    "RUNTIME",
    "SOURCE_AUTHORITY",
    "CAPTURE_HASHES",
    "ANALYZE_NOV3",
    "SNAPSHOTS",
    "DATE_PROOFS",
    "RETROSPECTIVE_AUTHORITY",
    "ARCHIVE_VERIFY",
    "PREDECESSOR_MEMORY",
    "PRIOR_ANALYSIS",
    "ADOPTED_NOV3",
    "PREFIX_CHECK",
    ...Array.from({ length: 5 }, (_, i) => `MODEL_READ_${i}`),
    ...Array.from({ length: 5 }, (_, i) => `MODEL_APPEND_${i}`),
  ]);
  let stage = "HYDRATE";
  try {
    plan = await prepareKrNov3Recovery(captured, (next) => {
      check(stages.has(next), "DIAGNOSTIC_STAGE");
      stage = next;
    });
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error instanceof RangeError ||
      error instanceof TypeError ||
      error instanceof SyntaxError
    )
      throw error;
    const diagnosis = {
      version: "kr-nov3-recovery-blocked-v1",
      owner: captured.owner,
      codeCommit: captured.codeCommit,
      captureHash: captureCanonicalProof(captured).hash,
      status: "BLOCKED",
      stage,
      operationalApproval: false,
      historicalAvailabilityClaim: false,
    };
    saveKrPrivate(path.join(outputDir, "diagnosis.json"), diagnosis);
    return {
      status: "KR_PLAN_BLOCKED",
      stage,
      diagnosisHash: captureCanonicalProof(diagnosis).hash,
      captureHash: diagnosis.captureHash,
      operationalApproval: false,
      historicalAvailabilityClaim: false,
    };
  }
  saveKrPrivate(path.join(outputDir, "plan.json"), plan);
  const approvalCandidate = await krNov3ApprovalCandidate(plan);
  saveKrPrivate(path.join(outputDir, "approval-candidate.json"), approvalCandidate);
  return {
    status: "KR_PLAN_COMPUTED_REVIEW_REQUIRED",
    planHash: captureCanonicalProof(plan).hash,
    approvalCandidateHash: captureCanonicalProof(approvalCandidate).hash,
    captureHash: plan.captureHash,
    expectedNewModelSessions: 5,
    operationalApproval: false,
    historicalAvailabilityClaim: false,
  };
}

/** Reproduce only from the authenticated stored capture. Its original computation
 * clock is retained, so no later wall clock can change the approved outputs. */
export async function reproduceKrNov3Plan(directory: string) {
  check(path.isAbsolute(directory), "REPRODUCTION_DIRECTORY");
  const capture = JSON.parse(
    fs.readFileSync(path.join(directory, "capture.json"), "utf8"),
  ) as FinalCapture;
  const plan = JSON.parse(fs.readFileSync(path.join(directory, "plan.json"), "utf8"));
  const pins = JSON.parse(fs.readFileSync(path.join(directory, "pins.json"), "utf8"));
  check(
    pins.version === "kr-nov3-reproduction-pins-v1" &&
      captureCanonicalProof(capture).hash === pins.captureHash &&
      captureCanonicalProof(plan).hash === pins.planHash &&
      plan.captureHash === pins.captureHash &&
      capture.owner === pins.owner &&
      capture.codeCommit === pins.codeCommit,
    "REPRODUCTION_PINS",
  );
  const actual = await prepareKrNov3Recovery(capture);
  check(captureCanonicalProof(actual).hash === pins.planHash, "DETERMINISTIC_REPRODUCTION");
  const result = {
    version: "kr-nov3-reproduction-proof-v1",
    status: "REPRODUCED",
    captureHash: pins.captureHash,
    planHash: pins.planHash,
  };
  saveKrPrivate(path.join(directory, "proof.json"), result);
  return result;
}
if (process.argv[2] === "kr-reproduce") {
  globalThis.fetch = async () => {
    throw Error("KR_NOV3_PURE_NO_NETWORK");
  };
  reproduceKrNov3Plan(process.argv[3] ?? "")
    .then(() => {
      console.log(JSON.stringify({ status: "KR_NOV3_PLAN_REPRODUCED" }));
    })
    .catch(() => {
      console.error(JSON.stringify({ status: "KR_NOV3_PURE_REPRODUCTION_REJECTED" }));
      process.exitCode = 1;
    });
}
