/** Adapter IO contract tests: synthetic clients only, no network/credentials. */
import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildReconcilePort } from "./adapter";
import {
  freezeRestartSeries,
  guardModelRun,
  type AdoptedSeriesKind,
  type FrozenModelSeries,
  type SeriesHash,
  hashSeriesValue,
} from "../../src/lib/ledger/modelSeries";
import {
  octoberModelCalendar,
  regularOpenAt,
  regularCloseAt,
  OCTOBER_CALENDAR_EVIDENCE,
} from "../../src/lib/ledger/octoberShadowCalendar";
import { INTEGRATED_ALLOCATION_OUTBOX_VERSION } from "../../src/lib/integratedAllocationRecovery.server";
import type { OctoberRun } from "../../src/lib/ledger/octoberShadowPipeline";
const m = vi.hoisted(() => ({
  files: new Map<string, Blob>(),
  registries: new Map<string, FrozenModelSeries>(),
  sessions: new Map<string, Array<Record<string, unknown>>>(),
  boxes: [] as unknown[],
  queries: [] as { table: string; columns: string; offset: number }[],
  uploads: 0,
  downloads: [] as string[],
  uncertain: false,
  commit: true,
}));
const H = `sha256:${"a".repeat(64)}`;
const uid = "11111111-1111-4111-8111-111111111111";
const date = "2026-10-12";
vi.mock("../../src/lib/freshStorage", () => ({
  downloadFreshObject: async (_: unknown, _b: string, path: string) => {
    m.downloads.push(path);
    return {
      data: m.files.get(path) ?? null,
      error: m.files.has(path) ? null : { statusCode: "404", message: "not found" },
    };
  },
}));
vi.mock("../../src/lib/integratedAllocationStore.server", () => ({
  integratedAllocationCodeHash: `sha256:${"a".repeat(64)}`,
  integratedAllocationRuntimeAdmission: {},
  readIntegratedAllocationBook: async () => ({ registry: {}, head: null }),
}));
vi.mock("../../src/lib/ledger/octoberShadowRepository.server", () => ({
  octoberShadowStore: () => ({
    readSeries: async (bookId: string) =>
      m.registries.get(bookId) ?? {
        bookId,
        contractHash: "hash",
        policy: { kind: bookId.split(":")[1], market: bookId.includes(":US_") ? "US" : "KR" },
      },
  }),
}));
vi.mock("../../src/lib/integratedAllocationReplay.server", () => ({
  replayIntegratedAllocationAvailable: vi.fn(async () => ({ recorded: 0, waiting: null })),
}));
vi.mock("../../src/lib/integratedAllocationRuntimeAudit.server", () => ({
  recordIntegratedRuntimeAttempt: vi.fn(async () => {}),
}));
function client() {
  return {
    from(table: string) {
      let columns = "";
      const filters: Record<string, unknown> = {};
      const q = {
        select(v: string) {
          columns = v;
          return q;
        },
        eq(k: string, v: unknown) {
          filters[k] = v;
          return q;
        },
        gte() {
          return q;
        },
        lte() {
          return q;
        },
        order() {
          return q;
        },
        contains() {
          return q;
        },
        async range(start: number, end: number) {
          m.queries.push({ table, columns, offset: start });
          if (table === "ledger_model_sessions")
            return {
              data: (m.sessions.get(String(filters.series_id)) ?? []).slice(start, end + 1),
              error: null,
            };
          if (table !== "shadow_replay_audit") throw Error("unexpected table");
          return {
            data: filters.market === "KR" ? m.boxes.slice(start, end + 1) : [],
            error: null,
          };
        },
      };
      return q;
    },
    storage: {
      from() {
        return {
          async upload(path: string, blob: Blob, options: { upsert: boolean }) {
            expect(options.upsert).toBe(false);
            m.uploads++;
            if (m.commit) m.files.set(path, blob);
            return { error: m.uncertain ? { message: "timeout" } : null };
          },
        };
      },
    },
  } as unknown as SupabaseClient;
}
async function payload() {
  const calendar = await octoberModelCalendar("KR", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
  return {
    version: "integrated-kr-daily-evidence-v1",
    date,
    instruments: [],
    rows: [],
    bars: {},
    snapshot: { asOfDate: date, entries: [] },
    etfBatchPending: false,
    priorGate: null,
    clock: {
      codeHash: H,
      sourceHash: H,
      availableAt: "2026-10-12T07:00:00Z",
      decisionAt: "2026-10-12T08:00:00Z",
      openAt: regularOpenAt("KR", date),
      closeAt: regularCloseAt("KR", date),
      calendar: { sourceHash: calendar.sourceHash, sessions: calendar.regularSessions },
    },
  };
}
async function box(p: unknown) {
  return {
    details: {
      integratedAllocationOutbox: {
        version: INTEGRATED_ALLOCATION_OUTBOX_VERSION,
        market: "KR",
        date,
        hash: await hashSeriesValue(p),
        payload: p,
      },
    },
  };
}
const path = `${uid}/staging/integrated-allocation-inputs/v1/KR/${date}.json`;
beforeEach(() => {
  m.downloads = [];
  m.files.clear();
  m.registries.clear();
  m.sessions.clear();
  m.boxes = [];
  m.queries = [];
  m.uploads = 0;
  m.uncertain = false;
  m.commit = true;
});
it("queries real migration columns and all eight market books independently of integrated heads", async () => {
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date);
  const result = await port.inspect();
  expect(result.models[`KR:${date}`].complete).toBe(false);
  const sql = readFileSync(
    "supabase/migrations/20261002213815_unified_ledger_foundation.sql",
    "utf8",
  );
  const table = sql.split("create table public.ledger_model_sessions (")[1].split("\n);")[0];
  const queries = m.queries.filter((q) => q.table === "ledger_model_sessions");
  expect(queries).toHaveLength(8);
  for (const column of queries[0].columns.split(","))
    expect(table).toMatch(new RegExp(`\\b${column}\\b`));
  expect(m.uploads).toBe(0);
});
it("reads the last outbox page and rejects conflicting versions hidden after page 100", async () => {
  const p = await payload();
  m.boxes = Array(100).fill(await box(p));
  m.boxes.push(await box({ ...p, etfBatchPending: true }));
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date);
  await expect(port.inspect()).rejects.toThrow("conflicting outbox");
  expect(m.queries.some((q) => q.offset === 100)).toBe(true);
});
it.each(["clock", "calendar", "structure", "hash"])(
  "rejects invalid %s evidence even with a recomputed envelope",
  async (kind) => {
    const p = await payload();
    if (kind === "clock") p.clock.codeHash = `sha256:${"b".repeat(64)}`;
    if (kind === "calendar") p.clock.calendar.sessions = [];
    if (kind === "structure") p.snapshot.asOfDate = "2026-10-13";
    m.files.set(
      path,
      new Blob([
        JSON.stringify({ payload: p, hash: kind === "hash" ? H : await hashSeriesValue(p) }),
      ]),
    );
    const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date);
    await expect(port.inspect()).rejects.toThrow();
    expect(m.uploads).toBe(0);
  },
);
it("verifies an uncertain upload by readback and subsequent calls never duplicate", async () => {
  const p = await payload();
  m.boxes = [await box(p)];
  m.uncertain = true;
  const hash = await hashSeriesValue(p);
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date);
  await port.restore("KR", date, hash);
  await port.restore("KR", date, hash);
  expect(m.uploads).toBe(1);
  expect((await port.inspect()).evidence[`KR:${date}`].status).toBe("STORED");
});
it("fails closed on unverified upload without retry", async () => {
  const p = await payload();
  m.boxes = [await box(p)];
  m.uncertain = true;
  m.commit = false;
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date);
  await expect(port.restore("KR", date, await hashSeriesValue(p))).rejects.toThrow(
    "uncertain restore not verified",
  );
  expect(m.uploads).toBe(1);
});

// These are real admitted frozen contracts/receipts and canonical persisted payloads;
// no mock of verifyFrozenSeries, guardModelRun, or assertStoredOctoberRun.
const kinds: AdoptedSeriesKind[] = [
  "KR_MIXED",
  "KR_KOSPI",
  "KR_KOSDAQ",
  "ETF_V02",
  "KR_KOSPI_CONFIRM1_BEAR",
  "US_A0",
  "US_A2",
  "US_B3",
];
async function seedModels(days = ["2026-10-12"]) {
  for (const kind of kinds) {
    const series = await freezeRestartSeries({
      kind,
      frozenAt: "2026-10-09T00:00:00Z",
      codeHash: H,
      sourceHash: H,
    });
    m.registries.set(series.bookId, series);
    const calendar = await octoberModelCalendar(
      series.policy.market,
      OCTOBER_CALENDAR_EVIDENCE.coverageEnd,
    );
    let previous: OctoberRun | null = null;
    const rows: Array<Record<string, unknown>> = [];
    for (const d of days) {
      const receipt = (
        await guardModelRun(series, {
          date: d,
          codeHash: series.codeHash,
          configHash: series.configHash,
          sourceHash: H,
        })
      ).receipt;
      const body = {
        book: "MODEL",
        bookId: series.bookId,
        contractHash: series.contractHash,
        receipt,
        previousStateHash: previous?.stateHash ?? null,
        calendar,
        publication: {
          version: "october-manual-publication-v1",
          inputHash: H,
          sourceHash: H,
          availableAt: `${d}T21:00:00Z`,
          decisionAt: `${d}T22:00:00Z`,
        },
        result: { fixture: "empty-economic-state-not-replayed" },
      };
      const run = { ...body, stateHash: await hashSeriesValue(body) } as unknown as OctoberRun;
      rows.push({
        series_id: series.bookId,
        session_date: d,
        previous_session_date: previous?.receipt.date ?? null,
        state_hash: run.stateHash,
        payload: run,
      });
      previous = run;
    }
    m.sessions.set(series.bookId, rows);
  }
}
async function rehash(row: Record<string, unknown>) {
  const { stateHash: _old, ...body } = row.payload as OctoberRun;
  const hash = await hashSeriesValue(body);
  row.payload = { ...body, stateHash: hash };
  row.state_hash = hash;
}
it("validates real registry/receipt/state proofs for every nonempty market kind", async () => {
  await seedModels(["2026-10-12", "2026-10-13", "2026-10-14"]);
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-14");
  const result = await port.inspect();
  expect(Object.values(result.models)).toHaveLength(6);
  expect(
    Object.values(result.models).every((model) => model.complete && model.sourceHash === H),
  ).toBe(true);
});
it.each(["predecessor", "source", "receipt", "state", "clock", "middle"])(
  "rejects nonempty market %s corruption",
  async (kind) => {
    await seedModels(["2026-10-12", "2026-10-13", "2026-10-14"]);
    const rows = [...m.sessions.values()][0];
    const row = rows[1];
    const run = row.payload as OctoberRun;
    if (kind === "predecessor") row.previous_session_date = null;
    if (kind === "source") {
      run.publication.sourceHash = `sha256:${"b".repeat(64)}` as SeriesHash;
      await rehash(row);
    }
    if (kind === "receipt") {
      run.receipt = { ...run.receipt, runHash: H as SeriesHash };
      await rehash(row);
    }
    if (kind === "state") row.state_hash = H;
    if (kind === "clock") {
      run.publication.decisionAt = "2027-01-01T00:00:00Z";
      await rehash(row);
    }
    if (kind === "middle") rows.splice(1, 1);
    const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-14");
    await expect(port.inspect()).rejects.toThrow();
    expect(m.uploads).toBe(0);
  },
);
it("rejects a correctly rehashed staged source differing from complete market publication", async () => {
  await seedModels();
  const p = await payload();
  p.clock.sourceHash = `sha256:${"b".repeat(64)}`;
  m.files.set(path, new Blob([JSON.stringify({ payload: p, hash: await hashSeriesValue(p) })]));
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date);
  await expect(port.inspect()).rejects.toThrow("evidence/market source mismatch");
});
it("uses cache only after fresh strong probes and reloads a changed generation", async () => {
  const p = await payload();
  m.files.set(path, new Blob([JSON.stringify({ payload: p, hash: await hashSeriesValue(p) })]));
  let version = "v1";
  const freshGeneration = vi.fn(async (objectPath: string) =>
    objectPath === path
      ? { kind: "strong" as const, objectId: "object", version, etag: "etag", size: 100 }
      : null,
  );
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date, {
    freshGeneration,
  });
  const first = await port.inspect();
  await port.inspect();
  expect(m.downloads.filter((p) => p === path)).toHaveLength(1);
  expect(freshGeneration.mock.calls.filter(([p]) => p === path)).toHaveLength(3);
  version = "v2";
  expect((await port.inspect()).fingerprint).toBe(first.fingerprint);
  expect(m.downloads.filter((p) => p === path)).toHaveLength(2);
  m.files.delete(path);
  version = "v3";
  expect((await port.inspect()).evidence[`KR:${date}`].status).toBe("MISSING");
  expect((await port.inspect()).evidence[`KR:${date}`].status).toBe("MISSING");
  expect(m.downloads.filter((p) => p === path)).toHaveLength(4);
});
it("falls back to full validated reads for weak metadata", async () => {
  const p = await payload();
  m.files.set(path, new Blob([JSON.stringify({ payload: p, hash: await hashSeriesValue(p) })]));
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date, {
    freshGeneration: async () => ({ kind: "weak" }),
  });
  await port.inspect();
  await port.inspect();
  expect(m.downloads.filter((p) => p === path)).toHaveLength(2);
  m.files.set(path, new Blob([JSON.stringify({ payload: p, hash: "sha256:" + "f".repeat(64) })]));
  await expect(port.inspect()).rejects.toThrow("stored evidence hash mismatch");
});
it("rejects changed storage generation during initial validated download", async () => {
  const p = await payload();
  m.files.set(path, new Blob([JSON.stringify({ payload: p, hash: await hashSeriesValue(p) })]));
  let counter = 0;
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", date, {
    freshGeneration: async () => ({
      kind: "strong",
      objectId: "object",
      version: `${++counter}`,
      etag: "etag",
      size: 100,
    }),
  });
  await expect(port.inspect()).rejects.toThrow("generation changed");
  expect(m.uploads).toBe(0);
});
