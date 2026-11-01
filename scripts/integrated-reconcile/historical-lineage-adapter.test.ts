import { validateHistoricalKrLineage, type HistoricalLineageInput } from "./historical-lineage";
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
  lineageAudits: [] as unknown[],
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
            data:
              filters.market === "KR"
                ? (columns.includes("user_id") ? m.lineageAudits : m.boxes).slice(start, end + 1)
                : [],
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
  m.lineageAudits = [];
  vi.mocked(validateHistoricalKrLineage).mockClear();
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

vi.mock("./historical-lineage", () => ({
  validateHistoricalKrLineage: vi.fn(async (input: HistoricalLineageInput) => {
    if (input.audits.length !== 1) throw Error("audit missing/ambiguous");
    if (input.models.some((m) => !m.run.publication.reviewedRetrospective))
      throw Error("marker required");
    return {
      date: input.date,
      stageHash: input.stage.hash,
      sourceHash: input.stage.payload.clock.sourceHash,
      checkpointHashes: { O1: H, S07: H },
      proofHash: H,
    };
  }),
}));
async function mismatch(d: string) {
  for (const [id, rows] of m.sessions) {
    if (id.includes(":US_")) continue;
    const row = rows.find((r) => r.session_date === d)!;
    const run = row.payload as OctoberRun;
    run.publication.sourceHash = `sha256:${"b".repeat(64)}` as SeriesHash;
    run.publication.reviewedRetrospective = {
      version: "kr-reviewed-retrospective-publication-v1",
    } as NonNullable<OctoberRun["publication"]["reviewedRetrospective"]>;
    const { stateHash: _hash, ...body } = run;
    const hash = await hashSeriesValue(body);
    row.payload = { ...body, stateHash: hash };
    row.state_hash = hash;
    let previousHash: string | null = null;
    for (const current of rows) {
      const payload = current.payload as OctoberRun;
      payload.previousStateHash = previousHash as SeriesHash | null;
      const { stateHash: _old, ...rest } = payload;
      const newHash = await hashSeriesValue(rest);
      current.payload = { ...rest, stateHash: newHash };
      current.state_hash = newHash;
      previousHash = newHash;
    }
  }
}
it("wires historical KR mismatch into validator and fingerprints its proof without changing source identities", async () => {
  await ready();
  await mismatch("2026-10-13");
  m.lineageAudits = [{ user_id: uid, market: "KR", signal_date: "2026-10-13", details: {} }];
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  const first = await port.inspect();
  expect(validateHistoricalKrLineage).toHaveBeenCalledTimes(1);
  const args = vi.mocked(validateHistoricalKrLineage).mock.calls[0][0];
  expect(args.date).toBe("2026-10-13");
  expect(args.models).toHaveLength(5);
  expect(args.history.map((p) => p.date)).toEqual(["2026-10-12"]);
  expect(Object.keys(first.evidence)).toEqual(["KR:2026-10-15", "US:2026-10-15"]);
  await port.inspect();
  expect(validateHistoricalKrLineage).toHaveBeenCalledTimes(1);
});
it("pending KR mismatch never calls historical override", async () => {
  await ready();
  await mismatch("2026-10-15");
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  await expect(port.inspect()).rejects.toThrow("outside verified historical checkpoint");
  expect(validateHistoricalKrLineage).not.toHaveBeenCalled();
});
it("fresh audit changes invalidate proof cache and missing proof aborts", async () => {
  await ready();
  await mismatch("2026-10-13");
  m.lineageAudits = [{ user_id: uid, market: "KR", signal_date: "2026-10-13", details: {} }];
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  await port.inspect();
  m.lineageAudits = [];
  await expect(port.inspect()).rejects.toThrow("audit missing/ambiguous");
  expect(validateHistoricalKrLineage).toHaveBeenCalledTimes(2);
  expect(m.uploads).toBe(0);
});
it("date beyond either initial checkpoint cannot use historical override", async () => {
  await ready();
  await mismatch("2026-10-13");
  const book = m.books.get("S07") as {
    head: { receipt: { date: string } };
    ledger: { markets: Record<string, { sessions: string[]; lastSessionDate: string }> };
  };
  book.head.receipt.date = "2026-10-12";
  for (const value of Object.values(book.ledger.markets)) {
    value.sessions = ["2026-10-12"];
    value.lastSessionDate = "2026-10-12";
  }
  const port = await buildReconcilePort(client(), uid, "2026-11-01T00:00:00Z", "2026-10-15", {
    useVerifiedCheckpoint: true,
    freshGeneration: strong,
  });
  await expect(port.inspect()).rejects.toThrow("outside verified historical checkpoint");
  expect(validateHistoricalKrLineage).not.toHaveBeenCalled();
});
