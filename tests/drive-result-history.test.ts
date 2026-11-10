import { createHash } from "node:crypto";
import { afterEach, expect, test, vi } from "vitest";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import { deterministicAnalysis, stableCacheJson } from "../src/lib/screeningCacheContract";
import {
  installJournalBoundary,
  JOURNAL_OWNER,
  recordOriginalJournal,
  verifiedJournalSnapshot,
} from "../scripts/drive-result-history";

const runId = "20261110004749-3df9e789";
function fixture() {
  const result = {
    asOfDate: "2026-11-09",
    calculatedAt: "2026-11-10T00:47:48.747Z",
    strategyVersion: "original-strategy",
    marketGate: { status: "RISK_OFF" },
    rows: [],
  } as unknown as AnalysisResult;
  const bundle = { run: { id: runId, kind: "SCREENING" }, result };
  const receipt = {
    version: "drive-result-receipt-v1",
    phase: "FINAL",
    date: result.asOfDate,
    resultPath: `${JOURNAL_OWNER}/results/screening/${runId}.json`,
    resultDigest: createHash("sha256")
      .update(stableCacheJson(deterministicAnalysis(result)))
      .digest("hex"),
  };
  return { receipt, bundle };
}

test("preserves original date, calculation time, run and strategy without rescreening", () => {
  const { receipt, bundle } = fixture();
  const original = stableCacheJson(bundle);
  expect(verifiedJournalSnapshot(receipt, bundle, runId)).toMatchObject({
    date: "2026-11-09",
    savedAt: "2026-11-10T00:47:48.747Z",
    strategyVersion: "original-strategy",
    runId,
    market: "KR",
  });
  expect(stableCacheJson(bundle)).toBe(original);
});

test.each(["phase", "date", "resultDigest", "resultPath"])(
  "rejects altered publication %s before journal writes",
  (field) => {
    const { receipt, bundle } = fixture();
    expect(() =>
      verifiedJournalSnapshot({ ...receipt, [field]: "altered" }, bundle, runId),
    ).toThrow("identity");
  },
);

test("does not upgrade a preliminary calculation even with a matching hash", () => {
  const { receipt, bundle } = fixture();
  bundle.result.krPublication = {
    phase: "PRELIMINARY",
  } as NonNullable<AnalysisResult["krPublication"]>;
  receipt.resultDigest = createHash("sha256")
    .update(stableCacheJson(deterministicAnalysis(bundle.result)))
    .digest("hex");
  expect(() => verifiedJournalSnapshot(receipt, bundle, runId)).toThrow("FINAL");
});

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
test("network permits only approved owner journals, never raw sources or financial ledgers", async () => {
  const transport = vi.fn(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = transport;
  const boundary = installJournalBoundary();
  const { receipt, bundle } = fixture();
  const snapshot = verifiedJournalSnapshot(receipt, bundle, runId);
  const prefix = "https://ahbvrtugugwnbrfnbxzp.supabase.co";
  const body = { user_id: JOURNAL_OWNER, date: snapshot.date, snapshot };
  const send = (table: string, value = body) =>
    fetch(`${prefix}/rest/v1/${table}`, { method: "POST", body: JSON.stringify(value) });
  await expect(send("screening_history")).rejects.toThrow("blocked");
  boundary.approve(runId);
  await expect(send("screening_history")).resolves.toBeInstanceOf(Response);
  await expect(send("portfolio_ledgers")).rejects.toThrow("blocked");
  await expect(send("us_actual_portfolio_ledgers")).rejects.toThrow("blocked");
  await expect(send("screening_history", { ...body, user_id: "other-owner" })).rejects.toThrow(
    "blocked",
  );
  await expect(
    fetch(`${prefix}/storage/v1/object/cloudtrend-data/${JOURNAL_OWNER}/source/screening/raw.csv`),
  ).rejects.toThrow("raw source");
  expect(boundary.network.journalWrites).toBe(1);
  expect(transport).toHaveBeenCalledTimes(1);
  boundary.restore();
});

function memoryClient() {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const client = {
    from: (table: string) => {
      const rows = tables.get(table) ?? new Map<string, Record<string, unknown>>();
      tables.set(table, rows);
      let key = "";
      const query = {
        select: () => query,
        eq: (field: string, value: string) => {
          if (field === "date" || field === "run_id") key = value;
          return query;
        },
        maybeSingle: async () => ({ data: rows.get(key) ?? null, error: null }),
        single: async () => ({ data: rows.get(key) ?? null, error: null }),
        upsert: async (value: Record<string, unknown>) => {
          const id = String(value[table === "screening_history" ? "date" : "run_id"]);
          if (table === "screening_history" || !rows.has(id))
            rows.set(id, JSON.parse(JSON.stringify(value)));
          return { error: null };
        },
      };
      return query;
    },
  } as unknown as Parameters<typeof recordOriginalJournal>[0];
  return { client, tables };
}

test("restores and readback-verifies the daily snapshot idempotently", async () => {
  const { receipt, bundle } = fixture();
  const snapshot = verifiedJournalSnapshot(receipt, bundle, runId);
  const { client, tables } = memoryClient();
  await expect(recordOriginalJournal(client, snapshot)).resolves.toBe("RECORDED_VERIFIED");
  await expect(recordOriginalJournal(client, snapshot)).resolves.toBe("RECORDED_VERIFIED");
  expect(tables.get("screening_history")?.size).toBe(1);
  expect(tables.get("screening_run_archive")?.size).toBe(1);
});

test("archives an older original without replacing a newer same-date representative", async () => {
  const { receipt, bundle } = fixture();
  const snapshot = verifiedJournalSnapshot(receipt, bundle, runId);
  const newer = { ...snapshot, savedAt: "2026-11-10T01:00:00Z", runId: "newer-run" };
  const { client, tables } = memoryClient();
  tables.set("screening_history", new Map([[snapshot.date, { snapshot: newer }]]));
  await expect(recordOriginalJournal(client, snapshot)).resolves.toBe(
    "ARCHIVED_WITHOUT_REPLACING_NEWER",
  );
  expect(tables.get("screening_history")?.get(snapshot.date)?.["snapshot"]).toBe(newer);
  expect(tables.get("screening_run_archive")?.has(runId)).toBe(true);
});
