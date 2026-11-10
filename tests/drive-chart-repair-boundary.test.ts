import { afterEach, expect, test, vi } from "vitest";
import { installChartRepairBoundary } from "../scripts/drive-chart-repair";
import { KR_OWNER } from "../scripts/drive-history-inputs";

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; vi.restoreAllMocks(); });
const request = {
  version: "drive-chart-restoration-v1",
  mode: "repair" as const,
  inputFingerprint: "a".repeat(64),
  resultDigest: "b".repeat(64),
};
const base = "https://ahbvrtugugwnbrfnbxzp.supabase.co";
const chart = `${base}/storage/v1/object/cloudtrend-data/${KR_OWNER}/cache/charts/etf-chart-v3-operational-underlying/${request.inputFingerprint}/${request.resultDigest}/bucket-1-etf.json.gz`;

test("only verified chart uploads can be enabled; all source and ledger writes remain blocked", async () => {
  const network = vi.fn(async () => new Response("{}", { status: 200 }));
  globalThis.fetch = network;
  const boundary = installChartRepairBoundary(KR_OWNER, request);
  await expect(fetch(chart, { method: "POST" })).rejects.toThrow("blocked");
  boundary.enable();
  await fetch(chart, { method: "POST" });
  await fetch(`${base}/storage/v1/object/cloudtrend-data/${KR_OWNER}/cache/screening/latest.json`);
  for (const url of [
    `${base}/rest/v1/actual_trades`,
    `${base}/storage/v1/object/cloudtrend-data/${KR_OWNER}/cache/screening/latest.json`,
    chart.replace(KR_OWNER, "other-owner"),
    chart.replace(request.resultDigest, "c".repeat(64)),
    chart.replace("ahbvrtugugwnbrfnbxzp", "different-project"),
  ]) await expect(fetch(url, { method: "POST" })).rejects.toThrow("blocked");
  await expect(fetch(`${base}/storage/v1/object/cloudtrend-data/${KR_OWNER}/source/screening/source.csv`)).rejects.toThrow("blocked");
  await expect(fetch(chart, { method: "DELETE" })).rejects.toThrow("blocked");
  expect(network).toHaveBeenCalledTimes(2);
  expect(boundary.network.chartWrites).toBe(1);
  expect(boundary.network.sourceGETs).toBe(0);
  boundary.restore();
  expect(globalThis.fetch).toBe(network);
});

test("diagnosis mode cannot be promoted to a writer", () => {
  const boundary = installChartRepairBoundary(KR_OWNER, { ...request, mode: "diagnose" });
  expect(() => boundary.enable()).toThrow("Diagnosis cannot write");
  boundary.restore();
  expect(() => installChartRepairBoundary("other-owner", request)).toThrow();
  expect(() => installChartRepairBoundary(KR_OWNER, { ...request, resultDigest: "invalid" })).toThrow();
});
