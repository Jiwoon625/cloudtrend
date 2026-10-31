/* eslint-disable @typescript-eslint/no-explicit-any -- malformed synthetic transport fixtures */
import { describe, it, expect } from "vitest";
import {
  reader,
  normalizeGeneration,
  encodeEvidence,
  decodeEvidence,
  appendEvidence,
  validateRequest,
  snapshot,
  validatePriorRecoveryPins,
  capturePriorRecovery,
  assertPriorRecoveryFresh,
} from "./transport";
import { encodeRecoveryEvidence } from "../kr-adjusted-recovery/evidence-storage";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
const owner = "11111111-1111-4111-8111-111111111111";
const origin = "https://example.supabase.co";
const hash = "sha256:" + "a".repeat(64);
const generation = {
  id: "object",
  version: "generation",
  eTag: "etag",
  size: 2,
  updatedAt: "2026-10-30T01:00:00.000Z",
};
const info = {
  id: "object",
  version: "generation",
  etag: '"etag"',
  size: 2,
  last_modified: generation.updatedAt,
};
describe("new retrospective transport boundary", () => {
  it("normalizes exact identity metadata and rejects absent generation", () => {
    expect(normalizeGeneration(info)).toEqual(generation);
    expect(() => normalizeGeneration({ ...info, version: null })).toThrow();
  });
  it("forces owner filter and GET only for rows", async () => {
    let seen = "";
    const r = reader({
      origin,
      key: "test",
      owner,
      fetcher: async (url, init) => {
        seen = String(url);
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        expect((init?.headers as any)["Accept-Encoding"]).toBe("identity");
        return new Response(JSON.stringify([{ user_id: owner }]), { status: 200 });
      },
    });
    expect(await r.rows("portfolio_ledgers", {}, 2)).toHaveLength(1);
    expect(new URL(seen).searchParams.get("user_id")).toBe("eq." + owner);
    await expect(r.rows("auth.users", {}, 2)).rejects.toThrow();
    await expect(r.rows("portfolio_ledgers", { user_id: "eq.attacker" }, 2)).rejects.toThrow();
  });
  it("rejects foreign rows and truncation rather than partial inventory", async () => {
    for (const rows of [[{ user_id: "foreign" }], [{ user_id: owner }, { user_id: owner }]]) {
      const r = reader({
        origin,
        key: "test",
        owner,
        fetcher: async () => new Response(JSON.stringify(rows)),
      });
      await expect(r.rows("portfolio_ledgers", {}, 2)).rejects.toThrow();
    }
  });
  it("pins info before and after object bytes", async () => {
    const calls: string[] = [];
    const r = reader({
      origin,
      key: "test",
      owner,
      fetcher: async (url) => {
        calls.push(String(url));
        return new Response(String(url).includes("/info/") ? JSON.stringify(info) : "{}");
      },
    });
    const result = await r.object(owner + "/source.json", undefined, generation);
    expect(result.bytes.toString()).toBe("{}");
    expect(calls.length).toBe(3);
  });
  it("rejects generation drift and cross-owner object paths", async () => {
    let n = 0;
    const r = reader({
      origin,
      key: "test",
      owner,
      fetcher: async (url) =>
        new Response(
          String(url).includes("/info/")
            ? JSON.stringify({ ...info, version: ++n === 1 ? "generation" : "changed" })
            : "{}",
        ),
    });
    await expect(r.object(owner + "/source.json")).rejects.toThrow();
    await expect(r.object("foreign/source.json")).rejects.toThrow();
    await expect(r.object(owner + "/../secret")).rejects.toThrow();
  });
  it("evidence binds compressed and logical domains", async () => {
    const value = {
      version: "kr-final-retrospective-plan-v1",
      operationalApproval: false,
      proof: [1, 2, 3],
    };
    const e = await encodeEvidence(value);
    expect(await decodeEvidence(e.envelope, e.storageHash, e.hash)).toEqual(value);
    await expect(
      decodeEvidence({ ...e.envelope, payload: "AAAA" }, e.storageHash, e.hash),
    ).rejects.toThrow();
    await expect(decodeEvidence(e.envelope, e.storageHash, hash)).rejects.toThrow();
  });
  it("rejects oversize declared gzip output before inflation", async () => {
    const e = await encodeEvidence({ test: true });
    const invalid = { ...e.envelope, bytes: 1024 * 1024 * 1024 };
    await expect(decodeEvidence(invalid, await hashSeriesValue(invalid), e.hash)).rejects.toThrow();
  });
  it("unknown POST outcome stops after exact readback; explicit resume reuses committed row", async () => {
    let saved: any = null,
      posts = 0;
    const value = { version: "test", historicalAvailabilityClaim: false };
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === "POST") {
        posts++;
        saved = JSON.parse(String(init.body));
        throw new Error("network after commit");
      }
      return new Response(JSON.stringify(saved ? [saved] : []));
    };
    const o = { origin, key: "test", owner, fetcher };
    await expect(appendEvidence(o, "plan", value)).rejects.toThrow(
      "EVIDENCE_APPEND_SERVER_UNHEALTHY:NETWORK",
    );
    expect(posts).toBe(1);
    await appendEvidence(o, "plan", value);
    expect(posts).toBe(1);
  });
  it("failed append does not retry or claim success", async () => {
    let posts = 0;
    await expect(
      appendEvidence(
        {
          origin,
          key: "test",
          owner,
          fetcher: async (_url, init) => {
            if (init?.method === "POST") {
              posts++;
              return new Response("", { status: 500 });
            }
            return new Response("[]");
          },
        },
        "plan",
        { test: 1 },
      ),
    ).rejects.toThrow();
    expect(posts).toBe(1);
  });
  it("validates exact request hash and forbids operational/preopen claims", async () => {
    const request: any = {
      version: "kr-final-retrospective-request-v1",
      owner,
      codeCommit: "b".repeat(40),
      operationalApproval: false,
      historicalAvailabilityClaim: false,
      modelInventoryProjection: "series-date-state-recorded-v1",
      predecessorDate: "2026-10-27",
      targetDates: ["2026-10-28", "2026-10-29"],
      preparedAt: "2026-10-30T01:00:00Z",
      config: {},
      expected: { sources: hash, models: hash, registries: hash, actual: hash },
      legacy: [
        { path: owner + "/shadow/kospi-confirm1-bear-rsaccel-v1/latest.json", hash, generation },
      ],
    };
    expect(
      await validateRequest(request, await hashSeriesValue(request), owner, request.codeCommit),
    ).toBe(request);
    const lineage = await lineageFixture();
    const v2: any = {
      ...request,
      version: "kr-final-retrospective-request-v2",
      priorRecovery: lineage.pins,
    };
    expect(await validateRequest(v2, await hashSeriesValue(v2), owner, request.codeCommit)).toBe(
      v2,
    );
    for (const changed of [
      { ...v2, priorRecovery: undefined },
      { ...v2, extra: true },
      { ...request, priorRecovery: lineage.pins },
    ]) {
      const clean = JSON.parse(JSON.stringify(changed));
      await expect(
        validateRequest(clean, await hashSeriesValue(clean), owner, request.codeCommit),
      ).rejects.toThrow();
    }
    for (const patch of [
      { historicalAvailabilityClaim: true },
      { owner: "other" },
      { codeCommit: "c".repeat(40) },
      { targetDates: [] },
    ]) {
      const changed = { ...request, ...patch };
      await expect(
        validateRequest(changed, await hashSeriesValue(changed), owner, request.codeCommit),
      ).rejects.toThrow();
    }
  });
  it("full snapshot enforces row-count bounds and ownership", async () => {
    const fetcher: typeof fetch = async (url) =>
      new Response(
        JSON.stringify([
          {
            user_id: owner,
            ...(String(url).includes("analysis_source_files") ? { id: "source" } : {}),
          },
        ]),
      );
    const s = await snapshot({ origin, key: "test", owner, fetcher });
    expect(s.sources).toHaveLength(1);
    expect(s.actual.portfolio_ledgers).toHaveLength(1);
  });
});

describe("legacy namespace inventory", () => {
  it("lists only bounded owner legacy prefix using read-only POST", async () => {
    const { legacyInventory } = await import("./transport");
    const bodies: any[] = [];
    const paths = await legacyInventory({
      origin,
      key: "test",
      owner,
      fetcher: async (url, init) => {
        expect(String(url)).toBe(origin + "/storage/v1/object/list/cloudtrend-data");
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return new Response(
          JSON.stringify(
            body.prefix.endsWith("/sessions")
              ? [{ name: "2026-10-27.json", id: "obj" }]
              : [
                  { name: "sessions", id: null },
                  { name: "latest.json", id: "obj" },
                ],
          ),
        );
      },
    });
    expect(paths).toHaveLength(2);
    expect(
      bodies.every((x) => x.prefix.startsWith(owner + "/shadow/kospi-confirm1-bear-rsaccel-v1")),
    ).toBe(true);
  });
  it("rejects traversal, oversized inventory and failed listing", async () => {
    const { legacyInventory } = await import("./transport");
    for (const value of [
      [{ name: "../escape", id: null }],
      Array.from({ length: 257 }, (_, i) => ({ name: String(i), id: "obj" })),
    ])
      await expect(
        legacyInventory({
          origin,
          key: "test",
          owner,
          fetcher: async () => new Response(JSON.stringify(value)),
        }),
      ).rejects.toThrow();
    await expect(
      legacyInventory({
        origin,
        key: "test",
        owner,
        fetcher: async () => new Response("", { status: 403 }),
      }),
    ).rejects.toThrow();
  });
});

describe("preservation guards", () => {
  it("rejects unrelated artifacts and actual drift; permits only exact planned appends", async () => {
    const { assertCaptureFresh } = await import("./transport");
    const tables: Record<string, any[]> = {
      analysis_source_files: [{ user_id: owner, id: "source" }],
      ledger_model_sessions: [
        {
          user_id: owner,
          series_id: "old",
          session_date: "2026-10-27",
          payload: { immutable: true },
        },
      ],
      ledger_model_series: [{ user_id: owner, series_id: "old" }],
      portfolio_ledgers: [{ user_id: owner, state: "original" }],
      us_actual_portfolio_ledgers: [{ user_id: owner, state: "original" }],
    };
    let archive: any[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      if (init?.method === "POST") return new Response("[]");
      const u = new URL(String(url)),
        table = u.pathname.split("/").at(-1)!;
      let rows = tables[table] ?? [];
      if (table === "ledger_provenance_archive")
        rows = u.searchParams.get("source_id")?.includes("october-input") ? archive : [];
      return new Response(JSON.stringify(rows));
    };
    const o = { origin, key: "test", owner, fetcher };
    const b = { ...(await snapshot(o)), archiveRows: [], preparedRows: [], vintageRows: [] };
    const c: any = { preservationBaseline: b, captureManifest: { sourceObjects: [], legacy: [] } };
    await assertCaptureFresh(o, c);
    tables.portfolio_ledgers = [{ user_id: owner, state: "tampered" }];
    await expect(assertCaptureFresh(o, c)).rejects.toThrow();
    tables.portfolio_ledgers = b.actual.portfolio_ledgers;
    const expected = {
      source_id: "october-input:KR:2026-10-28:abc",
      source_hash: hash,
      payload: { exact: true },
    };
    archive = [{ ...expected, user_id: owner }];
    await expect(assertCaptureFresh(o, c)).rejects.toThrow();
    await assertCaptureFresh(o, c, [], {}, [expected]);
    archive[0].payload = { wrong: true };
    await expect(assertCaptureFresh(o, c, [], {}, [expected])).rejects.toThrow();
  });
});

describe("capture serialization safe diagnostics", () => {
  it("emits only fixed statuses and measured UTF8 byte counts", async () => {
    const { serializeCaptureWithDiagnostics } = await import("./transport");
    const events: unknown[] = [];
    const text = serializeCaptureWithDiagnostics(
      { owner: "PRIVATE_OWNER_SENTINEL", dataset: { text: "비공개" } },
      (e) => events.push(e),
    );
    expect(events).toEqual([
      { status: "CAPTURE_JSON_START" },
      { status: "CAPTURE_JSON_BYTES", bytes: Buffer.byteLength(text) },
    ]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE_OWNER_SENTINEL");
    expect(JSON.stringify(events)).not.toContain("비공개");
  });
  it("rejects undefined/nonfinite/cyclic data without exposing values or exception text", async () => {
    const { serializeCaptureWithDiagnostics } = await import("./transport");
    const cycle: Record<string, unknown> = { PRIVATE_FIELD_SENTINEL: "PRIVATE_VALUE_SENTINEL" };
    cycle.self = cycle;
    for (const value of [{ PRIVATE_FIELD_SENTINEL: undefined }, { value: Infinity }, cycle]) {
      const events: unknown[] = [];
      expect(() => serializeCaptureWithDiagnostics(value, (e) => events.push(e))).toThrow(
        "CAPTURE_JSON_CANONICAL_REJECTED",
      );
      expect(events).toEqual([
        { status: "CAPTURE_JSON_START" },
        {
          status: "CAPTURE_JSON_CANONICAL_REJECTED",
          errorCategory: value === cycle ? "RANGE_ERROR" : "CANONICAL_VALUE_ERROR",
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("PRIVATE");
    }
  });
  it("keeps the exact256MiB bound and rejects invalid measured sizes without allocation", async () => {
    const { assertCaptureByteLength, CAPTURE_JSON_MAX_BYTES } = await import("./transport");
    expect(CAPTURE_JSON_MAX_BYTES).toBe(256 * 1024 * 1024);
    expect(() => assertCaptureByteLength(CAPTURE_JSON_MAX_BYTES)).not.toThrow();
    for (const n of [0, -1, NaN, Infinity, 1.5, CAPTURE_JSON_MAX_BYTES + 1])
      expect(() => assertCaptureByteLength(n)).toThrow("CAPTURE_JSON_LIMIT_REJECTED");
  });
});
it("reports safe component categories and sizes when whole capture cannot canonicalize", async () => {
  const { serializeCaptureWithDiagnostics } = await import("./transport");
  const events: unknown[] = [];
  expect(() =>
    serializeCaptureWithDiagnostics(
      { dataset: { private: undefined }, preservationBaseline: { private: "PRIVATE_SENTINEL" } },
      (e) => events.push(e),
    ),
  ).toThrow("CAPTURE_JSON_CANONICAL_REJECTED");
  expect(events).toEqual([
    { status: "CAPTURE_JSON_START" },
    { status: "CAPTURE_JSON_CANONICAL_REJECTED", errorCategory: "CANONICAL_VALUE_ERROR" },
    {
      status: "CAPTURE_COMPONENT_CANONICAL_REJECTED",
      componentIndex: 0,
      errorCategory: "CANONICAL_VALUE_ERROR",
    },
    {
      status: "CAPTURE_COMPONENT_BASELINE_BYTES",
      bytes: Buffer.byteLength('{"private":"PRIVATE_SENTINEL"}'),
    },
  ]);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
});

it("streamgzip roundtrips multi-chunk Unicode and rejects noncanonical whitespace despite valid transport hashes", async () => {
  const { gzipSync } = await import("node:zlib");
  const { rawHash } = await import("../kr-vintage-preflight/transport");
  const value = {
    proof: "한글😀".repeat(20000),
    rows: Array.from({ length: 500 }, (_, n) => ({ n, text: "synthetic" })),
  };
  const encoded = await encodeEvidence(value);
  expect(await decodeEvidence(encoded.envelope, encoded.storageHash, encoded.hash)).toEqual(value);
  const raw = Buffer.from('{ "noncanonical": true }'),
    compressed = gzipSync(raw);
  const envelope = {
    version: "kr-final-retrospective-evidence-gzip-v1",
    hash: rawHash(raw),
    bytes: raw.length,
    compressedHash: rawHash(compressed),
    payload: compressed.toString("base64"),
  };
  await expect(
    decodeEvidence(envelope, await hashSeriesValue(envelope), envelope.hash),
  ).rejects.toThrow();
});

describe("exact immutable envelope readback without redundant decompression", () => {
  it("rejects a different valid envelope for the same logical payload", async () => {
    const { gzipSync } = await import("node:zlib");
    const { canonicalSeriesJson } = await import("../../src/lib/ledger/modelSeries");
    const { rawHash } = await import("../kr-vintage-preflight/transport");
    const value = { synthetic: "same-logical-payload".repeat(1000) },
      expected = await encodeEvidence(value);
    const different = gzipSync(Buffer.from(canonicalSeriesJson(value)), { level: 1 });
    const alternate = {
      ...expected.envelope,
      payload: different.toString("base64"),
      compressedHash: rawHash(different),
    };
    const alternateHash = await hashSeriesValue(alternate);
    expect(alternateHash).not.toBe(expected.storageHash);
    expect(await decodeEvidence(alternate, alternateHash, expected.hash)).toEqual(value);
    let posts = 0;
    await expect(
      appendEvidence(
        {
          origin,
          key: "test",
          owner,
          fetcher: async (_url, init) => {
            if (init?.method === "POST") posts++;
            return new Response(
              JSON.stringify([{ user_id: owner, source_hash: alternateHash, payload: alternate }]),
            );
          },
        },
        "plan",
        value,
      ),
    ).rejects.toThrow();
    expect(posts).toBe(0);
  });
  it("rejects tampered row hashes or envelopes and reuses only exact envelopes", async () => {
    const value = { synthetic: "immutable" },
      encoded = await encodeEvidence(value);
    for (const row of [
      { source_hash: hash, payload: encoded.envelope },
      {
        source_hash: encoded.storageHash,
        payload: { ...encoded.envelope, bytes: encoded.envelope.bytes + 1 },
      },
    ])
      await expect(
        appendEvidence(
          {
            origin,
            key: "test",
            owner,
            fetcher: async () => new Response(JSON.stringify([{ user_id: owner, ...row }])),
          },
          "plan",
          value,
        ),
      ).rejects.toThrow();
    let posts = 0;
    expect(
      await appendEvidence(
        {
          origin,
          key: "test",
          owner,
          fetcher: async (_url, init) => {
            if (init?.method === "POST") posts++;
            return new Response(
              JSON.stringify([
                {
                  user_id: owner,
                  source_id: "kr-final-retrospective-plan:" + encoded.hash.slice(7),
                  source_revision: "1",
                  source_hash: encoded.storageHash,
                  payload: encoded.envelope,
                },
              ]),
            );
          },
        },
        "plan",
        value,
      ),
    ).toEqual({ hash: encoded.hash, storageHash: encoded.storageHash });
    expect(posts).toBe(0);
  });
});

describe("bounded public-safe compute diagnostics", () => {
  it("classifies only exact static messages and never echoes private exception values", async () => {
    const { classifyFinalComputeFailure } = await import("./contracts");
    expect(classifyFinalComputeFailure(new Error("Frozen KOSPI policy/config differs"))).toEqual({
      category: "FROZEN_LEGACY",
      code: "FROZEN_KOSPI_POLICY_CONFIG_DIFFERS",
    });
    for (const error of [
      new Error("PRIVATE_OWNER_TOKEN_SENTINEL"),
      new Error("Frozen KOSPI policy/config differs PRIVATE_SENTINEL"),
      { message: "Frozen KOSPI policy/config differs" },
    ])
      expect(classifyFinalComputeFailure(error)).toEqual({ category: "UNKNOWN" });
    expect(classifyFinalComputeFailure(new RangeError("PRIVATE_RANGE_SENTINEL"))).toEqual({
      category: "RANGE_ERROR",
    });
    expect(
      classifyFinalComputeFailure(
        Object.assign(new Error("PRIVATE_FILE_PATH"), { code: "ENOSPC" }),
      ),
    ).toEqual({ category: "FILE_IO", code: "IO_ENOSPC" });
  });
  it("accepts exact stage/failure records and ignores raw malformed unknown or extra-field lines", async () => {
    const { parseFinalComputeDiagnostics } = await import("./contracts");
    const records = [
      { kind: "STAGE", stage: "LEGACY_PREPARE" },
      {
        kind: "FAILURE",
        stage: "KOSPI_FROZEN_CONFIG",
        category: "FROZEN_LEGACY",
        code: "FROZEN_KOSPI_POLICY_CONFIG_DIFFERS",
      },
    ];
    const bad = [
      "PRIVATE_RAW_STACK",
      JSON.stringify({ kind: "STAGE", stage: "PRIVATE_STAGE" }),
      JSON.stringify({ kind: "STAGE", stage: "HYDRATE", private: "PRIVATE_SECRET" }),
      JSON.stringify({
        kind: "FAILURE",
        stage: "HYDRATE",
        category: "GUARD",
        code: "PRIVATE_CODE",
      }),
      JSON.stringify({
        kind: "FAILURE",
        stage: "HYDRATE",
        category: "GUARD",
        code: "FROZEN_KOSPI_POLICY_CONFIG_DIFFERS",
      }),
      "null",
      "[]",
      "{bad",
    ];
    const result = parseFinalComputeDiagnostics(
      [...bad, ...records.map((x) => JSON.stringify(x))].join("\n"),
    );
    expect(result).toEqual(records);
    expect(JSON.stringify(result)).not.toContain("PRIVATE");
  });
  it("bounds stderr line size and record count without forwarding arbitrary text", async () => {
    const { parseFinalComputeDiagnostics } = await import("./contracts");
    const line = JSON.stringify({ kind: "STAGE", stage: "HYDRATE" });
    expect(parseFinalComputeDiagnostics(Array(300).fill(line).join("\n"))).toHaveLength(256);
    expect(parseFinalComputeDiagnostics("x".repeat(65537))).toEqual([]);
    expect(parseFinalComputeDiagnostics("x".repeat(513) + "\n" + line)).toEqual([
      { kind: "STAGE", stage: "HYDRATE" },
    ]);
  });
  it("sanitizes child exit numeric bounds signals and timeout independently from stderr", async () => {
    const { summarizeFinalComputeExit } = await import("./contracts");
    expect(summarizeFinalComputeExit({ status: 137, signal: "SIGKILL" })).toMatchObject({
      exitCode: 137,
      signal: "SIGKILL",
      timeout: false,
      spawnFailure: false,
    });
    expect(
      summarizeFinalComputeExit({
        status: null,
        signal: "SIGTERM",
        error: { code: "ETIMEDOUT", message: "PRIVATE_SECRET" },
      }),
    ).toMatchObject({ exitCode: null, signal: "SIGTERM", timeout: true, errorCategory: "TIMEOUT" });
    for (const status of [-1, 256, Infinity, NaN, "1"]) {
      const value = summarizeFinalComputeExit({
        status,
        signal: "PRIVATE_SIGNAL",
        error: { code: "PRIVATE_CODE", message: "PRIVATE_MESSAGE" },
      });
      expect(value.exitCode).toBeNull();
      expect(value.signal).toBe("OTHER");
      expect(JSON.stringify(value)).not.toContain("PRIVATE");
    }
  });
  it("actual pure CLI rejects wrong capture pins before creating a plan and exposes no private input", async () => {
    const fs = await import("node:fs"),
      os = await import("node:os"),
      path = await import("node:path");
    const { spawnSync } = await import("node:child_process");
    const { build } = await import("esbuild");
    const { parseFinalComputeDiagnostics } = await import("./contracts");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "final-compute-diagnostic-test-"));
    fs.chmodSync(dir, 0o700);
    try {
      const executable = path.join(dir, "pure.mjs"),
        input = path.join(dir, "capture.json"),
        output = path.join(dir, "plan.json");
      await build({
        entryPoints: ["scripts/kr-final-retrospective/pure-entry.ts"],
        outfile: executable,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
        logLevel: "silent",
      });
      fs.writeFileSync(
        input,
        JSON.stringify({
          codeCommit: "a".repeat(40),
          captureManifest: { requestHash: hash },
          privateValue: "PRIVATE_OWNER_TOKEN_SENTINEL",
        }),
        { mode: 0o600 },
      );
      const child = spawnSync(process.execPath, [executable, input, output, "b".repeat(40), hash], {
        encoding: "utf8",
        env: { PATH: process.env.PATH },
        maxBuffer: 65536,
        timeout: 20000,
      });
      expect(child.status).toBe(1);
      expect(fs.existsSync(output)).toBe(false);
      expect(child.stdout).toBe("");
      expect(child.stderr).not.toContain("PRIVATE_OWNER_TOKEN_SENTINEL");
      expect(child.stderr).not.toContain(dir);
      expect(parseFinalComputeDiagnostics(child.stderr)).toContainEqual({
        kind: "FAILURE",
        stage: "IDENTITY",
        category: "GUARD",
        code: "PURE_CAPTURE_IDENTITY_REJECTED",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});

async function lineageFixture() {
  const prep = await encodeRecoveryEvidence(
    { version: "kr-adjusted-recovery-preparation-v1", operationalApproval: false, synthetic: true },
    "PREPARATION",
  );
  const plan = await encodeRecoveryEvidence(
    {
      version: "kr-adjusted-recovery-full-plan-v1",
      operationalApproval: false,
      preparationHash: prep.receiptHash,
    },
    "FULL_PLAN",
  );
  const approval = { version: "synthetic-approval", fullPlanHash: plan.receiptHash };
  const terminal = { version: "synthetic-terminal", fullPlanHash: plan.receiptHash };
  const ah = await hashSeriesValue(approval),
    th = await hashSeriesValue(terminal);
  const pins: any = {
    version: "kr-final-prior-recovery-lineage-v1",
    preparation: {
      sourceId: `kr-adjusted-recovery-preparation:${"a".repeat(64)}:${prep.receiptHash.slice(7)}`,
      sourceRevision: "1",
      storageHash: prep.storageHash,
      logicalHash: prep.receiptHash,
    },
    fullPlan: {
      sourceId: `kr-adjusted-recovery-full-plan:${"b".repeat(64)}`,
      sourceRevision: "1",
      storageHash: plan.storageHash,
      logicalHash: plan.receiptHash,
    },
    approval: {
      sourceId: `kr-adjusted-recovery-apply-approval:${plan.receiptHash.slice(7)}`,
      sourceRevision: "1",
      storageHash: ah,
      logicalHash: ah,
    },
    terminal: {
      sourceId: `kr-adjusted-recovery-model-stage:${th.slice(7)}`,
      sourceRevision: "1",
      storageHash: th,
      logicalHash: th,
    },
  };
  const payloads: any = { preparation: prep.payload, fullPlan: plan.payload, approval, terminal };
  const rows = Object.fromEntries(
    Object.entries(pins)
      .filter(([k]) => k !== "version")
      .map(([role, p]: any) => [
        p.sourceId,
        {
          user_id: owner,
          source_id: p.sourceId,
          source_revision: "1",
          source_hash: p.storageHash,
          payload: payloads[role],
          recorded_at: "2026-10-29T21:32:45.58604+00:00",
          extra_metadata: { kept: true },
        },
      ]),
  );
  const connection = {
    origin,
    key: "test",
    owner,
    fetcher: async (url: any, init: any) => {
      expect(init.method).toBe("GET");
      const q = new URL(String(url)).searchParams;
      expect(q.get("user_id")).toBe("eq." + owner);
      expect(q.get("source_revision")).toBe("eq.1");
      const row = rows[q.get("source_id")!.slice(3)];
      return new Response(JSON.stringify(row ? [row] : []), { status: 200 });
    },
  };
  return { pins, rows, connection };
}
describe("complete prior recovery lineage transport", () => {
  it("retains all four complete original payloads and exact full-row freshness", async () => {
    const f = await lineageFixture();
    const result = await capturePriorRecovery(f.connection, f.pins);
    for (const role of ["preparation", "fullPlan", "approval", "terminal"] as const) {
      expect(result[role].payload).toEqual(f.rows[f.pins[role].sourceId].payload);
      expect(result[role].rowHash).toBe(await hashSeriesValue(f.rows[f.pins[role].sourceId]));
    }
    await assertPriorRecoveryFresh(f.connection, result);
    f.rows[f.pins.preparation.sourceId].extra_metadata.kept = false;
    await expect(assertPriorRecoveryFresh(f.connection, result)).rejects.toThrow();
  });
  it("rejects unknown keys, wrong role identities, revisions and hash domains", async () => {
    const { pins } = await lineageFixture();
    for (const mutate of [
      (p: any) => (p.extra = true),
      (p: any) => (p.preparation.extra = true),
      (p: any) => (p.preparation.sourceRevision = "2"),
      (p: any) => (p.preparation.sourceId = p.fullPlan.sourceId),
      (p: any) => (p.approval.sourceId = "kr-adjusted-recovery-apply-approval:" + "f".repeat(64)),
      (p: any) => (p.terminal.storageHash = hash),
      (p: any) => delete p.terminal,
    ]) {
      const p = structuredClone(pins);
      mutate(p);
      expect(() => validatePriorRecoveryPins(p)).toThrow();
    }
  });
  it("rejects absent, foreign-owner, wrong-identity and tampered archived rows", async () => {
    for (const mutate of [
      (f: any) => delete f.rows[f.pins.preparation.sourceId],
      (f: any) => (f.rows[f.pins.preparation.sourceId].user_id = "other"),
      (f: any) => (f.rows[f.pins.preparation.sourceId].source_revision = "2"),
      (f: any) => (f.rows[f.pins.preparation.sourceId].source_id = "other"),
      (f: any) => (f.rows[f.pins.preparation.sourceId].payload.payload = "AAAA"),
    ]) {
      const f = await lineageFixture();
      mutate(f);
      await expect(capturePriorRecovery(f.connection, f.pins)).rejects.toThrow();
    }
  });
  it("rejects captured evidence schema, owner or payload tampering before freshness", async () => {
    const f = await lineageFixture(),
      result = await capturePriorRecovery(f.connection, f.pins);
    for (const mutate of [
      (p: any) => (p.preparation.userId = "other"),
      (p: any) => (p.preparation.extra = true),
      (p: any) => (p.preparation.payload.payload = "AAAA"),
      (p: any) => (p.preparation.rowHash = hash),
    ]) {
      const p = structuredClone(result);
      mutate(p);
      await expect(assertPriorRecoveryFresh(f.connection, p)).rejects.toThrow();
    }
  });
});

it("diagnosis rejects ordinary plan or incomplete blocked payload before any I/O", async () => {
  let calls = 0;
  const connection = {
    origin,
    key: "test",
    owner,
    fetcher: async () => {
      calls++;
      return new Response("[]");
    },
  };
  for (const payload of [
    { version: "kr-final-retrospective-plan-v1" },
    {
      version: "kr-final-retrospective-blocked-v1",
      status: "BLOCKED",
      plan: {},
      operationalApproval: false,
    },
    {
      version: "kr-final-retrospective-blocked-v1",
      status: "BLOCKED",
      plan: null,
      operationalApproval: true,
    },
  ])
    await expect(appendEvidence(connection, "diagnosis", payload)).rejects.toThrow();
  expect(calls).toBe(0);
});
