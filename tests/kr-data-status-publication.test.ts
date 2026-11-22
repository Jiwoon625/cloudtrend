import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalysisResult } from "../src/lib/engine/pipeline";
import type { DataStatusPayload } from "../src/lib/marketPayload";
import { SCREENING_CACHE_VERSION } from "../src/lib/screeningCacheContract";
import {
  buildKrDataStatusPublication,
  deriveDataStatusFromPublishedAnalysis,
  krDataStatusObjectPath,
  krDataStatusPointerPath,
  latestSourceDate,
  publishedDataStatusIsCurrent,
  readKrDataStatusArtifact,
} from "../src/lib/dataStatusPublication";

const store = new Map<string, unknown>();
vi.mock("../src/lib/freshStorage", () => ({
  downloadFreshObject: vi.fn(async (_client: unknown, _bucket: string, path: string) => {
    if (!store.has(path))
      return { data: null, error: { message: "Object not found", statusCode: "404" } };
    const body = JSON.stringify(store.get(path));
    return { data: { text: async () => body }, error: null };
  }),
}));
vi.mock("../src/lib/cacheObjectStorage", async (original) => ({
  ...(await original<typeof import("../src/lib/cacheObjectStorage")>()),
  readFreshCacheObject: vi.fn(async (_client: unknown, _bucket: string, path: string) =>
    store.has(path) ? store.get(path) : null,
  ),
}));
const { readKrDataStatusPointer, resolvePublishedKrDataStatus } =
  await import("../src/lib/krDataStatus.server");

const owner = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
const publicationId = "2b841d97-e25d-441b-a634-13903d7493f9";
const resultDigest = "ce2d37669286a2bcab1a61a639a01ddbc2400f19f746978f08fc9c54d3d4c01d";

function payload(asOfDate = "2026-11-13"): DataStatusPayload {
  return {
    source: { live: true, credentialsConfigured: true, fallbackReason: null },
    qualityDate: "2026-11-16",
    qualityTimezone: "Asia/Seoul",
    asOfDate,
    dataProvider: "MANUAL_INPUT",
    dataVersion: `manual-${asOfDate}`,
    strategyVersion: "V8 Final",
    isLive: true,
    notes: ["note"],
    capabilities: {
      marketCap: true,
      fundamentals: false,
      etfFacts: false,
      sectors: true,
      investorFlow: true,
      volatilityIndex: true,
      exactTradingValue: true,
    },
    coverage: [
      {
        provider: "MANUAL_INPUT",
        kind: "종목 일봉(직접 입력)",
        count: 446_017,
        entities: 1_796,
        ok: true,
      },
    ],
    checks: {
      ohlcErrors: 0,
      negativeVolume: 0,
      duplicates: 0,
      futureDates: 0,
      insufficient: 44,
      abnormalMoves: 1,
    },
    barCoverage: [
      { symbol: "000100", name: "유한양행", bars: 395, first: "2025-04-02", last: asOfDate },
    ],
  };
}

function analysis(asOfDate = "2026-11-13"): AnalysisResult {
  const rows = [
    {
      instrument: { symbol: "000100", instrumentType: "STOCK" },
      marketCap: 1_000,
      snapshot: { tradeDate: asOfDate },
    },
    {
      instrument: { symbol: "000200", instrumentType: "STOCK" },
      marketCap: 0,
      snapshot: { tradeDate: asOfDate },
    },
    {
      instrument: { symbol: "069500", instrumentType: "ETF" },
      marketCap: null,
      snapshot: { tradeDate: "2026-11-12" },
    },
  ];
  return {
    asOfDate,
    dataProvider: "MANUAL_INPUT",
    dataVersion: `manual-${asOfDate}`,
    strategyVersion: "V8 Final",
    isLive: true,
    capabilities: {
      marketCap: true,
      fundamentals: false,
      etfFacts: false,
      sectors: true,
      investorFlow: true,
      volatilityIndex: true,
      exactTradingValue: true,
    },
    notes: ["시가총액은 입력값 기준"],
    rows,
  } as unknown as AnalysisResult;
}

function publish(asOfDate = "2026-11-13") {
  const built = buildKrDataStatusPublication({
    owner,
    publicationId,
    resultDigest,
    analysis: analysis(asOfDate),
    payload: payload(asOfDate),
    computedAt: "2026-11-16T05:57:54.419Z",
  });
  store.set(built.pointer.path, built.artifact);
  store.set(krDataStatusPointerPath(owner), built.pointer);
  return built;
}

beforeEach(() => store.clear());

describe("Drive v7 게시본에 묶인 한국 데이터 상태 요약", () => {
  it("stores the summary under the publication generation and reads it back", () => {
    const built = publish();
    expect(built.pointer.path).toBe(krDataStatusObjectPath(owner, publicationId));
    expect(built.artifact.payload.evidence).toMatchObject({
      source: "DRIVE_PUBLICATION_DATA_STATUS",
      asOfDate: "2026-11-13",
      phase: "FINAL",
      publicationId,
    });
    expect(readKrDataStatusArtifact(built.pointer, built.artifact)).toMatchObject({
      asOfDate: "2026-11-13",
      dataVersion: "manual-2026-11-13",
    });
  });

  it("refuses a summary from another generation or a damaged payload", () => {
    const built = publish();
    const other = { ...built.pointer, publicationId: "11111111-1111-1111-1111-111111111111" };
    expect(readKrDataStatusArtifact(other, built.artifact)).toBeNull();
    expect(
      readKrDataStatusArtifact(built.pointer, { ...built.artifact, resultDigest: "b".repeat(64) }),
    ).toBeNull();
    expect(
      readKrDataStatusArtifact(built.pointer, { ...built.artifact, version: "v0" }),
    ).toBeNull();
    expect(
      readKrDataStatusArtifact(built.pointer, {
        ...built.artifact,
        payload: { ...built.artifact.payload, asOfDate: "2026-11-12" },
      }),
    ).toBeNull();
    expect(
      readKrDataStatusArtifact(built.pointer, {
        ...built.artifact,
        payload: { ...built.artifact.payload, checks: { ohlcErrors: -1 } },
      }),
    ).toBeNull();
    // 포인터가 다른 세대의 객체를 가리키면 그 요약은 쓰지 않는다.
    expect(
      readKrDataStatusArtifact(
        { ...built.pointer, path: `${owner}/cache/data-status/${other.publicationId}.json` },
        built.artifact,
      ),
    ).toBeNull();
    expect(
      readKrDataStatusArtifact(built.pointer, built.artifact, { publicationId: "x" }),
    ).toBeNull();
  });

  it("never labels a summary with a different 기준일 than its publication", () => {
    expect(() =>
      buildKrDataStatusPublication({
        owner,
        publicationId,
        resultDigest,
        analysis: analysis("2026-11-13"),
        payload: payload("2026-11-12"),
      }),
    ).toThrow("기준일");
  });
});

describe("게시 시점 요약이 없을 때의 축약본", () => {
  it("keeps only what the published analysis supports and names the rest", () => {
    const derived = deriveDataStatusFromPublishedAnalysis(analysis());
    expect(derived.asOfDate).toBe("2026-11-13");
    expect(derived.checks).toBeUndefined();
    expect(derived.barCoverage).toBeUndefined();
    expect(derived.volatilityObservation).toBeUndefined();
    expect(derived.coverage).toEqual([
      {
        provider: "MANUAL_INPUT",
        kind: "종목 일봉(기준일)",
        count: 2,
        availableEntities: 2,
        asOfDate: "2026-11-13",
        entities: 3,
        ok: true,
      },
      {
        provider: "MANUAL_INPUT",
        kind: "시가총액",
        count: 1,
        availableEntities: 1,
        asOfDate: "2026-11-13",
        entities: 3,
        ok: false,
      },
    ]);
    expect(derived.evidence).toMatchObject({
      source: "PUBLISHED_ANALYSIS",
      phase: "FINAL",
      asOfDate: "2026-11-13",
    });
    expect(derived.evidence?.unavailable).toContain("barCoverage");
    expect(derived.evidence?.unavailable).toContain("checks");
    expect(derived.notes.at(-1)).toContain("다음 게시 실행부터");
  });
});

describe("게시본과 원천 CSV 중 무엇이 최신인가", () => {
  it("prefers the publication only while it is not older than the active source files", () => {
    expect(latestSourceDate([{ max_date: "2026-11-05" }, { max_date: "2026-10-20" }])).toBe(
      "2026-11-05",
    );
    expect(latestSourceDate([{ max_date: null }, {}])).toBeNull();
    expect(publishedDataStatusIsCurrent("2026-11-13", "2026-11-05")).toBe(true);
    expect(publishedDataStatusIsCurrent("2026-11-13", "2026-11-13")).toBe(true);
    expect(publishedDataStatusIsCurrent("2026-11-05", "2026-11-13")).toBe(false);
    expect(publishedDataStatusIsCurrent("2026-11-13", null)).toBe(true);
  });

  it("resolves a published summary, an analysis-only fallback, and finally no answer", async () => {
    const client = {} as never;
    expect(await readKrDataStatusPointer(client, owner)).toBeNull();
    expect(await resolvePublishedKrDataStatus(client, owner, "2026-11-05", null)).toBeNull();

    // 게시본이 있지만 아직 게시 시점 요약이 없는 세대 → 분석 기반 축약본.
    store.set(`${owner}/cache/screening/latest.json`, {
      version: SCREENING_CACHE_VERSION,
      publicationId,
      resultDigest,
      payload: { analysis: analysis(), source: { drivePublication: { asOfDate: "2026-11-13" } } },
    });
    expect(await resolvePublishedKrDataStatus(client, owner, "2026-11-05", null)).toMatchObject({
      asOfDate: "2026-11-13",
      evidence: { source: "PUBLISHED_ANALYSIS" },
    });
    // 원천 CSV가 게시본보다 최신이면 CSV 결과가 정본이다.
    expect(await resolvePublishedKrDataStatus(client, owner, "2026-11-14", null)).toBeNull();

    // 게시 시점 요약이 있으면 그것을 쓴다.
    const built = publish();
    const pointer = await readKrDataStatusPointer(client, owner);
    expect(pointer).toMatchObject({ publicationId, asOfDate: "2026-11-13" });
    const resolved = await resolvePublishedKrDataStatus(client, owner, "2026-11-05", pointer);
    expect(resolved).toMatchObject({
      asOfDate: "2026-11-13",
      evidence: { source: "DRIVE_PUBLICATION_DATA_STATUS" },
    });
    expect(resolved?.checks?.insufficient).toBe(44);
    expect(resolved?.barCoverage).toHaveLength(1);
    expect(built.artifact.payload.asOfDate).toBe("2026-11-13");
  });

  it("does not treat a CSV-published screening cache as a Drive publication", async () => {
    store.set(`${owner}/cache/screening/latest.json`, {
      version: SCREENING_CACHE_VERSION,
      publicationId,
      resultDigest,
      payload: { analysis: analysis(), source: { live: true } },
    });
    expect(await resolvePublishedKrDataStatus({} as never, owner, "2026-11-05", null)).toBeNull();
  });
});
