import { beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inspectNoWork } from "./quick-inspection";
const m = vi.hoisted(() => ({
  head: "2026-10-14",
  otherHead: null as string | null,
  dates: ["2026-10-12", "2026-10-13", "2026-10-14"],
  krThrough: null as string | null,
  partialKind: null as string | null,
  missingModel: false,
  queryError: false,
  filters: [] as Array<Record<string, unknown>>,
}));
vi.mock("../../src/lib/integratedAllocationStore.server", () => ({
  readIntegratedAllocationBook: async (_c: unknown, _u: string, kind: string) => ({
    registry: {},
    head: { receipt: { date: kind === "S07" && m.otherHead ? m.otherHead : m.head } },
  }),
}));
vi.mock("../../src/lib/ledger/octoberShadowRepository.server", () => ({
  octoberShadowStore: () => ({
    readSeries: async (bookId: string) => ({
      bookId,
      policy: { kind: bookId.split(":")[1], market: bookId.includes(":US_") ? "US" : "KR" },
    }),
  }),
}));
const uid = "11111111-1111-4111-8111-111111111111";
function client() {
  return {
    from(table: string) {
      expect(table).toBe("ledger_model_sessions");
      const f: Record<string, unknown> = {};
      m.filters.push(f);
      const q = {
        select(columns: string) {
          expect(columns).toBe("series_id,session_date,previous_session_date,state_hash");
          return q;
        },
        eq(k: string, v: unknown) {
          f[k] = v;
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
        async range() {
          const dates = m.dates;
          const kind = String(f.series_id).split(":")[1];
          const kr = !kind.startsWith("US_");
          return {
            error: m.queryError ? { message: "private upstream failure" } : null,
            data: dates
              .filter(
                (d) =>
                  (!m.missingModel || d !== m.dates[1]) &&
                  (!kr ||
                    !m.krThrough ||
                    d <= m.krThrough ||
                    (m.partialKind !== null && kind !== m.partialKind)),
              )
              .map((d) => ({
                series_id: f.series_id,
                session_date: d,
                previous_session_date: dates[dates.indexOf(d) - 1] ?? null,
                state_hash: `sha256:${"a".repeat(64)}`,
              })),
          };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}
const generation = () =>
  Promise.resolve({
    kind: "strong" as const,
    objectId: "id",
    version: "v1",
    etag: "etag",
    size: 123,
  });
beforeEach(() => {
  m.head = "2026-10-14";
  m.otherHead = null;
  m.dates = ["2026-10-12", "2026-10-13", "2026-10-14"];
  m.krThrough = null;
  m.partialKind = null;
  m.missingModel = false;
  m.queryError = false;
  m.filters = [];
});
it("3 days all present returns explicitly metadata-only and scopes every query/probe to owner", async () => {
  const probe = vi.fn(async (path: string) => {
    expect(path.startsWith(`${uid}/staging/`)).toBe(true);
    return generation();
  });
  const result = await inspectNoWork(client(), uid, "2026-10-14", probe);
  expect(result.status).toBe("NO_WORK_METADATA_ONLY");
  expect(result.payloadProvenanceRevalidated).toBe(false);
  expect(probe).toHaveBeenCalledTimes(6);
  expect(m.filters).toHaveLength(8);
  expect(m.filters.every((f) => f.user_id === uid)).toBe(true);
});
it("missing historical middle input requires full inspection", async () => {
  const result = await inspectNoWork(client(), uid, "2026-10-14", async (path) =>
    path.includes("KR/2026-10-13") ? null : generation(),
  );
  expect(result.needsFullInspection).toBe(true);
});
it("missing middle model row requires full inspection", async () => {
  m.missingModel = true;
  expect((await inspectNoWork(client(), uid, "2026-10-14", generation)).needsFullInspection).toBe(
    true,
  );
});
it("head behind cannot be a no-op", async () => {
  m.head = "2026-10-13";
  expect((await inspectNoWork(client(), uid, "2026-10-14", generation)).reason).toBe(
    "FIRST_PENDING_DATE_REQUIRES_FULL_INSPECTION",
  );
});
it("weak generation requires full inspection", async () => {
  expect(
    (await inspectNoWork(client(), uid, "2026-10-14", async () => ({ kind: "weak" })))
      .needsFullInspection,
  ).toBe(true);
});
it("invalid owner never queries", async () => {
  await expect(inspectNoWork(client(), "bad", "2026-10-14", generation)).rejects.toThrow();
  expect(m.filters).toHaveLength(0);
});

it("metadata operational failure throws without requesting full inspection", async () => {
  const probe = vi.fn(async () => {
    throw Error("private token or budget detail");
  });
  await expect(inspectNoWork(client(), uid, "2026-10-14", probe)).rejects.toThrow(
    "no full-path retry",
  );
  expect(probe).toHaveBeenCalledTimes(1);
});
it("database query failure throws rather than falling back or retrying", async () => {
  m.queryError = true;
  const probe = vi.fn(async (_path: string) => generation());
  await expect(inspectNoWork(client(), uid, "2026-10-14", probe)).rejects.toThrow(
    "no full-path retry",
  );
  expect(m.filters).toHaveLength(1);
  expect(probe).not.toHaveBeenCalled();
});

async function postRepairMetadata() {
  const { octoberModelCalendar } = await import("../../src/lib/ledger/octoberShadowCalendar");
  m.dates = (await octoberModelCalendar("KR", "2026-10-30")).regularSessions.filter(
    (d) => d >= "2026-10-12",
  );
  m.head = "2026-10-29";
  m.krThrough = "2026-10-29";
}
it("post-repair head29 + US30/KR29 returns bounded metadata-only waiting without pending payload probes", async () => {
  await postRepairMetadata();
  const probe = vi.fn(async (_path: string) => generation());
  const result = await inspectNoWork(client(), uid, "2026-10-30", probe);
  expect(result).toMatchObject({
    status: "WAITING_METADATA_ONLY",
    needsFullInspection: false,
    payloadProvenanceRevalidated: false,
    waitingDate: "2026-10-30",
    missingMarkets: [{ market: "KR", published: 0, required: 5 }],
  });
  expect(result.checkedInputs).toBe(28);
  expect(m.filters).toHaveLength(8);
  expect(probe.mock.calls.every(([path]) => !String(path).includes("2026-10-30"))).toBe(true);
});
it("waiting path still refuses a historic model middle hole", async () => {
  await postRepairMetadata();
  m.missingModel = true;
  expect((await inspectNoWork(client(), uid, "2026-10-30", generation)).needsFullInspection).toBe(
    true,
  );
});
it("waiting path still refuses missing historical stage presence", async () => {
  await postRepairMetadata();
  expect(
    (
      await inspectNoWork(client(), uid, "2026-10-30", async (p) =>
        p.includes("US/2026-10-12") ? null : generation(),
      )
    ).needsFullInspection,
  ).toBe(true);
});
it("a ready first pending date always requires full inspection", async () => {
  await postRepairMetadata();
  m.krThrough = null;
  expect((await inspectNoWork(client(), uid, "2026-10-30", generation)).reason).toBe(
    "FIRST_PENDING_DATE_REQUIRES_FULL_INSPECTION",
  );
});
it("partial first-date market publication reports exact count without assuming finality", async () => {
  await postRepairMetadata();
  m.partialKind = "KR_MIXED";
  expect((await inspectNoWork(client(), uid, "2026-10-30", generation)).missingMarkets).toEqual([
    { market: "KR", published: 4, required: 5 },
  ]);
});
it("divergent integrated checkpoints require full inspection", async () => {
  await postRepairMetadata();
  m.otherHead = "2026-10-28";
  expect((await inspectNoWork(client(), uid, "2026-10-30", generation)).reason).toBe(
    "INTEGRATED_HEADS_DIVERGENT",
  );
});
