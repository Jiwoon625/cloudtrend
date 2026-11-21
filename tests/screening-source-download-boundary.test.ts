import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { gzipJson } from "../src/lib/cacheObjectEncoding";
import { resetFreshPointerCache } from "../src/lib/freshPointerCache";
import { deterministicAnalysis, stableCacheJson } from "../src/lib/screeningCacheContract";
import type { AnalysisResult } from "../src/lib/engine/pipeline";

const mocks = vi.hoisted(() => ({
  client: {} as Record<string, unknown>,
  downloads: [] as string[],
  sources: [] as unknown[],
  history: [] as unknown[],
  portfolioStore: vi.fn(),
}));

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ inputValidator: () => ({ handler: (fn: unknown) => fn }) }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => mocks.client }));
vi.mock("../src/lib/portfolioStoreCore", () => ({ createPortfolioStore: mocks.portfolioStore }));

import { getInstrumentChartForSession } from "../src/lib/instrumentCharts.functions";
import { portfolioServer } from "../src/lib/portfolio.functions";
import { dataStatusServer } from "../src/lib/webScreening.functions";

const OWNER = "owner";
const fingerprint = "a".repeat(64);
const analysis = {
  asOfDate: "2026-11-19",
  calculatedAt: "2026-11-19T11:00:00.000Z",
  rows: [],
  sectors: [],
  tradeDates: [],
} as unknown as AnalysisResult;
const resultDigest = createHash("sha256")
  .update(stableCacheJson(deterministicAnalysis(analysis)))
  .digest("hex");
const drivePublication = {
  version: "drive-result-publication-v1",
  baseFingerprint: "b".repeat(64),
  asOfDate: "2026-11-19",
  phase: "FINAL",
  sources: [],
};
const head = {
  version: "drive-input-head-v1",
  publicationId: "publication",
  inputFingerprint: fingerprint,
  resultDigest,
  engineIdentity: null,
  drivePublication,
};

function query(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "in", "is"])
    builder[method] = () => builder;
  builder["then"] = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: rows, error: null }).then(resolve);
  return builder;
}

function client(objects: Record<string, unknown>) {
  mocks.downloads = [];
  mocks.client = {
    auth: { getUser: async () => ({ data: { user: { id: OWNER } }, error: null }) },
    from: (table: string) =>
      table === "screening_history" ? query(mocks.history) : query(mocks.sources),
    storage: {
      from: () => ({
        download: async (path: string) => {
          mocks.downloads.push(path);
          for (const [suffix, value] of Object.entries(objects))
            if (path.endsWith(suffix))
              return path.endsWith(".gz")
                ? { data: new Blob([(await gzipJson(value)) as BlobPart]), error: null }
                : { data: new Blob([JSON.stringify(value)]), error: null };
          return { data: null, error: { message: "Object not found" } };
        },
        upload: async () => ({ error: null }),
      }),
    },
  };
  return mocks.client as never;
}

function sourceDownloads() {
  return mocks.downloads.filter((path) => path.includes("/source/"));
}

beforeEach(() => {
  vi.resetAllMocks();
  resetFreshPointerCache();
  mocks.sources = [];
  mocks.history = [];
  mocks.portfolioStore.mockImplementation(
    ({ ensureManualDataset }: { ensureManualDataset: () => Promise<unknown> }) => ({
      syncPortfolioFromHistory: () => ensureManualDataset(),
      loadPortfolioState: async () => ({ trades: [] }),
    }),
  );
});

describe("live web paths never download the whole active source set", () => {
  it("a chart request for a Drive generation fails visibly without touching source CSV", async () => {
    client({
      "cache/screening/latest.json.gz": {
        version: "screening-cache-v1",
        publicationId: "publication",
        inputFingerprint: fingerprint,
        resultDigest,
        payload: { analysis, source: { drivePublication } },
      },
      "input-head/latest.json": head,
    });
    await expect(
      getInstrumentChartForSession({
        accessToken: "token-" + "x".repeat(30),
        inputFingerprint: fingerprint,
        resultDigest,
        symbol: "005930",
        range: "all",
        kind: "prices",
      }),
    ).rejects.toThrow("상세 차트가 아직 준비되지 않았습니다");
    expect(sourceDownloads()).toEqual([]);
  });

  it("a legacy generation without the opt-in also refuses instead of downloading sources", async () => {
    client({
      "cache/screening/latest.json.gz": {
        version: "screening-cache-v1",
        publicationId: "publication",
        inputFingerprint: fingerprint,
        resultDigest,
        payload: { analysis, source: {} },
      },
    });
    await expect(
      getInstrumentChartForSession({
        accessToken: "token-" + "x".repeat(30),
        inputFingerprint: fingerprint,
        resultDigest,
        symbol: "005930",
        range: "120",
        kind: "prices",
      }),
    ).rejects.toThrow("상세 차트가 게시되지 않았습니다");
    expect(sourceDownloads()).toEqual([]);
  });

  it("portfolio sync with stored history refuses instead of rebuilding a dataset from sources", async () => {
    mocks.sources = [{ id: "source" }];
    mocks.history = [{ snapshot: { asOfDate: "2026-11-19", entries: [] } }];
    client({});
    await expect(
      portfolioServer({
        data: { accessToken: "token-" + "x".repeat(30), sync: true },
      }),
    ).rejects.toThrow("원장 화면");
    expect(sourceDownloads()).toEqual([]);
  });

  it("data status without a published summary asks for a republication instead of source CSV", async () => {
    mocks.sources = [{ id: "source", max_date: "2026-11-05" }];
    client({
      "cache/screening/latest.json.gz": {
        version: "screening-cache-v1",
        publicationId: "publication",
        inputFingerprint: fingerprint,
        resultDigest,
        payload: { analysis, source: {} },
      },
    });
    await expect(
      dataStatusServer({
        data: { accessToken: "token-" + "x".repeat(30), config: undefined },
      }),
    ).rejects.toThrow("데이터 상태 요약이 없습니다");
    expect(sourceDownloads()).toEqual([]);
  });
});
