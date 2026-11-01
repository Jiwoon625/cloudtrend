/* eslint-disable @typescript-eslint/no-explicit-any */
/** Narrow existing-owner transport. Never changes collector, source, actual or old model rows. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import { pureEnvironment } from "../kr-vintage-preflight/runner";
import {
  readEvidence,
  appendEvidence,
  reader,
  snapshot,
  normalizeGeneration,
  type Connection,
} from "../kr-final-retrospective/transport";
import {
  captureCanonicalChunks,
  captureCanonicalProof,
} from "../kr-final-retrospective/capture-codec";
import { canonicalSeriesJson, hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import {
  storeIntegratedAllocationOutbox,
  INTEGRATED_ALLOCATION_OUTBOX_VERSION,
} from "../../src/lib/integratedAllocationRecovery.server";
import { replayIntegratedAllocationAvailable } from "../../src/lib/integratedAllocationReplay.server";
import { integratedAllocationRuntimeAdmission } from "../../src/lib/integratedAllocationStore.server";
import { INTEGRATED_RUNTIME_ATTEMPT_VERSION } from "../../src/lib/integratedAllocationRuntimeAudit.server";
import { INTEGRATED_ALLOCATION_VERSION } from "../../src/lib/integratedAllocationShadow";
import { validateGapRequest } from "./core";
import {
  octoberModelCalendar,
  OCTOBER_CALENDAR_EVIDENCE,
  regularOpenAt,
} from "../../src/lib/ledger/octoberShadowCalendar";
const H = /^sha256:[a-f0-9]{64}$/;
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
function check(v: unknown): asserts v {
  if (!v) throw Error("INTEGRATED_GAP_REJECTED");
}
const workflow = "Integrated allocation exact gap PLAN APPLY";
let phase = "ADMISSION";
export function assertWorkflow(env = process.env) {
  check(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW === workflow &&
      env.RECOVERY_CONCURRENCY_GROUP === "kospi-prospective-shadow" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") &&
      ["INSPECT", "PLAN", "VALIDATE", "APPLY"].includes(env.RECOVERY_MODE ?? ""),
  );
}
function writePrivate(file: string, value: unknown) {
  const proof = captureCanonicalProof(value);
  check(proof.bytes > 0 && proof.bytes <= 256 * 1024 * 1024);
  const fd = fs.openSync(file, "wx", 0o600),
    digest = createHash("sha256");
  let count = 0;
  try {
    for (const chunk of captureCanonicalChunks(value)) {
      count += chunk.length;
      check(count <= 256 * 1024 * 1024);
      fs.writeFileSync(fd, chunk);
      digest.update(chunk);
    }
    check(count === proof.bytes && "sha256:" + digest.digest("hex") === proof.hash);
  } catch (error) {
    fs.rmSync(file, { force: true });
    throw error;
  } finally {
    fs.closeSync(fd);
  }
}
async function assertFresh(o: Connection, capture: any, plan?: any) {
  const current = await snapshot(o),
    baseline = capture.baseline;
  for (const key of ["sources", "registries", "actual"] as const)
    check(same(current[key], baseline[key]));
  const additions = plan?.publications ?? [];
  const oldKeys = new Set(baseline.models.map((r: any) => r.series_id + ":" + r.session_date));
  const preserved = current.models.filter((r: any) =>
    oldKeys.has(r.series_id + ":" + r.session_date),
  );
  check(same(preserved, baseline.models));
  const extras = current.models.filter(
    (r: any) => !oldKeys.has(r.series_id + ":" + r.session_date),
  );
  check(extras.length <= additions.length);
  for (const row of extras) {
    const expected = additions.find(
      (p: any) => p.bookId === row.series_id && p.receipt.date === row.session_date,
    );
    check(
      expected &&
        row.user_id === o.owner &&
        row.state_hash === expected.stateHash &&
        same(row.payload, expected),
    );
  }
  for (const item of capture.objects)
    check(same(normalizeGeneration(await reader(o).info(item.path)), item.generation));
  return current;
}
async function targetEvidence(o: Connection) {
  const client = createClient(o.origin, o.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const target = `${o.owner}/staging/integrated-allocation-inputs/v1/KR/2026-10-29.json`;
  const { data, error } = await client.storage
    .from("cloudtrend-data")
    .download(target, { cacheNonce: crypto.randomUUID() }, { cache: "no-store" });
  if (error) {
    check(String(error.statusCode) === "404" || /not found/i.test(error.message));
    return null;
  }
  check(data && data.size <= 8 * 1024 * 1024);
  const e = JSON.parse(await data.text());
  check(e.hash === (await hashSeriesValue(e.payload)));
  return e;
}
async function initialBaseline(o: Connection, request: any) {
  const b = await snapshot(o);
  for (const key of ["sources", "models", "registries", "actual"] as const)
    check(captureCanonicalProof(b[key]).hash === request.expected[key]);
  check((await targetEvidence(o)) === null);
  const outboxes = await reader(o).rows(
    "shadow_replay_audit",
    { market: "eq.KR", strategy_version: "eq." + INTEGRATED_ALLOCATION_VERSION },
    513,
  );
  check(
    !outboxes.some(
      (r: any) =>
        r.signal_date === "2026-10-29" &&
        (r.details?.integratedAllocationOutbox ||
          ["EVIDENCE_PREPARED", "EVIDENCE_RESTORED"].includes(
            r.details?.integratedRuntimeAttempt?.kind,
          )),
    ),
  );
  return b;
}
export async function validateGapMutation(
  req: Request,
  context: {
    o: Connection;
    capture: any;
    plan: any;
    evidenceHash: string;
    outbox: any;
    target: string;
  },
) {
  const { o, capture, plan, evidenceHash, outbox, target } = context,
    url = new URL(req.url);
  check(
    url.origin === new URL(o.origin).origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      req.method === "POST",
  );
  const bodyText = await req.clone().text();
  check(Buffer.byteLength(bodyText) <= 8 * 1024 * 1024);
  let body: any;
  if (req.headers.get("content-type")?.startsWith("multipart/form-data")) {
    check(url.pathname === "/storage/v1/object/cloudtrend-data/" + target);
    const form = await req.clone().formData();
    check(same([...form.keys()].sort(), ["", "cacheControl"]) && form.get("cacheControl") === "0");
    const blob = form.get("");
    check(blob instanceof Blob);
    body = JSON.parse(await blob.text());
  } else body = JSON.parse(bodyText);
  if (url.pathname === "/rest/v1/rpc/ledger_append_model_session") {
    const pub = plan.publications.find((p: any) => same(p, body.p_run));
    const previous = capture.baseline.models.find(
      (r: any) => r.series_id === pub?.bookId && r.session_date === "2026-10-28",
    )?.payload;
    check(
      pub &&
        previous &&
        same(body, {
          p_user_id: o.owner,
          p_series: pub.registry,
          p_run: pub,
          p_previous_date: "2026-10-28",
          p_previous_hash: previous.stateHash,
        }),
    );
  } else if (url.pathname === "/rest/v1/shadow_replay_audit") {
    check(
      same(
        Object.keys(body).sort(),
        [
          "user_id",
          "market",
          "signal_date",
          "calculated_at",
          "source_captured_at",
          "model_available_at",
          "model_decision_at",
          "execution_at",
          "replay_mode",
          "status",
          "source_hash",
          "strategy_version",
          "reason",
          "details",
        ].sort(),
      ),
    );
    check(
      body.user_id === o.owner &&
        body.market === "KR" &&
        body.signal_date === "2026-10-29" &&
        body.strategy_version === INTEGRATED_ALLOCATION_VERSION &&
        body.replay_mode === "RETROSPECTIVE" &&
        body.status === "WAITING_INPUT" &&
        body.source_captured_at === null &&
        Number.isFinite(Date.parse(body.calculated_at)) &&
        Date.parse(body.calculated_at) >= Date.parse(capture.capturedAt),
    );
    if (body.details?.integratedAllocationOutbox) {
      check(
        body.reason === "통합 배분 입력 저장 재시도 대기" &&
          same(body.details, { integratedAllocationOutbox: outbox }) &&
          body.source_hash === plan.krEvidence.clock.sourceHash &&
          body.model_available_at === plan.krEvidence.clock.availableAt &&
          body.model_decision_at === plan.krEvidence.clock.decisionAt &&
          body.execution_at === regularOpenAt("KR", "2026-10-30"),
      );
    } else {
      const attempt = body.details?.integratedRuntimeAttempt;
      check(
        body.reason ===
          "Runtime provenance intent only; economic publication outcome is not asserted" &&
          attempt &&
          body.model_available_at === null &&
          body.model_decision_at === null &&
          body.execution_at === null,
      );
      const common = {
        version: INTEGRATED_RUNTIME_ATTEMPT_VERSION,
        ...integratedAllocationRuntimeAdmission,
      };
      const expected =
        attempt.kind === "EVIDENCE_RESTORED"
          ? {
              ...common,
              kind: "EVIDENCE_RESTORED",
              subjectHash: evidenceHash,
              sourceHash: plan.krEvidence.clock.sourceHash,
            }
          : (() => {
              const p = plan.publications.find((v: any) => v.bookId === attempt.bookId);
              check(p);
              return {
                ...common,
                kind: "PUBLICATION_ATTEMPT",
                subjectHash: p.stateHash,
                sourceHash: p.receipt.sourceHash,
                bookId: p.bookId,
                previousStateHash: p.previousStateHash,
              };
            })();
      check(
        same(body.details, { integratedRuntimeAttempt: expected }) &&
          body.source_hash === expected.sourceHash,
      );
    }
  } else {
    check(
      url.pathname === "/storage/v1/object/cloudtrend-data/" + target &&
        req.headers.get("x-upsert") === "false" &&
        same(body, { hash: evidenceHash, payload: plan.krEvidence }),
    );
  }
}

async function exactApply(o: Connection, capture: any, plan: any, approvalHash: string) {
  const target = `${o.owner}/staging/integrated-allocation-inputs/v1/KR/2026-10-29.json`;
  const evidenceHash = await hashSeriesValue(plan.krEvidence);
  const outbox = {
    version: INTEGRATED_ALLOCATION_OUTBOX_VERSION,
    market: "KR",
    date: "2026-10-29",
    hash: evidenceHash,
    payload: plan.krEvidence,
  };
  const readState = async () => {
    const c = await assertFresh(o, capture, plan),
      staged = await targetEvidence(o);
    check(staged === null || same(staged, { hash: evidenceHash, payload: plan.krEvidence }));
    return c;
  };
  let writes = 0,
    halted = false;
  const transport: typeof fetch = async (input, init) => {
    const req = new Request(input, init),
      url = new URL(req.url);
    check(url.origin === new URL(o.origin).origin && !url.username && !url.password);
    if (req.method === "GET" || req.method === "HEAD") return fetch(req, { redirect: "error" });
    check(!halted && req.method === "POST" && ++writes <= 10);
    await validateGapMutation(req, { o, capture, plan, evidenceHash, outbox, target });
    await readState();
    let response: Response;
    try {
      response = await fetch(req, { redirect: "error" });
    } catch (error) {
      halted = true;
      throw error;
    }
    if (!response.ok) {
      halted = true;
      throw Error("INTEGRATED_GAP_UNCERTAIN_WRITE_RECHECK");
    }
    return response;
  };
  await readState();
  await appendEvidence(o, "execution", {
    version: "integrated-gap-execution-v1",
    owner: o.owner,
    planHash: captureCanonicalProof(plan).hash,
    approvalHash,
    requestHash: capture.requestHash,
    captureHash: plan.captureHash,
    startedAt: new Date().toISOString(),
    historicalAvailabilityClaim: false,
    actualMutation: false,
    sourceMutation: false,
  });
  const client = createClient(o.origin, o.key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: transport },
  });
  await storeIntegratedAllocationOutbox(client, o.owner, {
    market: "KR",
    date: "2026-10-29",
    payload: plan.krEvidence,
    calculatedAt: new Date().toISOString(),
    replayMode: "RETROSPECTIVE",
  });
  const result = await replayIntegratedAllocationAvailable(
    client,
    o.owner,
    "2026-10-29",
    new Date().toISOString(),
    "service",
  );
  check(!halted && result.waiting === null);
  const final = await readState();
  for (const p of plan.publications)
    check(
      final.models.some(
        (r: any) =>
          r.series_id === p.bookId && r.session_date === "2026-10-29" && same(r.payload, p),
      ),
    );
  const completion = {
    version: "integrated-gap-completion-v1",
    owner: o.owner,
    planHash: captureCanonicalProof(plan).hash,
    approvalHash,
    requestHash: capture.requestHash,
    completedAt: new Date().toISOString(),
    result,
    expectedNewModelSessions: 2,
    historicalAvailabilityClaim: false,
    actualMutation: false,
  };
  return {
    status: "APPLIED",
    ...(await appendEvidence(o, "completion", completion)),
    expectedNewModelSessions: 2,
    historicalAvailabilityClaim: false,
  };
}
async function main() {
  assertWorkflow();
  const root = process.env.RUNNER_TEMP ?? "";
  check(path.isAbsolute(root));
  const directory = path.join(root, "integrated-gap-private");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const file = (name: string) => path.join(directory, name + ".json");
  const read = (name: string) => JSON.parse(fs.readFileSync(file(name), "utf8"));
  const mode = process.env.RECOVERY_MODE!,
    code = process.env.GITHUB_SHA!,
    requestHash = process.env.EXPECTED_REQUEST_HASH ?? "";
  const o: Connection = {
    origin: process.env.SUPABASE_URL ?? "",
    key: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    owner: process.env.SUPABASE_USER_ID ?? "",
  };
  const action = process.argv[2];
  if (mode === "INSPECT") {
    check(action === "materialize");
    phase = "INSPECT";
    const baseline = await snapshot(o),
      storage = [];
    check((await targetEvidence(o)) === null);
    const calendar = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
    const paths = [
      ...calendar.regularSessions
        .filter((d) => d >= "2026-10-12" && d <= "2026-10-28")
        .map((d) => `${o.owner}/staging/integrated-allocation-inputs/v1/KR/${d}.json`),
      ...["2026-10-28", "2026-10-29"].map(
        (d) => `${o.owner}/staging/integrated-allocation-inputs/v1/US/${d}.json`,
      ),
    ];
    for (const p of paths) {
      const value = await reader(o).object(p),
        envelope = JSON.parse(value.bytes.toString());
      check(envelope.hash === (await hashSeriesValue(envelope.payload)));
      storage.push({
        path: p,
        rawHash: value.hash,
        generation: value.generation,
        payloadHash: envelope.hash,
      });
    }
    check(same(await snapshot(o), baseline) && (await targetEvidence(o)) === null);
    const inspection = {
      version: "integrated-gap-inspection-v1",
      owner: o.owner,
      codeCommit: code,
      capturedAt: new Date().toISOString(),
      expected: Object.fromEntries(
        Object.entries(baseline).map(([k, v]) => [k, captureCanonicalProof(v).hash]),
      ),
      storage,
      targetAbsent: true,
      historicalAvailabilityClaim: false,
      noOperationalWrites: true,
    };
    return {
      status: "INSPECTED",
      ...(await appendEvidence(o, "execution", inspection)),
      noOperationalWrites: true,
    };
  }
  if (action === "materialize") {
    phase = "REQUEST";
    const request = await readEvidence(o, "request", requestHash);
    await validateGapRequest(request, requestHash, o.owner, code);
    let capture: any;
    if (mode === "PLAN") {
      phase = "BASELINE";
      const baseline = await initialBaseline(o, request),
        objects = [];
      for (const pin of request.storage) {
        const value = await reader(o).object(pin.path, pin.rawHash, pin.generation);
        const payload = JSON.parse(value.bytes.toString());
        check(
          payload.hash === (await hashSeriesValue(payload.payload)) &&
            payload.hash === pin.payloadHash,
        );
        objects.push({
          path: pin.path,
          generation: value.generation,
          rawHash: value.hash,
          payloadHash: payload.hash,
          payload: payload.payload,
        });
      }
      capture = {
        version: "integrated-gap-capture-v1",
        owner: o.owner,
        codeCommit: code,
        requestHash,
        request,
        capturedAt: new Date().toISOString(),
        baseline,
        objects,
        priorCaptureHash: request.priorCaptureHash,
        priorPlanHash: request.priorPlanHash,
      };
    } else {
      phase = "APPROVAL";
      const planHash = process.env.EXPECTED_PLAN_HASH ?? "",
        approvalHash = process.env.EXPECTED_APPROVAL_HASH ?? "";
      check(H.test(planHash) && H.test(approvalHash));
      const plan = await readEvidence(o, "plan", planHash),
        approval = await readEvidence(o, "approval", approvalHash);
      check(
        approval.version === "integrated-gap-approval-v1" &&
          approval.status === "APPROVED" &&
          approval.owner === o.owner &&
          approval.codeCommit === code &&
          approval.planHash === planHash &&
          approval.requestHash === requestHash &&
          approval.historicalAvailabilityClaim === false &&
          approval.captureHash === plan.captureHash &&
          approval.targetDate === "2026-10-29",
      );
      capture = await readEvidence(o, "capture", plan.captureHash);
      check(
        capture.codeCommit === code &&
          capture.owner === o.owner &&
          capture.requestHash === requestHash &&
          same(capture.request, request),
      );
      writePrivate(file("expected-plan"), plan);
      writePrivate(file("approval"), approval);
    }
    writePrivate(file("capture"), capture);
    phase = "PRIOR_CAPTURE";
    writePrivate(file("prior-capture"), await readEvidence(o, "capture", request.priorCaptureHash));
    phase = "PRIOR_PLAN";
    writePrivate(file("prior-plan"), await readEvidence(o, "plan", request.priorPlanHash));
    await assertFresh(o, capture, mode === "PLAN" ? undefined : read("expected-plan"));
    return { status: "MATERIALIZED", historicalAvailabilityClaim: false };
  }
  if (action === "compute") {
    phase = "PURE_COMPUTE";
    const child = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        path.join(root, "integrated-gap-code/pure.mjs"),
        directory,
        code,
        requestHash,
      ],
      {
        env: { ...pureEnvironment(directory), NODE_OPTIONS: "--max-old-space-size=4096" },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 60 * 60 * 1000,
      },
    );
    check(child.status === 0 && !child.error);
    return {
      status: "COMPUTED",
      planHash: captureCanonicalProof(read("plan")).hash,
      historicalAvailabilityClaim: false,
    };
  }
  check(action === "finish");
  phase = "FRESHNESS";
  const capture = read("capture"),
    plan = read("plan");
  check(
    plan.captureHash === captureCanonicalProof(capture).hash &&
      plan.requestHash === requestHash &&
      plan.owner === o.owner &&
      plan.codeCommit === code &&
      plan.historicalAvailabilityClaim === false,
  );
  await assertFresh(o, capture, mode === "PLAN" ? undefined : plan);
  if (mode === "PLAN") {
    check((await appendEvidence(o, "capture", capture)).hash === plan.captureHash);
    await assertFresh(o, capture);
    return {
      status: "PLAN_STORED_REVIEW_REQUIRED",
      ...(await appendEvidence(o, "plan", plan)),
      historicalAvailabilityClaim: false,
    };
  }
  check(
    same(plan, read("expected-plan")) &&
      captureCanonicalProof(plan).hash === process.env.EXPECTED_PLAN_HASH,
  );
  if (mode === "VALIDATE")
    return {
      status: "VALIDATED",
      planHash: captureCanonicalProof(plan).hash,
      noOperationalWrites: true,
      historicalAvailabilityClaim: false,
    };
  check(mode === "APPLY");
  phase = "APPLY";
  return exactApply(o, capture, plan, process.env.EXPECTED_APPROVAL_HASH!);
}
if (/(?:^|\/)(?:entry\.ts|transport\.mjs)$/.test(process.argv[1] ?? ""))
  main()
    .then((x) => console.log(JSON.stringify(x)))
    .catch(() => {
      console.error(
        JSON.stringify({
          status: "INTEGRATED_GAP_REJECTED_OR_PARTIAL_RECHECK",
          phase,
          completionClaim: false,
        }),
      );
      process.exitCode = 1;
    });
