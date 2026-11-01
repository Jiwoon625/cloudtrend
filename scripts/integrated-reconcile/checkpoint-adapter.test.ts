import { US_PROSPECTIVE_RULE_VERSION } from "../../src/lib/engine/usProspective";
/** Adapter IO contract tests: synthetic clients only, no network/credentials. */
import { beforeEach, expect, it, vi } from "vitest";
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
import type { OctoberRun } from "../../src/lib/ledger/octoberShadowPipeline";
const m = vi.hoisted(() => ({
  replayProbe: null as string | null,
  books: new Map<string, unknown>(),
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
  readIntegratedAllocationBook: async (_c: unknown, _u: string, kind: string) => m.books.get(kind),
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
  replayIntegratedAllocationAvailable: vi.fn(async (client: SupabaseClient) => {
    if (m.replayProbe) await client.storage.from("cloudtrend-data").download(m.replayProbe);
    return { recorded: 0, waiting: null };
  }),
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
        async maybeSingle() {
          const head = (
            m.books.get(String(filters.series_id).endsWith(":O1") ? "O1" : "S07") as {
              head: { stateHash: string };
            }
          ).head;
          return { data: { state_hash: head.stateHash }, error: null };
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
beforeEach(() => {
  m.downloads = [];
  m.replayProbe = null;
  m.files.clear();
  m.books.clear();
  m.downloads = [];
  m.registries.clear();
  m.sessions.clear();
  m.boxes = [];
  m.queries = [];
  m.uploads = 0;
  m.uncertain = false;
  m.commit = true;
});
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

async function ready() {
  const ds = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15"];
  await seedModels(ds);
  for (const kind of ["O1", "S07"]) {
    const sessions = ds.slice(0, 3);
    m.books.set(kind, {
      registry: {},
      head: { bookId: `integrated:${kind}`, stateHash: H, receipt: { date: "2026-10-14" } },
      ledger: {
        markets: Object.fromEntries(
          ["K", "E", "U"].map((k) => [
            k,
            { sessions: [...sessions], lastSessionDate: "2026-10-14" },
          ]),
        ),
      },
    });
  }
  for (const d of ds) {
    const p = await payload();
    p.date = d;
    p.snapshot.asOfDate = d;
    p.clock.openAt = regularOpenAt("KR", d);
    p.clock.closeAt = regularCloseAt("KR", d);
    m.files.set(
      `${uid}/staging/integrated-allocation-inputs/v1/KR/${d}.json`,
      new Blob([JSON.stringify({ payload: p, hash: await hashSeriesValue(p) })]),
    );
    const c = await octoberModelCalendar("US", OCTOBER_CALENDAR_EVIDENCE.coverageEnd);
    const u = {
      version: "integrated-us-daily-evidence-v1",
      analysis: {
        date: d,
        ruleVersion: US_PROSPECTIVE_RULE_VERSION,
        rows: [],
        state: {},
        summary: {},
      },
      clock: {
        ...p.clock,
        openAt: regularOpenAt("US", d),
        closeAt: regularCloseAt("US", d),
        calendar: { sourceHash: c.sourceHash, sessions: c.regularSessions },
      },
    };
    m.files.set(
      `${uid}/staging/integrated-allocation-inputs/v1/US/${d}.json`,
      new Blob([JSON.stringify({ payload: u, hash: await hashSeriesValue(u) })]),
    );
  }
}
const strong = async () => ({
  kind: "strong" as const,
  objectId: "id",
  version: "v1",
  etag: "etag",
  size: 123,
});
it("fixed checkpoint skips old US body only, keeps all KR and inclusive prior US", async () => {
  await ready();
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  expect(port.dates).toEqual(["2026-10-15"]);
  const result = await port.inspect();
  expect(Object.keys(result.evidence)).toEqual(["KR:2026-10-15", "US:2026-10-15"]);
  expect(m.downloads.filter((p) => p.includes("/KR/"))).toHaveLength(4);
  expect(m.downloads.filter((p) => p.includes("/US/"))).toHaveLength(2);
});
it("missing oldUS metadata at construction preserves full historical path", async () => {
  await ready();
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: async (path) => (path.includes("US/2026-10-12") ? null : strong()),
  });
  expect(port.dates).toHaveLength(4);
  await port.inspect();
  expect(m.downloads.some((p) => p.includes("US/2026-10-12"))).toBe(true);
});
it("oldUS generation disappears after build: abort without hidden fallback/restoration", async () => {
  await ready();
  let missing = false;
  const probe = async (path: string) =>
    missing && path.includes("US/2026-10-12") ? null : strong();
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: probe,
  });
  missing = true;
  await expect(port.inspect()).rejects.toThrow("scope invalidated");
  expect(m.uploads).toBe(0);
  expect(port.dates).toEqual(["2026-10-15"]);
});
it("incomplete historical model grid never narrows initial scope", async () => {
  await ready();
  [...m.sessions.values()][0].splice(1, 1);
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  expect(port.dates).toHaveLength(4);
  await expect(port.inspect()).rejects.toThrow("sequence broken");
});

it("required historical KR staging loss aborts even if metadata lies strong", async () => {
  await ready();
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  m.files.delete(`${uid}/staging/integrated-allocation-inputs/v1/KR/2026-10-12.json`);
  await expect(port.inspect()).rejects.toThrow("required staging missing");
  expect(m.uploads).toBe(0);
});
it("original checkpoint hash mutation aborts", async () => {
  await ready();
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  const book = m.books.get("O1") as { head: { stateHash: string } };
  book.head.stateHash = `sha256:${"b".repeat(64)}`;
  await expect(port.inspect()).rejects.toThrow("original checkpoint changed");
});

it("replay bridge rejects input hash changed since successful inspection", async () => {
  await ready();
  let version = "v1";
  const probe = async () => ({ ...(await strong()), version });
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: probe,
  });
  await port.inspect();
  const key = `${uid}/staging/integrated-allocation-inputs/v1/KR/2026-10-12.json`;
  const envelope = JSON.parse(await m.files.get(key)!.text());
  envelope.payload.etfBatchPending = true;
  envelope.hash = await hashSeriesValue(envelope.payload);
  m.files.set(key, new Blob([JSON.stringify(envelope)]));
  version = "v2";
  m.replayProbe = key;
  await expect(port.replay("2026-10-15")).rejects.toThrow("replay input changed");
});
it("replay bridge refuses unplanned oldUS dependency rather than downloading or restoring", async () => {
  await ready();
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  await port.inspect();
  m.replayProbe = `${uid}/staging/integrated-allocation-inputs/v1/US/2026-10-12.json`;
  await expect(port.replay("2026-10-15")).rejects.toThrow("unplanned replay input");
  expect(m.uploads).toBe(0);
});
