/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, it, expect, vi } from "vitest";
import {
  CANONICAL_SOURCE_COLUMNS,
  toCanonicalCsv,
  validateSourceText,
  type CanonicalSourceRow,
} from "../../src/lib/sourceData";
import { hashSeriesValue } from "../../src/lib/ledger/modelSeries";
const gate = vi.hoisted(() => ({
  check: vi.fn(),
  phase: {
    version: "kr-source-publication-v1",
    phase: "PRELIMINARY",
    asOfDate: "2026-10-28",
    heldFields: [],
    financialSideEffects: false,
    requestIds: [],
  },
}));
vi.mock("./operation-transport", () => ({ assertCurrentSources: gate.check }));
vi.mock("../../src/lib/krScreeningPublication", async (original) => ({
  ...(await original<any>()),
  classifyKrScreeningPublication: () => gate.phase,
}));
import { registerReviewedHistory, historyRegistrationIdentity } from "./register-history";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  hash = `sha256:${"a".repeat(64)}`;
beforeEach(() => gate.check.mockReset().mockResolvedValue([{}]));
async function fixture() {
  const row = Object.fromEntries(
    CANONICAL_SOURCE_COLUMNS.map((k) => [k, ""]),
  ) as CanonicalSourceRow;
  Object.assign(row, {
    type: "STOCK",
    symbol: "111111",
    name: "Synthetic",
    market: "KOSDAQ",
    sector: "IT",
    date: "2026-10-23",
    open: "50",
    high: "55",
    low: "45",
    close: "50",
    volume: "1000",
    tradingValue: "50000",
    marketCap: "1000000000",
  });
  const csv = toCanonicalCsv([row]),
    v = await validateSourceText(csv, "reviewed-current-history-correction.csv");
  expect(v.valid).toBe(true);
  const plan: any = {
    historyCorrection: {
      status: "CANDIDATE_REVIEW_REQUIRED",
      role: "HISTORY_ONLY",
      fullMaskedEquality: true,
      newerObservationsUnchanged: true,
      currentPublicationBefore: gate.phase,
      currentPublicationAfter: gate.phase,
      correction: {
        csv,
        fileHash: v.fileHash,
        dataHash: v.dataHash,
        schemaHash: v.schemaHash,
        maxDate: v.stats.maxDate,
      },
      rowMask: [
        {
          symbol: row.symbol,
          date: row.date,
          rawBeforeHash: hash,
          rawAfterHash: await hashSeriesValue(row),
          changedColumns: ["close"],
        },
      ],
    },
  };
  return { plan, manifest: { currentSources: [{}], currentAsOfDate: "2026-10-28" } as any };
}
function clientMock(loss: "none" | "upload" | "insert", commit = true) {
  let row: any = null,
    blob: string | null = null;
  const calls: string[] = [];
  const client: any = {
    from: (table: string) => {
      expect(table).toBe("analysis_source_files");
      const q: any = {
        select: () => q,
        eq: () => q,
        limit: async () => ({ data: row ? [row] : [], error: null }),
        insert: async (value: any) => {
          calls.push("INSERT");
          if (commit || loss !== "insert") row = structuredClone(value);
          if (loss === "insert") throw new Error("lost insert response");
          return { error: null };
        },
        update: () => {
          throw new Error("FORBIDDEN_UPDATE");
        },
        delete: () => {
          throw new Error("FORBIDDEN_DELETE");
        },
      };
      return q;
    },
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("cloudtrend-data");
        return {
          download: async () =>
            blob === null
              ? { data: null, error: { statusCode: 404 } }
              : { data: new Blob([blob]), error: null },
          upload: async (_p: string, value: string, options: any) => {
            expect(options.upsert).toBe(false);
            calls.push("UPLOAD");
            if (commit || loss !== "upload") blob = value;
            if (loss === "upload") throw new Error("lost upload response");
            return { error: null };
          },
          info: async () => ({
            data: {
              size: new TextEncoder().encode(blob ?? "").byteLength,
              eTag: "opaque-synthetic",
              id: "synthetic-object",
              version: "1",
              lastModified: "2026-10-28T01:00:00Z",
            },
            error: null,
          }),
          remove: () => {
            throw new Error("FORBIDDEN_REMOVE");
          },
        };
      },
    },
    rpc: async () => {
      throw new Error("FORBIDDEN_ACTIVATION_RPC");
    },
  };
  return { client, calls, getRow: () => row };
}
it.each(["none", "upload", "insert"] as const)(
  "uses exact uncertain %s readback without deletion or duplicate writes",
  async (loss) => {
    const f = await fixture(),
      mock = clientMock(loss),
      input = {
        ...f,
        client: mock.client,
        owner,
        origin: "https://synthetic.supabase.co",
        key: "synthetic",
        planHash: hash,
        approvalHash: hash,
      };
    await registerReviewedHistory(input);
    expect(mock.calls).toEqual(["UPLOAD", "INSERT"]);
    await registerReviewedHistory(input);
    expect(mock.calls).toEqual(["UPLOAD", "INSERT"]);
    expect(mock.getRow().validation_result.krPublication).toBeUndefined();
    expect(mock.getRow().validation_result.reviewedHistoryCorrection.role).toBe("HISTORY_ONLY");
  },
);
it("uncertain INSERT without commit stops without deletion or activation", async () => {
  const f = await fixture(),
    mock = clientMock("insert", false);
  await expect(
    registerReviewedHistory({
      ...f,
      client: mock.client,
      owner,
      origin: "https://synthetic.supabase.co",
      key: "synthetic",
      planHash: hash,
      approvalHash: hash,
    }),
  ).rejects.toThrow();
  expect(mock.calls).toEqual(["UPLOAD", "INSERT"]);
  expect(mock.getRow()).toBeNull();
});
it("validate-only phase does no upload/insert/activate", async () => {
  const f = await fixture(),
    mock = clientMock("none");
  await registerReviewedHistory({
    ...f,
    client: mock.client,
    owner,
    origin: "https://synthetic.supabase.co",
    key: "synthetic",
    planHash: hash,
    approvalHash: hash,
    validateOnly: true,
  });
  expect(mock.calls).toEqual([]);
});
it("registration ID is deterministic and changes with independent approval", async () => {
  const f = await fixture();
  expect(await historyRegistrationIdentity(f.plan, hash, hash)).toEqual(
    await historyRegistrationIdentity(f.plan, hash, hash),
  );
  expect((await historyRegistrationIdentity(f.plan, hash, `sha256:${"b".repeat(64)}`)).id).not.toBe(
    (await historyRegistrationIdentity(f.plan, hash, hash)).id,
  );
});

it("rejects generation changes across info / hashed download / info without activation", async () => {
  const f = await fixture(),
    mock = clientMock("none");
  let infoCalls = 0;
  const original = mock.client.storage.from;
  mock.client.storage.from = (bucket: string) => {
    const b = original(bucket);
    return {
      ...b,
      info: async () => {
        const v = await b.info();
        v.data.version = String(++infoCalls);
        return v;
      },
    };
  };
  await expect(
    registerReviewedHistory({
      ...f,
      client: mock.client,
      owner,
      origin: "https://synthetic.supabase.co",
      key: "synthetic",
      planHash: hash,
      approvalHash: hash,
    }),
  ).rejects.toThrow();
  expect(infoCalls).toBe(2);
  expect(mock.calls).toEqual(["UPLOAD", "INSERT"]);
  expect(mock.getRow().status).toBe("valid");
});
