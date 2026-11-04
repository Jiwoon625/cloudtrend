/* eslint-disable @typescript-eslint/no-explicit-any */
/** Manual, exact-date authenticated transport. No collector or ordinary admission edits. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { safeCaptureProgress, safeChildTermination } from "./diagnostics";
import { spawnSync } from "node:child_process";
import {
  readEvidence,
  appendEvidence,
  reader,
  snapshot,
  normalizeGeneration,
  legacyInventory,
  type Connection,
  PREFIX,
} from "../kr-final-retrospective/transport";
import {
  captureCanonicalChunks,
  captureCanonicalProof,
} from "../kr-final-retrospective/capture-codec";
import { pureEnvironment } from "../kr-vintage-preflight/runner";
import { captureNov3, loadPriorNovember } from "./capture";
import { applyNov3Recovery, nov3ApprovalCandidate } from "./apply";
import { canonicalSeriesJson } from "../../src/lib/ledger/modelSeries";
import { KOSPI_SHADOW_NAMESPACE, type ShadowObjectStore } from "../../src/lib/kospiShadowStore";
import { KOSPI_SHADOW_CORRECTION_REVISION_ID } from "../../src/lib/kospiShadowSeries";
import { sameSourceRows } from "../kospi-november-recovery/source-row-comparison";
const H = /^sha256:[a-f0-9]{64}$/;
const same = (a: unknown, b: unknown) => canonicalSeriesJson(a) === canonicalSeriesJson(b);
const digest = (v: unknown) => captureCanonicalProof(v).hash;
function need(v: unknown): asserts v {
  if (!v) throw Error("NOV3_TRANSPORT_REJECTED");
}
export const WORKFLOW = "KOSPI Nov3 reviewed recovery";
export function assertWorkflow(env: NodeJS.ProcessEnv = process.env) {
  need(
    env.GITHUB_ACTIONS === "true" &&
      env.GITHUB_EVENT_NAME === "workflow_dispatch" &&
      env.GITHUB_REF === "refs/heads/main" &&
      env.GITHUB_WORKFLOW === WORKFLOW &&
      env.RECOVERY_CONCURRENCY_GROUP === "kospi-prospective-shadow" &&
      /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") &&
      ["PLAN", "AUTHORIZE", "VALIDATE", "APPLY"].includes(env.RECOVERY_MODE ?? "") &&
      (env.RECOVERY_MODE === "PLAN" ||
        (H.test(env.EXPECTED_CAPSULE_HASH ?? "") && H.test(env.EXPECTED_APPROVAL_HASH ?? ""))),
  );
}
export function verifyWriterManifest(manifest: any, read: (p: string) => Buffer) {
  need(
    manifest?.version === "kospi-nov3-writer-v1" &&
      manifest.files &&
      Object.keys(manifest.files).length > 0,
  );
  need(digest({ version: manifest.version, files: manifest.files }) === manifest.hash);
  for (const [p, h] of Object.entries(manifest.files)) {
    need(
      typeof p === "string" &&
        !p.startsWith("/") &&
        !p.split("/").includes("..") &&
        H.test(String(h)),
    );
    need("sha256:" + createHash("sha256").update(read(p)).digest("hex") === h);
  }
  return manifest.hash as `sha256:${string}`;
}
export function validateCapsule(c: any, owner: string) {
  need(
    c?.version === "kospi-nov3-recovery-capsule-v1" &&
      c.owner === owner &&
      c.input?.authority.owner === owner &&
      !Object.hasOwn(c.input, "priorRecovery") &&
      c.result?.status === "PROVEN_NOV3_RETROSPECTIVE_CONTINUATION",
  );
  need(
    c.input.authority.predecessorDate === "2026-11-02" &&
      same(c.input.authority.targetDates, ["2026-11-03"]),
  );
  need(
    Array.isArray(c.sourceRows) &&
      c.sourceRows.length > 0 &&
      c.sourceRows.length <= 128 &&
      digest(c.sourceRows) === c.input.authority.sourceManifestHash,
  );
  need(
    Array.isArray(c.sourceObjectPins) &&
      c.sourceObjectPins.length === c.sourceRows.length &&
      new Set(c.sourceObjectPins.map((x: any) => x.path)).size === c.sourceRows.length,
  );
  for (const [i, row] of c.sourceRows.entries()) {
    const pin = c.sourceObjectPins[i];
    need(
      row.user_id === owner &&
        row.source_type === "screening" &&
        row.status === "active" &&
        row.storage_bucket === "cloudtrend-data" &&
        typeof row.storage_path === "string" &&
        row.storage_path.startsWith(owner + "/source/screening/") &&
        pin.path === row.storage_path &&
        pin.hash === row.file_hash &&
        H.test(pin.hash),
    );
    need(
      same(
        normalizeGeneration({
          id: pin.generation.id,
          version: pin.generation.version,
          eTag: pin.generation.eTag,
          size: pin.generation.size,
          updated_at: pin.generation.updatedAt,
        }),
        pin.generation,
      ),
    );
  }
  need(
    c.materialization?.version === "kospi-nov3-readonly-capture-v1" &&
      c.materialization.owner === owner &&
      c.materialization.historicalAvailabilityClaim === false &&
      digest(c.materialization) === c.input.authority.captureManifestHash &&
      c.materialization.sourceRowsHash === digest(c.sourceRows) &&
      c.materialization.sourceObjectPinsHash === digest(c.sourceObjectPins) &&
      c.materialization.journalHash === digest(c.input.capturedObjects) &&
      c.materialization.generationPinsHash === digest(c.input.generationPins) &&
      c.materialization.datasetHash === c.input.authority.adjustedBasisHash &&
      c.materialization.capturedAt === c.input.authority.adjustedCapturedAt &&
      c.materialization.publication?.phase === "FINAL" &&
      c.materialization.publication.asOfDate === "2026-11-03",
  );
  need(
    c.priorRecoveryRefs?.capsuleHash ===
      "sha256:7b4f3d5a2984e4091b7d6a01211ade5d8877c3f1f737b3d1030848845f4ccfcc" &&
      c.priorRecoveryRefs.planHash ===
        "sha256:aafc077261a8679574f7abce520516dea36efe835da0d75a789dcb4adba05057" &&
      c.priorRecoveryRefs.approvalHash ===
        "sha256:c32a5bd7cfaca0e04612d2f7dc53736e7f676ee43c7b2d7373bfb0ef5e045f9a" &&
      c.priorRecoveryRefs.completionHash ===
        "sha256:b12096b28b1923b0159f9a6fe8c312ff3dbbc56b131ae484e9ca39052ee45f55",
  );
}
function privateWrite(file: string, v: unknown) {
  const proof = captureCanonicalProof(v);
  need(proof.bytes > 0 && proof.bytes <= 256 * 1024 * 1024);
  const fd = fs.openSync(file, "wx", 0o600),
    h = createHash("sha256");
  let bytes = 0;
  try {
    for (const chunk of captureCanonicalChunks(v)) {
      bytes += chunk.length;
      need(bytes <= 256 * 1024 * 1024);
      fs.writeFileSync(fd, chunk);
      h.update(chunk);
    }
    need(bytes === proof.bytes && "sha256:" + h.digest("hex") === proof.hash);
  } catch (e) {
    fs.rmSync(file, { force: true });
    throw e;
  } finally {
    fs.closeSync(fd);
  }
}
/** Aggregate limits include streamed response bytes, not merely declared Content-Length. */
export function boundedFetch(
  base: typeof fetch,
  maxBytes = 256 * 1024 * 1024,
  maxRequests = 2000,
): typeof fetch {
  need(
    Number.isSafeInteger(maxBytes) &&
      maxBytes > 0 &&
      maxBytes <= 256 * 1024 * 1024 &&
      Number.isSafeInteger(maxRequests) &&
      maxRequests > 0 &&
      maxRequests <= 2000,
  );
  let requests = 0,
    bytes = 0;
  return (async (input, init) => {
    need(++requests <= maxRequests && bytes <= maxBytes);
    const req = input instanceof Request ? input : null;
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const url = new URL(typeof input === "string" || input instanceof URL ? input : req!.url);
    const mutating =
      method !== "GET" &&
      method !== "HEAD" &&
      !(method === "POST" && url.pathname === "/storage/v1/object/list/cloudtrend-data");
    // Reserve two further calls and 8 MiB for response plus uncertain-write readback.
    if (mutating) need(maxRequests - requests >= 2 && maxBytes - bytes >= 8 * 1024 * 1024);
    const response = await base(input, init);
    if (!response.body) return response;
    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          need(bytes <= maxBytes);
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }) as typeof fetch;
}
function connection(): Connection {
  const origin = process.env.SUPABASE_URL ?? "",
    key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    owner = process.env.SUPABASE_USER_ID ?? "";
  need(
    /^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(origin) &&
      key.length > 0 &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(owner),
  );
  const o = { origin, key, owner, fetcher: boundedFetch(fetch) };
  reader(o);
  return o;
}
export async function assertFresh(
  o: Connection,
  c: any,
  baseline: any,
  archivePins?: any[],
  fullSnapshot = true,
) {
  if (archivePins)
    for (const row of archivePins) {
      const found = await reader(o).rows(
        "ledger_provenance_archive",
        { source_id: "eq." + row.source_id, source_revision: "eq.1" },
        2,
      );
      need(found.length === 1 && same(found[0], row));
    }
  const now = fullSnapshot
    ? await snapshot(o)
    : {
        sources: await reader(o).rows(
          "analysis_source_files",
          { source_type: "eq.screening", status: "eq.active" },
          129,
          "activated_at.asc.nullsfirst,created_at.asc,id.asc",
        ),
      };
  need((!fullSnapshot || same(now, baseline)) && sameSourceRows(now.sources, c.sourceRows));
  for (const pin of c.sourceObjectPins)
    need(same(normalizeGeneration(await reader(o).info(pin.path)), pin.generation));
  const root = `${o.owner}/${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  const latest = root + "/latest.json",
    targets = [root + "/sessions/2026-11-03.json"];
  const expected = c.input.capturedObjects.map((x: any) => x.path).sort(),
    found = await legacyInventory(o);
  need(
    expected.every((p: string) => found.includes(p)) &&
      found.every((p) => expected.includes(p) || targets.includes(p)),
  );
  for (const pin of c.input.generationPins) {
    if (pin.path !== latest)
      need(same(normalizeGeneration(await reader(o).info(pin.path)), pin.generation));
  }
  return now;
}
/** Fixed endpoint and body allowlist; no general DB or ledger mutation API. */
export function validateJournalWrite(
  owner: string,
  p: string,
  v: unknown,
  immutable: boolean,
  c: any,
) {
  const root = `${owner}/${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  if (immutable) {
    const i = ["2026-11-03"].findIndex((d) => p === root + `/sessions/${d}.json`);
    need(i >= 0 && same(v, c.result.snapshots[i]));
  } else need(p === root + "/latest.json" && c.result.projections.some((x: any) => same(v, x)));
}
/** Fixed codes only: never log response bodies, object paths, owners, or credentials. */
class ShadowReadError extends Error {
  constructor(readonly safeCode: string) {
    super(safeCode);
  }
}
export function shadowReadDiagnostic(error: unknown): string {
  return error instanceof ShadowReadError ? error.safeCode : "UNCLASSIFIED";
}
async function isMissingShadowObject(response: Response): Promise<boolean> {
  if (response.status !== 400 && response.status !== 404) return false;
  if (!response.body) throw new ShadowReadError("SHADOW_READ_ERROR_ENVELOPE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > 4096) {
        await reader.cancel().catch(() => {});
        throw new ShadowReadError("SHADOW_READ_ERROR_BODY_TOO_LARGE");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ShadowReadError) throw error;
    throw new ShadowReadError("SHADOW_READ_BODY_FAILED");
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ShadowReadError("SHADOW_READ_ERROR_ENVELOPE_INVALID");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new ShadowReadError("SHADOW_READ_MISSING_ENVELOPE_UNRECOGNIZED");
  const envelope = value as Record<string, unknown>;
  const recognized =
    (envelope.statusCode === "404" || envelope.statusCode === 404) &&
    envelope.error === "not_found" &&
    envelope.message === "Object not found" &&
    (!Object.hasOwn(envelope, "code") || envelope.code === "NoSuchKey");
  if (!recognized) throw new ShadowReadError("SHADOW_READ_MISSING_ENVELOPE_UNRECOGNIZED");
  return true;
}
export function shadowStore(o: Connection, c: any, allowWrites: boolean): ShadowObjectStore {
  const root = `${o.owner}/${KOSPI_SHADOW_NAMESPACE}/revisions/${KOSPI_SHADOW_CORRECTION_REVISION_ID}`;
  const paths = new Set<string>([
    ...c.input.capturedObjects.map((x: any) => x.path),
    root + "/sessions/2026-11-03.json",
  ]);
  const request = async (p: string, method: string, body?: string, upsert = false) => {
    need(paths.has(p));
    const headers: any = { apikey: o.key, Authorization: "Bearer " + o.key };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["x-upsert"] = String(upsert);
      headers["cache-control"] = "no-cache";
    }
    return (o.fetcher ?? fetch)(
      new URL(
        "/storage/v1/object/" + (method === "GET" ? "authenticated/" : "") + "cloudtrend-data/" + p,
        o.origin,
      ),
      {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        redirect: "error",
        cache: "no-store",
      },
    );
  };
  return {
    read: async <T>(p: string) => {
      let r: Response;
      try {
        r = await request(p, "GET");
      } catch {
        throw new ShadowReadError("SHADOW_READ_REQUEST_FAILED");
      }
      if (!r.ok) {
        if (await isMissingShadowObject(r)) return null;
        throw new ShadowReadError("SHADOW_READ_HTTP_REJECTED");
      }
      let t: string;
      try {
        t = await r.text();
      } catch {
        throw new ShadowReadError("SHADOW_READ_BODY_FAILED");
      }
      if (Buffer.byteLength(t) > 4 * 1024 * 1024)
        throw new ShadowReadError("SHADOW_READ_BODY_TOO_LARGE");
      try {
        return JSON.parse(t) as T;
      } catch {
        throw new ShadowReadError("SHADOW_READ_JSON_INVALID");
      }
    },
    latestSessionDate: async (p: string) => {
      need(p === root + "/sessions" || p === `${o.owner}/${KOSPI_SHADOW_NAMESPACE}/sessions`);
      return (
        (await legacyInventory(o))
          .filter(
            (x) => x.startsWith(p + "/") && /^\d{4}-\d{2}-\d{2}\.json$/.test(x.slice(p.length + 1)),
          )
          .sort()
          .at(-1)
          ?.slice(-15, -5) ?? null
      );
    },
    putImmutable: async (p, v) => {
      need(allowWrites);
      validateJournalWrite(o.owner, p, v, true, c);
      const body = JSON.stringify(v);
      need(Buffer.byteLength(body) <= 4 * 1024 * 1024);
      const r = await request(p, "POST", body, false);
      need(r.ok);
    },
    putLatest: async (p, v) => {
      need(allowWrites);
      validateJournalWrite(o.owner, p, v, false, c);
      const body = JSON.stringify(v);
      need(Buffer.byteLength(body) <= 4 * 1024 * 1024);
      const r = await request(p, "POST", body, true);
      need(r.ok);
    },
  };
}
let phase = "ADMISSION";
export async function main() {
  assertWorkflow();
  const action = process.argv[2],
    code = process.env.GITHUB_SHA!,
    mode = process.env.RECOVERY_MODE!;
  const root = process.env.RUNNER_TEMP;
  need(root && path.isAbsolute(root));
  const dir = path.join(root, "kospi-nov3-private"),
    build = path.join(root, "kospi-nov3-code");
  const manifest = JSON.parse(fs.readFileSync(path.join(build, "writer-manifest.json"), "utf8"));
  const runtimeHash = verifyWriterManifest(manifest, (p) => fs.readFileSync(path.resolve(p)));
  const file = (name: string) => path.join(dir, name + ".json"),
    read = (name: string) => JSON.parse(fs.readFileSync(file(name), "utf8"));
  if (mode === "PLAN") {
    if (action === "capture") {
      phase = "CAPTURE";
      const o = connection();
      return captureNov3(o, dir, code, () => ({
        ...o,
        fetcher: boundedFetch(fetch, 96 * 1024 * 1024, 12),
      }));
    }
    if (action === "compute-capture") {
      phase = "PURE_CAPTURE_COMPUTATION";
      const child = spawnSync(process.execPath, [path.join(build, "capture-pure.mjs"), dir], {
        env: { ...pureEnvironment(dir), NODE_OPTIONS: "--max-old-space-size=6144" },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        timeout: 50 * 60 * 1000,
      });
      let progress: unknown = null;
      try {
        const progressFile = file("capture-progress");
        if (fs.statSync(progressFile).size <= 4096)
          progress = JSON.parse(fs.readFileSync(progressFile, "utf8"));
      } catch {
        /* Missing or malformed progress never exposes the underlying error. */
      }
      console.log(
        JSON.stringify({
          status: "PURE_CAPTURE_DIAGNOSTIC",
          ...safeCaptureProgress(progress),
          ...safeChildTermination(child),
        }),
      );
      need(child.status === 0 && !child.error);
      return read("capture-status");
    }
    need(action === "archive-plan");
    phase = "ARCHIVE_PLAN";
    const o = connection(),
      captured = read("capture"),
      receipt = read("receipt"),
      status = read("capture-status");
    need(same(await snapshot(o), captured.baseline));
    if (status.status === "BLOCKED") {
      const saved = await appendEvidence(o, "execution", {
        version: "kospi-nov3-blocked-plan-v1",
        owner: o.owner,
        result: receipt.result,
        historicalAvailabilityClaim: false,
        operationalApproval: false,
      });
      return { ...status, diagnosticHash: saved.hash, noOperationalWrites: true };
    }
    need(status.status === "PREPARED");
    const c = read("capsule");
    validateCapsule(c, o.owner);
    need(
      digest(c) === status.capsuleHash &&
        digest(receipt) === status.preparationHash &&
        same(receipt.result, c.result),
    );
    need(same(await loadPriorNovember(o), receipt.input.priorRecovery));
    await assertFresh(o, c, captured.baseline);
    const candidate = await nov3ApprovalCandidate(digest(receipt), c.result, {
      codeCommit: code,
      runtimeHash,
    });
    const saved = await appendEvidence(o, "execution", c);
    await assertFresh(o, c, captured.baseline);
    return {
      status: "PLAN_ARCHIVED_REQUIRES_REVIEW",
      capsuleHash: saved.hash,
      preparationHash: digest(receipt),
      planHash: c.result.planHash,
      proposedApprovalHash: digest(candidate),
      writerRuntimeHash: runtimeHash,
      noOperationalWrites: true,
      historicalAvailabilityClaim: false,
    };
  }
  if (action === "materialize") {
    phase = "MATERIALIZE";
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const o = connection();
    const c = await readEvidence(o, "execution", process.env.EXPECTED_CAPSULE_HASH!);
    validateCapsule(c, o.owner);
    let a =
      mode === "AUTHORIZE"
        ? null
        : await readEvidence(o, "execution", process.env.EXPECTED_APPROVAL_HASH!);
    const refs = c.priorRecoveryRefs;
    const oldCapsule = await readEvidence(o, "execution", refs.capsuleHash);
    need(
      oldCapsule.version === "kospi-november-recovery-capsule-v1" && oldCapsule.owner === o.owner,
    );
    const oldRefs = oldCapsule.priorRecoveryRefs;
    need(
      oldRefs.planHash ===
        "sha256:2964685f4dcf1ea6d237c4101525458dae110260d85dea73185b45f7e12f02d9" &&
        oldRefs.approvalHash ===
          "sha256:cf64e1e10834278d23477f5643b5a5fde4e5f4cb69966e01c8ccb46598d5a6e5" &&
        oldRefs.completionHash ===
          "sha256:c2049440924da0dedf2a3de6459cf49e47eae878cf64fe928df7ce355f0072a6",
    );
    const ancestor = {
      plan: { hash: oldRefs.planHash, payload: await readEvidence(o, "plan", oldRefs.planHash) },
      approval: {
        hash: oldRefs.approvalHash,
        payload: await readEvidence(o, "approval", oldRefs.approvalHash),
      },
      completion: {
        hash: oldRefs.completionHash,
        payload: await readEvidence(o, "completion", oldRefs.completionHash),
      },
    };
    const oldReceipt = {
      version: "kospi-november-recovery-preparation-v1",
      kind: "RECOVERY_PREPARATION_ONLY",
      operationalApproval: false,
      historicalAvailabilityClaim: false,
      input: { ...oldCapsule.input, priorRecovery: ancestor },
      result: oldCapsule.result,
    };
    need(digest(oldReceipt) === refs.planHash);
    need(
      oldReceipt.input.authority.runtimeCodeHash ===
        "sha256:55dcf41767160a6b507422447ee6a4818b34a41a55205128086bbce6d058c990" &&
        oldReceipt.result.authority.runtimeCodeHash === oldReceipt.input.authority.runtimeCodeHash,
    );
    const priorRecovery = {
      plan: { hash: refs.planHash, payload: oldReceipt },
      approval: {
        hash: refs.approvalHash,
        payload: await readEvidence(o, "execution", refs.approvalHash),
      },
      completion: {
        hash: refs.completionHash,
        payload: await readEvidence(o, "execution", refs.completionHash),
      },
    };
    const receipt = {
      version: "kospi-nov3-recovery-preparation-v1",
      kind: "RECOVERY_PREPARATION_ONLY",
      operationalApproval: false,
      historicalAvailabilityClaim: false,
      input: { ...c.input, priorRecovery },
      result: c.result,
    };
    if (mode === "AUTHORIZE") {
      a = await nov3ApprovalCandidate(digest(receipt), c.result, { codeCommit: code, runtimeHash });
      need(digest(a) === process.env.EXPECTED_APPROVAL_HASH);
    }
    need(
      a.version === "kospi-nov3-recovery-approval-v1" &&
        same(
          a,
          await nov3ApprovalCandidate(digest(receipt), c.result, {
            codeCommit: code,
            runtimeHash,
          }),
        ),
    );
    const archivePins = [];
    for (const [kind, hash] of [
      ["execution", process.env.EXPECTED_CAPSULE_HASH!],
      ...(mode === "AUTHORIZE" ? [] : [["execution", process.env.EXPECTED_APPROVAL_HASH!]]),
      ["execution", refs.capsuleHash],
      ["execution", refs.approvalHash],
      ["execution", refs.completionHash],
      ["plan", oldRefs.planHash],
      ["approval", oldRefs.approvalHash],
      ["completion", oldRefs.completionHash],
    ]) {
      const rows = await reader(o).rows(
        "ledger_provenance_archive",
        { source_id: "eq." + PREFIX + kind + ":" + hash.slice(7), source_revision: "eq.1" },
        2,
      );
      need(rows.length === 1);
      archivePins.push(rows[0]);
    }
    privateWrite(file("archive-pins"), archivePins);
    const baseline = await snapshot(o);
    need(sameSourceRows(baseline.sources, c.sourceRows));
    await assertFresh(o, c, baseline, archivePins, false);
    privateWrite(file("capsule"), c);
    privateWrite(file("receipt"), receipt);
    privateWrite(file("approval"), a);
    privateWrite(file("baseline"), baseline);
    return { status: "MATERIALIZED", historicalAvailabilityClaim: false };
  }
  if (action === "compute") {
    phase = "PURE_REPRODUCTION";
    const child = spawnSync(process.execPath, [path.join(build, "pure.mjs"), dir], {
      env: { ...pureEnvironment(dir), NODE_OPTIONS: "--max-old-space-size=6144" },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 40 * 60 * 1000,
    });
    need(child.status === 0 && !child.error);
    return { status: "REPRODUCED", historicalAvailabilityClaim: false };
  }
  need(action === "finish");
  phase = "FRESHNESS";
  const o = connection(),
    c = read("capsule"),
    receipt = read("receipt"),
    a = read("approval"),
    baseline = read("baseline"),
    proof = read("proof"),
    archivePins = read("archive-pins");
  validateCapsule(c, o.owner);
  need(
    digest(c) === process.env.EXPECTED_CAPSULE_HASH &&
      digest(a) === process.env.EXPECTED_APPROVAL_HASH &&
      digest(receipt) === proof.receiptHash &&
      proof.status === "REPRODUCED" &&
      same(receipt.result, c.result) &&
      same(
        a,
        await nov3ApprovalCandidate(digest(receipt), c.result, {
          codeCommit: code,
          runtimeHash,
        }),
      ),
  );
  await assertFresh(o, c, baseline, archivePins);
  if (mode === "AUTHORIZE") {
    phase = "ARCHIVE_REVIEWED_AUTHORITY";
    const saved = await appendEvidence(o, "execution", a);
    await assertFresh(o, c, baseline, archivePins);
    return {
      status: "AUTHORITY_ARCHIVED",
      approvalHash: saved.hash,
      noOperationalWrites: true,
      requiresValidateBeforeApply: true,
      historicalAvailabilityClaim: false,
    };
  }
  need(mode === "APPLY" || mode === "VALIDATE");
  phase = "APPLY";
  const result = await applyNov3Recovery({
    store: shadowStore(o, c, mode === "APPLY"),
    validateOnly: mode === "VALIDATE",
    preparationReceipt: receipt,
    approval: a,
    authoritativePreparationHash: digest(receipt),
    authoritativeApprovalHash: digest(a),
    approvedRuntimeCodeHash: receipt.input.authority.runtimeCodeHash,
    approvedWriterCodeCommit: code,
    approvedWriterRuntimeHash: runtimeHash,
    assertExclusiveWriter: async (scope) => {
      assertWorkflow();
      need(
        scope.owner === o.owner &&
          scope.writerCodeCommit === code &&
          scope.writerRuntimeHash === runtimeHash &&
          verifyWriterManifest(manifest, (p) => fs.readFileSync(path.resolve(p))) === runtimeHash,
      );
      await assertFresh(o, c, baseline, archivePins, false);
    },
  });
  if (mode === "VALIDATE") {
    await assertFresh(o, c, baseline, archivePins);
    return {
      status: "VALIDATED",
      noOperationalWrites: true,
      planHash: c.result.planHash,
      liveCompletedCount: result.alreadyCompletedCount,
      historicalAvailabilityClaim: false,
    };
  }
  phase = "PRESERVATION";
  await assertFresh(o, c, baseline, archivePins);
  const completion = {
    version: "kospi-nov3-recovery-execution-v1",
    owner: o.owner,
    capsuleHash: digest(c),
    approvalHash: digest(a),
    preparationHash: digest(receipt),
    completedAt: new Date().toISOString(),
    result,
    preservationHash: digest(baseline),
    historicalAvailabilityClaim: false,
  };
  phase = "COMPLETION";
  const saved = await appendEvidence(o, "execution", completion);
  need(same(await readEvidence(o, "execution", saved.hash), completion));
  return {
    status: "VERIFIED",
    completionHash: saved.hash,
    completedDates: result.completedDates,
    historicalAvailabilityClaim: false,
  };
}
if (/(?:^|\/)(?:entry\.ts|transport\.mjs)$/.test(process.argv[1] ?? ""))
  main()
    .then((x) => console.log(JSON.stringify(x)))
    .catch((error: unknown) => {
      console.error(
        JSON.stringify({
          status: "KOSPI_NOV3_REJECTED_OR_PARTIAL_RECHECK",
          phase,
          errorCode: shadowReadDiagnostic(error),
          completionClaim: false,
        }),
      );
      process.exitCode = 1;
    });
