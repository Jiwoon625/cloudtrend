/* eslint-disable @typescript-eslint/no-explicit-any -- owner-private captured rows are hash-bound */
/** Reuse one authenticated source capture. No second raw-source download. */
import type { SupabaseClient } from "@supabase/supabase-js";
import { hashSeriesValue, type SeriesHash } from "../../src/lib/ledger/modelSeries";
import {
  verifyKrSourceVintagePrivateApproval,
  type KrSourceVintagePrivateApprovalV2,
  type KrSourceVintagePrivateApprovalV3,
} from "../../src/lib/ledger/krSourceVintage";
import { captureCanonicalProof } from "../kr-final-retrospective/capture-codec";
import type { FinalCapture } from "../kr-final-retrospective/contracts";
import {
  reader,
  assertCaptureFresh,
  readEvidence,
  appendEvidence,
  type Connection,
} from "../kr-final-retrospective/transport";
import { check, same, KINDS, PREDECESSOR, DATES, type KrNov3Plan } from "./core";
import { krNov3ApprovalCandidate, validateKrNov3Plan, type KrNov3Approval } from "./apply";
import octoberRuntime from "../../src/lib/ledger/octoberShadowEngineManifest.generated.json";
import kospiRuntime from "../../src/lib/kospiShadowPublicationRuntime.generated.json";

import { vintageFromCapturedRows, saveKrPrivate } from "./entry";

export const KR_NOV3_WORKFLOW = "KR November 3 reviewed recovery PLAN APPLY";
export function assertKrNov3Workflow(env: NodeJS.ProcessEnv = process.env, archiveOnly = false) {
  check(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      (env.GITHUB_WORKFLOW === KR_NOV3_WORKFLOW ||
        (archiveOnly && env.GITHUB_WORKFLOW === "KOSPI Nov3 reviewed recovery")) &&
      env.RECOVERY_CONCURRENCY_GROUP === "kospi-prospective-shadow" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? ""),
    "WORKFLOW_ADMISSION",
  );
}
export const admittedRuntimeHashes = {
  october: octoberRuntime.codeHash as SeriesHash,
  kospi: kospiRuntime.codeHash as SeriesHash,
};

/** Evidence uses the existing immutable, chunk-capable private execution envelope;
 * new version and owner checks make it independent of every earlier recovery. */
export async function readKrNov3Evidence(o: Connection, hash: string, version: string) {
  check(
    [
      "kr-nov3-recovery-plan-v1",
      "kr-nov3-recovery-approval-v1",
      "kr-nov3-recovery-capture-v1",
    ].includes(version),
    "EVIDENCE_VERSION",
  );
  const value = await readEvidence(o, "execution", hash);
  check(
    value.version === version && (value.owner ?? value.preparation?.owner) === o.owner,
    "EVIDENCE_OWNER_KIND",
  );
  return value;
}
export async function appendKrNov3Evidence(o: Connection, payload: any) {
  check(
    [
      "kr-nov3-recovery-plan-v1",
      "kr-nov3-recovery-approval-v1",
      "kr-nov3-recovery-capture-v1",
      "kr-nov3-recovery-execution-v1",
      "kr-nov3-recovery-completion-v1",
      "kr-nov3-recovery-blocked-v1",
    ].includes(payload.version) && (payload.owner ?? payload.preparation?.owner) === o.owner,
    "EVIDENCE_WRITE_SCOPE",
  );
  return appendEvidence(o, "execution", payload);
}
export async function assertKrNov3Fresh(o: Connection, p: KrNov3Plan) {
  const artifacts = await Promise.all([
    ...p.newArchives.map(async (payload) => {
      const hash = await hashSeriesValue(payload);
      return {
        source_id: `october-input:KR:${payload.date}:${hash.slice(7)}`,
        source_hash: hash,
        payload,
      };
    }),
    ...p.preparedPublications.map(async (payload) => ({
      source_id: `october-prepared:KR:${payload.date}`,
      source_hash: await hashSeriesValue(payload),
      payload,
    })),
  ]);
  const guard = {
    preservationBaseline: p.preparation.preservationBaseline,
    captureManifest: p.captureManifest,
  } as FinalCapture;
  await assertCaptureFresh(o, guard, p.newAdoptedSessions, {}, artifacts);
}
async function thirdRows(o: Connection) {
  return reader(o).rows(
    "shadow_replay_audit",
    { market: "eq.KR", strategy_version: "eq.reviewed-kr-vintage-v3" },
    129,
    "id.asc",
  );
}
export function assertExactThirdRows(
  rows: any[],
  candidate: KrSourceVintagePrivateApprovalV3,
  allowPartial: boolean,
) {
  const keys = ["krSourceVintageReview", "krSourceVintageApproval"] as const;
  check(rows.length <= 2, "V3_AUDIT_INVENTORY");
  const present = new Set<string>();
  for (const row of rows) {
    const k = keys.find((key) => same(Object.keys(row.details ?? {}), [key]));
    check(
      k &&
        !present.has(k) &&
        row.strategy_version === "reviewed-kr-vintage-v3" &&
        row.market === "KR" &&
        row.signal_date === DATES[0] &&
        row.replay_mode === "RETROSPECTIVE" &&
        row.model_available_at === null &&
        row.model_decision_at === null &&
        row.execution_at === null &&
        row.source_hash === captureCanonicalProof(k ? row.details[k] : null).hash &&
        same(
          row.details[k],
          k === "krSourceVintageApproval" ? candidate.registry : candidate.receipt,
        ),
      "V3_AUDIT_CONFLICT",
    );
    present.add(k);
  }
  check(allowPartial || present.size === 2, "V3_AUDIT_INCOMPLETE");
  return present;
}
export async function readStagedKrNov3Authority(o: Connection, p: KrNov3Plan) {
  const rows = await thirdRows(o);
  assertExactThirdRows(rows, p.vintageAuthorityCandidate, false);
  for (const row of rows)
    check(
      row.source_hash === (await hashSeriesValue(Object.values(row.details)[0])),
      "V3_AUDIT_HASH",
    );
  // Independently reread immutable v1/v2, rather than trusting a candidate's parent.
  const old = await reader(o).rows(
    "shadow_replay_audit",
    {
      market: "eq.KR",
      strategy_version: "in.(reviewed-kr-vintage-v1,reviewed-kr-vintage-v2)",
    },
    129,
    "id.asc",
  );
  const predecessor = vintageFromCapturedRows(old, o.owner);
  check(same(predecessor, p.sourceVintagePredecessor), "V3_PARENT_DRIFT");
  const result = {
    registry: rows.find((r) => r.details.krSourceVintageApproval)?.details.krSourceVintageApproval,
    receipt: rows.find((r) => r.details.krSourceVintageReview)?.details.krSourceVintageReview,
    predecessor,
  } as KrSourceVintagePrivateApprovalV3;
  await verifyKrSourceVintagePrivateApproval(result);
  return result;
}
/** Explicit separate authority action. Never called by compute, VALIDATE or APPLY. */
export async function stageKrNov3Authority(
  o: Connection,
  client: SupabaseClient,
  p: KrNov3Plan,
  a: KrNov3Approval,
  planHash: SeriesHash,
  approvalHash: SeriesHash,
  gate: () => Promise<void>,
) {
  check(
    (await hashSeriesValue(p)) === planHash &&
      (await hashSeriesValue(a)) === approvalHash &&
      same(a, await krNov3ApprovalCandidate(p)),
    "STAGING_APPROVAL",
  );
  await validateKrNov3Plan(p);
  await gate();
  const keys = ["krSourceVintageReview", "krSourceVintageApproval"] as const;
  for (const key of keys) {
    await gate();
    const rows = await thirdRows(o);
    const present = assertExactThirdRows(rows, p.vintageAuthorityCandidate, true);
    if (present.has(key)) continue;
    const value =
      key === "krSourceVintageApproval"
        ? p.vintageAuthorityCandidate.registry
        : p.vintageAuthorityCandidate.receipt;
    try {
      await client.from("shadow_replay_audit").insert({
        user_id: o.owner,
        market: "KR",
        signal_date: DATES[0],
        calculated_at: new Date().toISOString(),
        source_captured_at: p.preparation.capturedAt,
        model_available_at: null,
        model_decision_at: null,
        execution_at: null,
        replay_mode: "RETROSPECTIVE",
        status: "WAITING_INPUT",
        source_hash: await hashSeriesValue(value),
        strategy_version: "reviewed-kr-vintage-v3",
        reason:
          "Separately reviewed exact Unison five-to-one pairs; frozen execution prefix retained; no historical availability claim",
        details: { [key]: value },
      });
    } catch {
      /* One exact readback; no retry after an uncertain outcome. */
    }
    check(
      assertExactThirdRows(await thirdRows(o), p.vintageAuthorityCandidate, true).has(key),
      "V3_STAGE_READBACK",
    );
  }
  return readStagedKrNov3Authority(o, p);
}

/** Exact November predecessor lineage, read independently through official auth. */
export async function assertNovemberLineageFresh(o: Connection, manifest: any) {
  const refs = {
    capsuleHash: "sha256:7b4f3d5a2984e4091b7d6a01211ade5d8877c3f1f737b3d1030848845f4ccfcc",
    planHash: "sha256:aafc077261a8679574f7abce520516dea36efe835da0d75a789dcb4adba05057",
    approvalHash: "sha256:c32a5bd7cfaca0e04612d2f7dc53736e7f676ee43c7b2d7373bfb0ef5e045f9a",
    completionHash: "sha256:b12096b28b1923b0159f9a6fe8c312ff3dbbc56b131ae484e9ca39052ee45f55",
  };
  const c = await readEvidence(o, "execution", refs.capsuleHash);
  check(
    c.version === "kospi-november-recovery-capsule-v1" && c.owner === o.owner,
    "NOVEMBER_CAPSULE",
  );
  const old = c.priorRecoveryRefs;
  check(
    old.planHash === "sha256:2964685f4dcf1ea6d237c4101525458dae110260d85dea73185b45f7e12f02d9" &&
      old.approvalHash ===
        "sha256:cf64e1e10834278d23477f5643b5a5fde4e5f4cb69966e01c8ccb46598d5a6e5" &&
      old.completionHash ===
        "sha256:c2049440924da0dedf2a3de6459cf49e47eae878cf64fe928df7ce355f0072a6",
    "NOVEMBER_ANCESTOR_PINS",
  );
  const priorRecovery = {
    plan: { hash: old.planHash, payload: await readEvidence(o, "plan", old.planHash) },
    approval: {
      hash: old.approvalHash,
      payload: await readEvidence(o, "approval", old.approvalHash),
    },
    completion: {
      hash: old.completionHash,
      payload: await readEvidence(o, "completion", old.completionHash),
    },
  };
  const receipt = {
    version: "kospi-november-recovery-preparation-v1",
    kind: "RECOVERY_PREPARATION_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    input: { ...c.input, priorRecovery },
    result: c.result,
  };
  check(captureCanonicalProof(receipt).hash === refs.planHash, "NOVEMBER_RECEIPT_PIN");
  const current = {
    plan: { hash: refs.planHash, payload: receipt },
    approval: {
      hash: refs.approvalHash,
      payload: await readEvidence(o, "execution", refs.approvalHash),
    },
    completion: {
      hash: refs.completionHash,
      payload: await readEvidence(o, "execution", refs.completionHash),
    },
  };
  check(
    same(
      {
        version: "kr-nov3-november-lineage-pins-v1",
        planHash: captureCanonicalProof(current.plan.payload).hash,
        approvalHash: captureCanonicalProof(current.approval.payload).hash,
        completionHash: captureCanonicalProof(current.completion.payload).hash,
      },
      manifest.novemberLineage,
    ),
    "NOVEMBER_LINEAGE_DRIFT",
  );
}

/** A caller supplies a live RPC-backed store; no registry-initialization or foreign
 * book capability is exposed to the bounded executor. */
export function boundedKrNov3Store(
  store: import("../../src/lib/ledger/octoberShadowRepository.server").OctoberShadowStore,
  p: KrNov3Plan,
) {
  const books = new Set(p.predecessors.map((x) => x.series.bookId));
  const checkBook = (id: string) => check(books.has(id), "WRITER_BOOK_SCOPE");
  return {
    readKrInput: store.readKrInput,
    putKrInput: async (v: Parameters<typeof store.putKrInput>[0]) => {
      check(
        p.newArchives.some((x) => same(x, v)),
        "WRITER_ARCHIVE_SCOPE",
      );
      return store.putKrInput(v);
    },
    readPrepared: async (market: "KR" | "US", date: string) => {
      check(market === "KR" && date === DATES[0], "WRITER_PREPARED_READ_SCOPE");
      return store.readPrepared(market, date);
    },
    prepare: async (v: Parameters<typeof store.prepare>[0]) => {
      check(
        p.preparedPublications.some((x) => same(x, v)),
        "WRITER_PREPARED_SCOPE",
      );
      return store.prepare(v);
    },
    readSeries: async (id: string) => {
      checkBook(id);
      return store.readSeries(id);
    },
    insertSeries: async () => {
      throw Error("KR_NOV3_RECOVERY_REGISTRY_WRITE_FORBIDDEN");
    },
    readLatest: async <T extends import("../../src/lib/ledger/modelJournal").ModelJournalRun>(
      id: string,
    ) => {
      checkBook(id);
      return store.readLatest<T>(id);
    },
    readSession: async <T extends import("../../src/lib/ledger/modelJournal").ModelJournalRun>(
      id: string,
      date: string,
    ) => {
      checkBook(id);
      check(date === PREDECESSOR || date === DATES[0], "WRITER_DATE_SCOPE");
      return store.readSession<T>(id, date);
    },
    append: async <T extends import("../../src/lib/ledger/modelJournal").ModelJournalRun>(
      series: Parameters<typeof store.append>[0],
      run: T,
      previous: T | null,
    ) => {
      const e = p.preparedPublications[0]!.entries.find((x) => x.series.bookId === series.bookId);
      const prior = p.predecessors.find((x) => x.series.bookId === series.bookId);
      check(
        e && prior && same(e.series, series) && same(e.run, run) && same(prior.run, previous),
        "WRITER_APPEND_SCOPE",
      );
      return store.append(series, run, previous);
    },
  };
}

/** Separate credential-free subprocess, with a build-verified pure dependency graph. */
export async function reproduceStoredKrNov3Plan(
  capture: FinalCapture,
  plan: KrNov3Plan,
  root: string,
  owner: string,
  codeCommit: string,
) {
  const fs = await import("node:fs"),
    path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  check(path.isAbsolute(root), "REPRODUCTION_ROOT");
  const privateRoot = path.join(root, "kr-nov3-private");
  fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateRoot, 0o700);
  const dir = fs.mkdtempSync(path.join(privateRoot, "reproduce-"));
  fs.chmodSync(dir, 0o700);
  const pins = {
    version: "kr-nov3-reproduction-pins-v1",
    owner,
    codeCommit,
    captureHash: captureCanonicalProof(capture).hash,
    planHash: captureCanonicalProof(plan).hash,
  };
  try {
    saveKrPrivate(path.join(dir, "capture.json"), capture);
    saveKrPrivate(path.join(dir, "plan.json"), plan);
    saveKrPrivate(path.join(dir, "pins.json"), pins);
    const child = spawnSync(
      process.execPath,
      [path.join(root, "kospi-nov3-code/kr-pure.mjs"), "kr-reproduce", dir],
      {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: dir,
          TMPDIR: dir,
          NODE_OPTIONS: "--max-old-space-size=8192",
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 60 * 60 * 1000,
      },
    );
    check(child.status === 0 && !child.error, "PURE_REPRODUCTION_PROCESS");
    const proof = JSON.parse(fs.readFileSync(path.join(dir, "proof.json"), "utf8"));
    check(
      same(proof, {
        version: "kr-nov3-reproduction-proof-v1",
        status: "REPRODUCED",
        captureHash: pins.captureHash,
        planHash: pins.planHash,
      }),
      "PURE_REPRODUCTION_PROOF",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Authenticated official workflow entry. No auth values are printed or copied to files. */
export async function runKrNov3Command(mode: string, env: NodeJS.ProcessEnv = process.env) {
  const archiveOnly = mode === "archive-plan";
  assertKrNov3Workflow(env, archiveOnly);
  if (archiveOnly) mode = "kr-plan-evidence";
  const fs = await import("node:fs"),
    path = await import("node:path");
  const { trustedSupabaseClient } = await import("../analysis-run-store");
  const { octoberShadowStore } =
    await import("../../src/lib/ledger/octoberShadowRepository.server");
  const { applyKrNov3Recovery } = await import("./apply");
  const root = env.RUNNER_TEMP ?? "";
  check(path.isAbsolute(root), "RUNNER_PRIVATE_ROOT");
  const dir = path.join(root, "kr-nov3-private");
  const o: Connection = {
    origin: env.SUPABASE_URL ?? "",
    key: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    owner: env.SUPABASE_USER_ID ?? "",
  };
  const readLocal = (name: string) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
  const assertFresh = async (p: KrNov3Plan) => {
    assertKrNov3Workflow(env, archiveOnly);
    await assertKrNov3Fresh(o, p);
    await assertNovemberLineageFresh(o, p.captureManifest);
  };
  if (mode === "kr-plan-evidence") {
    if (fs.existsSync(path.join(dir, "diagnosis.json"))) {
      check(!fs.existsSync(path.join(dir, "plan.json")), "DIAGNOSIS_PLAN_COLLISION");
      const d = readLocal("diagnosis.json"),
        c = readLocal("capture.json") as FinalCapture;
      check(
        d.version === "kr-nov3-recovery-blocked-v1" &&
          d.status === "BLOCKED" &&
          d.owner === o.owner &&
          d.codeCommit === env.GITHUB_SHA &&
          d.operationalApproval === false &&
          d.historicalAvailabilityClaim === false &&
          d.captureHash === captureCanonicalProof(c).hash &&
          c.owner === o.owner &&
          c.codeCommit === env.GITHUB_SHA,
        "DIAGNOSIS_BINDING",
      );
      await assertCaptureFresh(o, c);
      await assertNovemberLineageFresh(o, c.captureManifest);
      await appendEvidence(o, "capture", c);
      await assertCaptureFresh(o, c);
      const saved = await appendKrNov3Evidence(o, d);
      return {
        status: "KR_PLAN_BLOCKED_DIAGNOSIS_ARCHIVED",
        diagnosisHash: saved.hash,
        historicalAvailabilityClaim: false,
        operationalApproval: false,
      };
    }
    const p = readLocal("plan.json") as KrNov3Plan,
      c = readLocal("capture.json") as FinalCapture;
    check(
      p.preparation.codeCommit === env.GITHUB_SHA &&
        p.preparation.owner === o.owner &&
        c.owner === o.owner &&
        c.codeCommit === env.GITHUB_SHA &&
        p.captureHash === captureCanonicalProof(c).hash &&
        same(c.runtimeHashes, admittedRuntimeHashes),
      "PRIVATE_PLAN_BINDING",
    );
    await validateKrNov3Plan(p);
    await assertFresh(p);
    const capture = await appendEvidence(o, "capture", c);
    check(capture.hash === p.captureHash, "CAPTURE_EVIDENCE_READBACK");
    await assertFresh(p);
    const saved = await appendKrNov3Evidence(o, p);
    return {
      status: "KR_PLAN_PRIVATE_EVIDENCE_STORED_REVIEW_REQUIRED",
      planHash: saved.hash,
      approvalCandidateHash: await hashSeriesValue(await krNov3ApprovalCandidate(p)),
      captureHash: p.captureHash,
      historicalAvailabilityClaim: false,
      operationalApproval: false,
    };
  }
  check(
    [
      "kr-materialize",
      "kr-stage-approval",
      "kr-stage-authority",
      "kr-validate",
      "kr-apply",
    ].includes(mode),
    "COMMAND",
  );
  const planHash = env.EXPECTED_PLAN_HASH as SeriesHash,
    approvalHash = env.EXPECTED_APPROVAL_HASH as SeriesHash;
  check(
    /^sha256:[a-f0-9]{64}$/.test(planHash ?? "") &&
      /^sha256:[a-f0-9]{64}$/.test(approvalHash ?? ""),
    "EXPECTED_REVIEW_PINS",
  );
  const p = (await readKrNov3Evidence(o, planHash, "kr-nov3-recovery-plan-v1")) as KrNov3Plan;
  check(
    p.preparation.codeCommit === env.GITHUB_SHA &&
      same(p.preparation.runtimeHashes, admittedRuntimeHashes),
    "LIVE_CODE_RUNTIME",
  );
  const c = (await readEvidence(o, "capture", p.captureHash)) as FinalCapture;
  check(
    c.owner === o.owner &&
      c.codeCommit === env.GITHUB_SHA &&
      same(c.preservationBaseline, p.preparation.preservationBaseline) &&
      same(c.captureManifest, p.captureManifest),
    "CAPTURE_PLAN_BINDING",
  );
  await validateKrNov3Plan(p);
  if (mode === "kr-materialize") {
    check(
      (await hashSeriesValue(await krNov3ApprovalCandidate(p))) === approvalHash,
      "REVIEWED_APPROVAL_PIN",
    );
    const materialized = path.join(dir, "workflow-materialized");
    fs.mkdirSync(materialized, { recursive: true, mode: 0o700 });
    fs.chmodSync(materialized, 0o700);
    saveKrPrivate(path.join(materialized, "capture.json"), c);
    saveKrPrivate(path.join(materialized, "plan.json"), p);
    saveKrPrivate(path.join(materialized, "pins.json"), {
      version: "kr-nov3-reproduction-pins-v1",
      owner: o.owner,
      codeCommit: env.GITHUB_SHA,
      captureHash: p.captureHash,
      planHash,
    });
    return {
      status: "KR_PRIVATE_REPRODUCTION_READY",
      planHash,
      captureHash: p.captureHash,
      historicalAvailabilityClaim: false,
    };
  }
  await reproduceStoredKrNov3Plan(c, p, root, o.owner, env.GITHUB_SHA!);
  if (mode === "kr-stage-approval") {
    // The operator supplies the separately reviewed exact approval hash. PLAN
    // cannot enter this command and never invokes this writer automatically.
    const a = await krNov3ApprovalCandidate(p);
    check(
      (await hashSeriesValue(a)) === approvalHash && same(a, await krNov3ApprovalCandidate(p)),
      "INDEPENDENT_REVIEW_FILE",
    );
    await assertFresh(p);
    await appendKrNov3Evidence(o, a);
    return {
      status: "KR_REVIEW_APPROVAL_STAGED",
      planHash,
      approvalHash,
      historicalAvailabilityClaim: false,
    };
  }
  const a = (await readKrNov3Evidence(
    o,
    approvalHash,
    "kr-nov3-recovery-approval-v1",
  )) as KrNov3Approval;
  check(same(a, await krNov3ApprovalCandidate(p)), "EXACT_APPROVAL");
  const client = trustedSupabaseClient();
  if (mode === "kr-stage-authority") {
    const result = await stageKrNov3Authority(o, client, p, a, planHash, approvalHash, () =>
      assertFresh(p),
    );
    return {
      status: "KR_VINTAGE_AUTHORITY_SEPARATELY_STAGED",
      registryHash: await hashSeriesValue(result.registry),
      historicalAvailabilityClaim: false,
    };
  }
  const input = {
    phase: "VALIDATE" as "VALIDATE" | "APPLY",
    plan: p,
    approval: a,
    authoritativePlanHash: planHash,
    authoritativeApprovalHash: approvalHash,
    owner: o.owner,
    admittedCodeCommit: env.GITHUB_SHA!,
    admittedRuntimeHashes,
    store: boundedKrNov3Store(octoberShadowStore(client, o.owner, "service"), p),
    readAuthority: () => readStagedKrNov3Authority(o, p),
    assertFresh,
    assertExclusiveWriter: async () => {
      assertKrNov3Workflow(env);
    },
    putProvenance: async () => {
      await appendKrNov3Evidence(o, {
        version: "kr-nov3-recovery-execution-v1",
        owner: o.owner,
        planHash,
        approvalHash,
        captureHash: p.captureHash,
        preparationHash: p.preparationHash,
        vintageRegistryHash: a.vintageRegistryHash,
        retrospectiveRegistryHash: a.retrospectiveRegistryHash,
        historicalAvailabilityClaim: false,
      });
    },
  };
  const validated = await applyKrNov3Recovery(input);
  if (mode === "kr-validate") return { ...validated, planHash, approvalHash };
  input.phase = "APPLY";
  const result = await applyKrNov3Recovery(input);
  const completion = await appendKrNov3Evidence(o, {
    version: "kr-nov3-recovery-completion-v1",
    owner: o.owner,
    planHash,
    approvalHash,
    completedAt: new Date().toISOString(),
    result,
    historicalAvailabilityClaim: false,
  });
  return { ...result, planHash, completionHash: completion.hash };
}
// Explicit opt-in prevents imports (including tests) from becoming authenticated execution.
if (process.env.KR_NOV3_AUTH_ENTRY === "true") {
  runKrNov3Command(process.argv[2] ?? "")
    .then((v) => console.log(JSON.stringify(v)))
    .catch(() => {
      console.error(
        JSON.stringify({
          status: "KR_NOV3_REJECTED_OR_PARTIAL_CHECK_STATE",
          completionClaim: false,
        }),
      );
      process.exitCode = 1;
    });
}
