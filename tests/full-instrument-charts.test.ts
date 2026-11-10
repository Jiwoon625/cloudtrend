import { expect, test, vi } from "vitest";
import { warmFullInstrumentCharts } from "../src/lib/fullInstrumentCharts.server";
import { warmRecentEtfCharts } from "../src/lib/instrumentChartStore.server";
import { runFullMarketAnalysis } from "../src/lib/engine/fullMarketAnalysis";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { createEtfChartFixture } from "./fixtures/etf-chart-fixture";
import { chartPath, chartReadyPath } from "../src/lib/instrumentChartContract";

const identity = { inputFingerprint: "a".repeat(64), resultDigest: "b".repeat(64) };
function fixture() {
  const ctx = {
    ...runFullMarketAnalysis(createEtfChartFixture(140), DEFAULT_SCORING_CONFIG),
    config: DEFAULT_SCORING_CONFIG,
  };
  const files = new Map<string, Uint8Array>();
  const upload = vi.fn(async (key: string, value: Uint8Array) => {
    files.set(key, value);
    return { error: null };
  });
  const download = vi.fn(async (key: string) =>
    files.has(key)
      ? { data: new Blob([files.get(key)! as BlobPart]), error: null }
      : { data: null, error: { statusCode: "404", message: "Object not found" } },
  );
  const client = { storage: { from: () => ({ upload, download }) } } as unknown as Parameters<
    typeof warmFullInstrumentCharts
  >[0];
  return { ctx, client, files, upload, download };
}

test("full ETF charts retain missing warmup and verify stored recent/full overlap", async () => {
  const { ctx, client, files, upload } = fixture();
  await warmRecentEtfCharts(client, "owner", identity, ctx);
  const coverage = await warmFullInstrumentCharts(client, "owner", identity, ctx);
  expect(coverage).toHaveLength(1);
  expect(coverage[0]).toMatchObject({ symbol: "360750", kind: "ETF", points: 140 });
  expect(coverage[0]!.m0Observations).toBe(21);
  const fullPath = `owner/${chartPath(identity, "360750", "all", "etf")}`;
  expect(files.has(fullPath)).toBe(true);
  expect(
    files.has(`owner/${chartReadyPath(identity, "etf").replace("-ready", "-all-ready")}`),
  ).toBe(true);
  const before = upload.mock.calls.filter(([key]) => key === fullPath).length;
  expect(await warmFullInstrumentCharts(client, "owner", identity, ctx)).toEqual(coverage);
  expect(upload.mock.calls.filter(([key]) => key === fullPath)).toHaveLength(before);
});

test("failed full-history storage readback never receives a completion marker", async () => {
  const { ctx, client, files, download } = fixture();
  await warmRecentEtfCharts(client, "owner", identity, ctx);
  const original = download.getMockImplementation()!;
  const fullPath = `owner/${chartPath(identity, "360750", "all", "etf")}`;
  download.mockImplementation(async (key) =>
    key === fullPath && files.has(key)
      ? { data: null, error: { statusCode: "404", message: "Object not found" } }
      : original(key),
  );
  await expect(warmFullInstrumentCharts(client, "owner", identity, ctx)).rejects.toThrow(
    "readback is missing",
  );
  expect([...files.keys()].some((key) => key.endsWith("etf-all-ready.json.gz"))).toBe(false);
});
