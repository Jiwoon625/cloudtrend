/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it, vi } from "vitest";
// Isolate existing capsule/vintage/publication schema validators, NOT freshness or transport.
// Their real-validator suites remain required; all model/archive cryptographic checks below are real.
vi.mock("../kr-vintage-preflight/transport", async (load) => ({
  ...(await load<any>()),
  validateCapsule: async (row: any) => row.payload,
}));
vi.mock("../../src/lib/ledger/krSourceVintage", () => ({
  verifyKrSourceVintagePrivateApproval: async () => ({}),
}));
vi.mock("../../src/lib/krScreeningPublication", () => ({
  krSourcePublication: (source: any) => {
    if (source.validation_result.krPublication.synthetic !== true)
      throw new Error("synthetic declaration rejected");
    return { phase: "FINAL" };
  },
}));
import { recheckPreparationPins } from "./freshness";
import { recoveryFixture, OWNER, DATES } from "./recovery-model-plan-fixture";
import { verifyArchivePrefixBodies } from "./archive-domain";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
import { PLAN } from "./transport";
import { CAPSULE_PREFIX } from "../kr-vintage-preflight/transport";
import { APPEND_PHASES } from "./append-phases";
let fixture: any;
beforeAll(async () => {
  const f = await recoveryFixture(),
    h = "sha256:" + "a".repeat(64);
  const domain = await Promise.all(
    f.predecessors.map(async ({ series, run }) => ({
      series,
      run,
      pin: {
        seriesId: series.bookId,
        sessionDate: run.receipt.date,
        stateHash: run.stateHash,
        payloadHash: await hashSeriesValue(run),
      },
    })),
  );
  const archives = await Promise.all(
    [
      ...f.original.archives.values(),
      ...["2026-10-06", "2026-10-07", "2026-10-08"].map((date) => ({ date, synthetic: true })),
    ].map(async (payload) => {
      const hash = await hashSeriesValue(payload);
      return {
        payload,
        reference: {
          date: payload.date,
          sourceId: `october-input:KR:${payload.date}:${hash.slice(7)}`,
          sourceRevision: "1",
          sourceHash: hash,
          payloadHash: hash,
        },
      };
    }),
  );
  const prefix = await verifyArchivePrefixBodies(domain, archives);
  const integrated = f.integrated.map((chain) => ({
    previous: chain.find((x) => x.receipt.date === "2026-10-23")!,
    completed: chain.find((x) => x.receipt.date === "2026-10-26")!,
  }));
  const books = integrated.map(({ previous, completed }) => ({
    kind: previous.registry.policy.kind,
    seriesId: previous.registry.bookId,
    previousDate: "2026-10-23",
    previousStateHash: previous.stateHash,
    completedDate: "2026-10-26",
    completedStateHash: completed.stateHash,
  }));
  const capsule = {
    capture: { manifestSha256: h.slice(7) },
    frozenBaseline: { orderedSources: [{ synthetic: true }] },
    readPlan: { books, previousDate: "2026-10-23", krHistoryDates: DATES.slice(0, 10) },
  };
  const capsuleHash = await hashSeriesValue(capsule),
    emptyHash = await hashSeriesValue({});
  const source = {
    id: "synthetic-final",
    max_date: "2026-10-27",
    file_hash: h,
    data_hash: h,
    schema_hash: h,
    validation_result: { krPublication: { synthetic: true } },
  };
  const plan = {
    version: "kr-adjusted-recovery-read-plan-v1",
    kind: "RECOVERY_PREPARATION_PLAN_ONLY",
    operationalApproval: false,
    historicalAvailabilityClaim: false,
    capsuleHash,
    preparedAt: "2026-10-28T13:00:00Z",
    scope: { symbol: "999999", predecessorDate: "2026-10-23", dates: ["2026-10-26", "2026-10-27"] },
    corporateActionEvidenceUrl: "https://dart.fss.or.kr/synthetic",
    models: domain.map((x) => x.pin),
    archives: archives.map((x) => x.reference),
    vintageV1: {
      registry: {},
      receipt: {},
      registryHash: emptyHash,
      receiptHash: emptyHash,
      registryAuditId: 1,
      receiptAuditId: 2,
    },
    finalPublication: {
      sourceId: source.id,
      fileHash: h,
      dataHash: h,
      schemaHash: h,
      publicationHash: await hashSeriesValue(source.validation_result.krPublication),
    },
    kospi: {
      expectedPredecessorDate: "2026-10-23",
      revisionId: "october14-retrospective-v1",
      objects: Array.from({ length: 19 }, (_, i) => ({
        path:
          OWNER +
          `/shadow/kospi-confirm1-bear-rsaccel-v1/sessions/2026-10-${String(i + 1).padStart(2, "0")}.json`,
        metadata: {
          id: "synthetic-" + i,
          version: "generation",
          eTag: "opaque",
          size: 100,
          updatedAt: "2026-10-28T10:00:00Z",
        },
      })),
    },
  };
  const planHash = await hashSeriesValue(plan);
  const evidence = new Map<string, any>();
  for (const [market, dates] of [
    ["KR", [...DATES.slice(0, 10), "2026-10-26"]],
    ["US", ["2026-10-23", "2026-10-26"]],
  ] as const)
    for (const date of dates) {
      const payload = { synthetic: market + date };
      evidence.set(market + date, { payload, hash: await hashSeriesValue(payload) });
    }
  const payload = {
    scope: plan.scope,
    preparedAt: plan.preparedAt,
    modelPins: plan.models,
    archiveReferences: plan.archives,
    finalPublication: plan.finalPublication,
    vintageV1: plan.vintageV1,
    kospi: { generationPins: plan.kospi.objects },
    sourceRosterHash: await hashSeriesValue(capsule.frozenBaseline.orderedSources),
    captureManifestHash: h,
    archiveObservationInventory: { models: domain, executionPrefixReferences: prefix },
    integrated26: {
      books: books.map((x) => ({
        kind: x.kind,
        previousStateHash: x.previousStateHash,
        completedStateHash: x.completedStateHash,
      })),
      originalEvidenceHash: evidence.get("KR2026-10-26").hash,
      historyHashes: DATES.slice(0, 10).map((d) => evidence.get("KR" + d).hash),
      previousUsHash: evidence.get("US2026-10-23").hash,
      currentUsHash: evidence.get("US2026-10-26").hash,
    },
  };
  fixture = {
    plan,
    planHash,
    capsule,
    capsuleHash,
    payload,
    domain,
    archives,
    integrated,
    source,
    evidence,
  };
}, 30000);
function transport(f: any, mutate?: (url: URL, value: any) => any) {
  const calls: any[] = [];
  const fetcher = async (url: any, init: any) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, method: init.method });
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("error");
    let result: any;
    if (u.pathname.startsWith("/rest/v1/")) {
      expect(u.searchParams.get("user_id")).toBe("eq." + OWNER);
      const table = u.pathname.split("/").at(-1),
        id = (u.searchParams.get("source_id") ?? "").slice(3),
        series = (u.searchParams.get("series_id") ?? "").slice(3),
        date = (u.searchParams.get("session_date") ?? "").slice(3);
      if (table === "ledger_provenance_archive") {
        if (id === PLAN + f.capsuleHash.slice(7))
          result = [
            {
              user_id: OWNER,
              source_id: id,
              source_revision: "1",
              source_hash: f.planHash,
              payload: f.plan,
            },
          ];
        else if (id === CAPSULE_PREFIX + f.payload.captureManifestHash.slice(7))
          result = [{ source_hash: f.capsuleHash, payload: f.capsule }];
        else {
          const a = f.archives.find((a: any) => a.reference.sourceId === id);
          result = [{ source_hash: a.reference.sourceHash, payload: a.payload }];
        }
      } else if (table === "ledger_model_series") {
        const m = f.domain.find((m: any) => m.pin.seriesId === series);
        result = [{ series_id: series, payload: m.series }];
      } else if (table === "ledger_model_sessions") {
        if (u.searchParams.get("session_date")?.startsWith("gt.")) result = [];
        else {
          const m = f.domain.find((m: any) => m.pin.seriesId === series);
          const run =
            m?.run ??
            f.integrated
              .flatMap((x: any) => [x.previous, x.completed])
              .find((x: any) => x.registry.bookId === series && x.receipt.date === date);
          result = [{ state_hash: run.stateHash, payload: run }];
        }
      } else if (table === "shadow_replay_audit")
        result = [{ details: { krSourceVintageApproval: {}, krSourceVintageReview: {} } }];
      else if (table === "analysis_source_files") result = [f.source];
      else throw new Error("Unexpected table");
    } else if (u.pathname.includes("/object/info/")) {
      const pin = f.plan.kospi.objects.find((p: any) => u.pathname.endsWith(p.path)).metadata;
      result = {
        id: pin.id,
        version: pin.version,
        etag: pin.eTag,
        size: pin.size,
        last_modified: pin.updatedAt,
      };
    } else {
      const match = u.pathname.match(/\/(KR|US)\/(\d{4}-\d{2}-\d{2})\.json$/)!;
      result = f.evidence.get(match[1] + match[2]);
    }
    return new Response(JSON.stringify(mutate ? mutate(u, structuredClone(result)) : result));
  };
  return { fetcher, calls };
}
describe("real freshness path with genuine model and archive hashes", () => {
  it("completes all owner-bound GETs and finite phases without any write", async () => {
    const f = structuredClone(fixture),
      t = transport(f),
      phases: string[] = [];
    await recheckPreparationPins({
      origin: "https://synthetic.supabase.co",
      key: "synthetic",
      owner: OWNER,
      payload: f.payload,
      expectedPlanHash: f.planHash,
      expectedCapsuleHash: f.capsuleHash,
      fetcher: t.fetcher,
      onPhase: (p) => phases.push(p),
    });
    expect(phases.at(-1)).toBe("FRESH_PINS_COMPLETE");
    expect(phases.every((p) => APPEND_PHASES.includes(p as any))).toBe(true);
    expect(t.calls.length).toBeGreaterThan(60);
    expect(t.calls.every((x) => x.method === "GET")).toBe(true);
  });
  it.each([
    [
      "FRESH_MODEL_HASH",
      "ledger_model_sessions",
      (v: any) => {
        v[0].state_hash = "changed";
        return v;
      },
    ],
    [
      "FRESH_REGISTRY_BINDING",
      "ledger_model_series",
      (v: any) => {
        v[0].payload.configHash = "changed";
        return v;
      },
    ],
    [
      "FRESH_ARCHIVE_HASH",
      "ledger_provenance_archive",
      (v: any) => {
        v[0].payload.synthetic = "changed";
        return v;
      },
    ],
    ["FRESH_LEGACY_GENERATION_MATCH", "/object/info/", (v: any) => ({ ...v, version: "changed" })],
  ] as const)("isolates %s without bypassing a rejected guard", async (expected, match, mutate) => {
    const f = structuredClone(fixture);
    let last = "";
    const t = transport(f, (u, v) =>
      u.pathname.includes(match) &&
      (match !== "ledger_provenance_archive" ||
        u.searchParams.get("source_id")?.startsWith("eq.october-input:"))
        ? mutate(v)
        : v,
    );
    await expect(
      recheckPreparationPins({
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        owner: OWNER,
        payload: f.payload,
        expectedPlanHash: f.planHash,
        expectedCapsuleHash: f.capsuleHash,
        fetcher: t.fetcher,
        onPhase: (p) => (last = p),
      }),
    ).rejects.toThrow();
    expect(last).toBe(expected);
    expect(t.calls.every((x) => x.method === "GET")).toBe(true);
  });
});
