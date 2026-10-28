/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from "vitest";
import {
  createReadOnlyTransport,
  objectPath,
  restPath,
  rawHash,
  validateCapsule,
  verifyResultBundle,
  CAPSULE_PREFIX,
} from "./transport";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { publicSummary, pureEnvironment } from "./runner";
const owner = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const digest = "a".repeat(64),
  h = "sha256:" + digest;
const file = (raw: string) => ({
  encoding: "base64",
  content: Buffer.from(raw).toString("base64"),
  bytes: Buffer.byteLength(raw),
  sha256: rawHash(raw).slice(7),
});
async function fixture() {
  const symbol = "999999";
  const files: any = {};
  for (const n of [
    `adjusted_${symbol}_360.json`,
    `adjusted_${symbol}_360.csv`,
    "provider-page-001.json",
    "provider-page-002.json",
  ])
    files[n] = file("{}");
  const manifest = {
    symbol,
    lastDate: "2026-10-27",
    adjusted: true,
    rows: 360,
    status: "CAPTURED_REVIEW_REQUIRED",
    artifacts: Object.fromEntries(
      Object.entries(files).map(([n, f]: [string, any]) => [
        n,
        { sha256: f.sha256, bytes: f.bytes },
      ]),
    ),
  };
  files["manifest.json"] = file(JSON.stringify(manifest));
  const mh = files["manifest.json"].sha256;
  files["manifest.sha256"] = file(mh + "  manifest.json\n");
  const sources = Array.from({ length: 38 }, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
    storage_bucket: "cloudtrend-data",
    storage_path: owner + `/source/screening/${i}.csv`,
    original_filename: `fixture-${i}.csv`,
    file_hash: h,
    data_hash: h,
    schema_hash: h,
    canonical_format: "csv",
    content_type: "text/csv",
  }));
  const dataVersion = rawHash(
    sources
      .map((s) => s.data_hash)
      .sort()
      .join("\n"),
  );
  const run = {
    id: "screening-synthetic-run",
    data_version: dataVersion,
    code_version: "b".repeat(40),
    as_of_date: "2026-10-27",
    completed_at: "2026-10-28T00:00:00Z",
    config: { synthetic: true },
    result_path: owner + "/results/screening/synthetic-run.json",
  };
  const payload: any = {
    version: "kr-vintage-preflight-evidence-v1",
    kind: "RECOVERY_EVIDENCE_ONLY",
    counterfactual: true,
    operationalApproval: false,
    capture: {
      manifestSha256: mh,
      driveFolderId: "synthetic",
      symbol,
      asOfDate: "2026-10-27",
      normalizedArtifactName: `adjusted_${symbol}_360.json`,
    },
    files,
    frozenBaseline: { run, orderedSources: sources },
    readPlan: {
      version: "kr-vintage-preflight-read-plan-v1",
      scope: {
        symbol,
        targetDate: "2026-10-26",
        baselineAsOfDate: "2026-10-27",
        captureThroughDate: "2026-10-27",
        captureManifestHash: "sha256:" + mh,
        normalizedArtifactName: `adjusted_${symbol}_360.json`,
        expectedRun: { id: run.id, codeVersion: run.code_version, dataVersion, sourceCount: 38 },
      },
      result: { bucket: "cloudtrend-data", path: run.result_path },
      krHistoryDates: ["2026-10-23"],
      previousDate: "2026-10-23",
      books: ["O1", "S07"].map((kind) => ({
        kind,
        seriesId: "integrated-allocation-shadow-2026-10-12-v1:" + kind,
        previousDate: "2026-10-23",
        previousStateHash: h,
        completedDate: "2026-10-26",
        completedStateHash: h,
      })),
    },
  };
  const row = {
    user_id: owner,
    source_id: CAPSULE_PREFIX + mh,
    source_revision: "1",
    source_hash: await hashSeriesValue(payload),
    payload,
  };
  const bundle = {
    schemaVersion: 1,
    run: { id: "synthetic-run", kind: "SCREENING", codeVersion: run.code_version, dataVersion },
    config: run.config,
    data: {
      asOfDate: run.as_of_date,
      sources: sources.map((r) => ({
        id: r.id,
        objectPath: r.storage_path,
        fileHash: r.file_hash,
        dataHash: r.data_hash,
        schemaHash: r.schema_hash,
        fileName: r.original_filename,
      })),
    },
  };
  return { row, bundle };
}
describe("bounded private read transport", () => {
  it("uses only exact origin/path and no redirects", async () => {
    const p = objectPath("cloudtrend-data", owner + "/source/test.csv", owner),
      fetcher = vi.fn(async () => new Response("ok"));
    const read = createReadOnlyTransport(
      "https://synthetic.supabase.co",
      "synthetic",
      new Set([p]),
      fetcher,
    );
    expect((await read(p)).toString()).toBe("ok");
    expect(fetcher.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
    });
    await expect(read("/rest/v1/rpc/anything")).rejects.toThrow();
    await expect(read(p, 10, "POST" as any)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects credential origin escape and path traversal", () => {
    for (const url of [
      "http://synthetic.supabase.co",
      "https://evil.example",
      "https://synthetic.supabase.co/path",
      "https://user:password@synthetic.supabase.co",
      "https://synthetic.supabase.co:4430",
    ])
      expect(() => createReadOnlyTransport(url, "key", new Set())).toThrow();
    for (const p of [
      owner + "/../private",
      owner + "/%2e%2e/private",
      "other/source",
      owner + "/x?download=1",
      owner + "/x\\y",
    ])
      expect(() => objectPath("cloudtrend-data", p, owner)).toThrow();
    expect(() => restPath("ledger_actual_transactions", owner, "*", {})).toThrow();
    expect(() => restPath("analysis_runs", owner, "*", { status: "eq.latest" })).toThrow();
  });
  it("rejects response redirects, HTTP failures and oversized payloads", async () => {
    const p = "/rest/v1/analysis_runs";
    for (const response of [new Response("bad", { status: 403 }), new Response("too large")]) {
      const read = createReadOnlyTransport(
        "https://synthetic.supabase.co",
        "key",
        new Set([p]),
        async () => response,
      );
      await expect(read(p, 2)).rejects.toThrow();
    }
    const redirected = new Response("ok");
    Object.defineProperty(redirected, "redirected", { value: true });
    await expect(
      createReadOnlyTransport(
        "https://synthetic.supabase.co",
        "key",
        new Set([p]),
        async () => redirected,
      )(p),
    ).rejects.toThrow();
  });
});
describe("capsule identity and frozen precedence", () => {
  it("accepts exact inert evidence only", async () => {
    const { row } = await fixture();
    expect(await validateCapsule(row, owner, "1")).toEqual(row.payload);
  });
  it.each([
    "owner",
    "hash",
    "approval",
    "unknown",
    "duplicate",
    "path",
    "base64",
    "run",
    "manifest",
  ])("rejects %s tampering even when rehashed", async (kind) => {
    const { row } = await fixture();
    const p = row.payload;
    if (kind === "owner") row.user_id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    if (kind === "hash") row.source_id += "0";
    if (kind === "approval") p.operationalApproval = true;
    if (kind === "unknown") p.runCode = "arbitrary";
    if (kind === "duplicate")
      p.frozenBaseline.orderedSources[1] = p.frozenBaseline.orderedSources[0];
    if (kind === "path") p.readPlan.result.path = "another-owner/private";
    if (kind === "base64") p.files["manifest.json"].content += "\n";
    if (kind === "run") p.readPlan.scope.expectedRun.dataVersion = h;
    if (kind === "manifest") p.capture.manifestSha256 = digest;
    row.source_hash = await hashSeriesValue(p);
    await expect(validateCapsule(row, owner, "1")).rejects.toThrow();
  });
  it("requires original bundle order, config and every source identity, not aggregate only", async () => {
    const { row, bundle } = await fixture();
    expect(() => verifyResultBundle(bundle, row.payload)).not.toThrow();
    const reordered = structuredClone(bundle);
    reordered.data.sources.reverse();
    expect(() => verifyResultBundle(reordered, row.payload)).toThrow();
    const changed = structuredClone(bundle);
    changed.config = { synthetic: false };
    expect(() => verifyResultBundle(changed, row.payload)).toThrow();
    const hashChanged = structuredClone(bundle);
    hashChanged.data.sources[0].schemaHash = "sha256:" + "b".repeat(64);
    expect(() => verifyResultBundle(hashChanged, row.payload)).toThrow();
  });
});
describe("public log and credential boundary", () => {
  it("copies only explicit boolean/count/category values", () => {
    const report = {
      status: "PREFLIGHT_COMPARED_NO_OPERATIONAL_APPROVAL",
      counterfactual: true,
      operationalApproval: false,
      privateSecret: "DO_NOT_PRINT",
      baselineEvidence: { equal: true, differences: ["DO_NOT_PRINT"] },
      candidateEvidence: { equal: false, changedLeafCount: 3 },
      books: {
        O1: {
          baselineReproduced: { equal: true },
          candidatePublication: { equal: false },
          sessionInputsEqualExceptSourceHash: true,
        },
      },
      privatePath: "/private",
    };
    const summary = JSON.stringify(publicSummary(report));
    expect(summary).not.toContain("DO_NOT_PRINT");
    expect(summary).not.toContain("/private");
    expect(summary).toContain('changedEvidenceLeaves":3');
    expect(() => publicSummary({ ...report, status: "SECRET_VALUE" })).toThrow();
    expect(() => publicSummary({ ...report, operationalApproval: true })).toThrow();
  });
  it("does not inherit credentials or arbitrary runtime flags", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "SECRET";
    process.env.GITHUB_TOKEN = "SECRET";
    process.env.NODE_OPTIONS = "--require evil";
    const env = pureEnvironment("/tmp/synthetic");
    expect(env).not.toHaveProperty("SUPABASE_SERVICE_ROLE_KEY");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
    expect(env.NODE_OPTIONS).not.toContain("evil");
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.GITHUB_TOKEN;
    delete process.env.NODE_OPTIONS;
  });
});

describe("complete credentialed materialization is read-only and hash pinned", () => {
  it("materializes only the reviewed ordered plan and rejects an independently wrong capsule hash before other reads", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { materializeCapsule } = await import("./transport");
    const { canonicalSeriesJson } = await import("../../src/lib/ledger/modelSeries");
    const { row, bundle } = await fixture(),
      p = row.payload,
      plan = p.readPlan;
    const sourceBytes = Buffer.from("synthetic,fixture\n");
    p.frozenBaseline.orderedSources.forEach((r: any, i: number) => {
      r.file_hash = rawHash(sourceBytes);
      bundle.data.sources[i].fileHash = r.file_hash;
    });
    const books = new Map<string, any>();
    for (const b of plan.books)
      for (const role of ["previous", "completed"]) {
        const date = role === "previous" ? b.previousDate : b.completedDate;
        const receipts = [...plan.krHistoryDates, plan.scope.targetDate].flatMap((d: string) =>
          ["K", "E", "U"].map((m) => ({ id: `session:${m}:${d}`, record: { sourceHash: h } })),
        );
        const body = { book: "MODEL", bookId: b.seriesId, date, result: { receipts } };
        const stateHash = await hashSeriesValue(body);
        b[role + "StateHash"] = stateHash;
        books.set(b.seriesId + date, {
          series_id: b.seriesId,
          session_date: date,
          state_hash: stateHash,
          payload: { ...body, stateHash, canonicalPayload: canonicalSeriesJson(body) },
        });
      }
    row.source_hash = await hashSeriesValue(p);
    const urls: string[] = [];
    const fetcher: any = async (url: URL, init: any) => {
      urls.push(url.pathname);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(url.origin).toBe("https://synthetic.supabase.co");
      if (url.pathname.startsWith("/rest/")) {
        expect(url.searchParams.get("user_id")).toBe("eq." + owner);
        expect(url.searchParams.get("limit")).toBe("2");
        const table = url.pathname.split("/").at(-1);
        let result: any;
        if (table === "ledger_provenance_archive") result = row;
        else if (table === "analysis_runs")
          result = { ...p.frozenBaseline.run, kind: "SCREENING", status: "COMPLETED" };
        else if (table === "analysis_source_files")
          result = p.frozenBaseline.orderedSources.find(
            (r: any) => "eq." + r.id === url.searchParams.get("id"),
          );
        else if (table === "ledger_model_sessions")
          result = books.get(
            url.searchParams.get("series_id")!.slice(3) +
              url.searchParams.get("session_date")!.slice(3),
          );
        else throw new Error("unexpected table");
        return new Response(JSON.stringify([result]));
      }
      if (url.pathname.includes("/results/")) return new Response(JSON.stringify(bundle));
      if (url.pathname.includes("/source/")) return new Response(sourceBytes);
      const d = url.pathname.split("/").at(-1)!.replace(".json", ""),
        market = url.pathname.split("/").at(-2);
      const payload =
        market === "KR"
          ? { date: d, clock: { sourceHash: h } }
          : { analysis: { date: d }, clock: { sourceHash: h } };
      return new Response(JSON.stringify({ hash: await hashSeriesValue(payload), payload }));
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-test-"));
    try {
      await expect(
        materializeCapsule({
          origin: "https://synthetic.supabase.co",
          key: "synthetic",
          owner,
          revision: "1",
          expectedCapsuleHash: h,
          directory: path.join(root, "denied"),
          fetcher,
        }),
      ).rejects.toThrow();
      expect(urls.length).toBe(1);
      urls.length = 0;
      const filename = await materializeCapsule({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner,
        revision: "1",
        expectedCapsuleHash: row.source_hash,
        directory: path.join(root, "ok"),
        fetcher,
      });
      const input = JSON.parse(fs.readFileSync(filename, "utf8"));
      expect(input.sources.map((r: any) => r.id)).toEqual(
        p.frozenBaseline.orderedSources.map((r: any) => r.id),
      );
      expect(input.fieldPolicy).toBe("TAGGED_COLLECTOR_PROXY_V1_RETAIN_INDEPENDENT");
      expect(input).not.toHaveProperty("key");
      expect(urls[2]).toContain("/results/");
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

it("captures child errors and emits only a validated static phase", async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const { compute } = await import("./runner");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-child-"));
  try {
    const child = path.join(directory, "synthetic.mjs");
    fs.writeFileSync(
      child,
      "import fs from 'node:fs'; import path from 'node:path'; console.log('SYNTHETIC_PRIVATE_MARKER');console.error('SYNTHETIC_PRIVATE_MARKER');fs.writeFileSync(path.join(path.dirname(process.argv[3]),'failure-summary.json'),JSON.stringify({phase:'OVERLAY_DERIVATION',secret:'SYNTHETIC_PRIVATE_MARKER'}));process.exitCode=1;",
    );
    const summary = compute(directory, child);
    expect(summary).toMatchObject({
      status: "PREFLIGHT_REJECTED",
      phase: "OVERLAY_DERIVATION",
      operationalApproval: false,
    });
    expect(JSON.stringify(summary)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

it("the compiled entry exits nonzero for sanitized child rejection", async () => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { buildSync } = await import("esbuild");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-entry-"));
  try {
    const code = path.join(root, "kr-vintage-preflight-code"),
      privateDir = path.join(root, "kr-vintage-preflight-private");
    fs.mkdirSync(code);
    fs.mkdirSync(privateDir);
    fs.writeFileSync(
      path.join(code, "pure.mjs"),
      "console.error('SYNTHETIC_PRIVATE_MARKER');process.exitCode=1;",
    );
    const entry = path.join(root, "entry.mjs");
    buildSync({
      entryPoints: ["scripts/kr-vintage-preflight/entry.ts"],
      outfile: entry,
      bundle: true,
      platform: "node",
      format: "esm",
      logLevel: "silent",
    });
    const result = spawnSync(process.execPath, [entry, "compute", "1"], {
      env: { ...pureEnvironment(root), RUNNER_TEMP: root },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("PREFLIGHT_REJECTED");
    expect(result.stdout + result.stderr).not.toContain("SYNTHETIC_PRIVATE_MARKER");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
