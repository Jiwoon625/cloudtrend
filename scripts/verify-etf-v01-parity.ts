import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { calculateEtfStrategies, ETF_POLICY } from "../src/lib/engine/etfStrategy";
import type { MarketDataset } from "../src/lib/engine/dataset";

const input = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as {
  dataset: MarketDataset;
  expected: Array<{
    symbol: string;
    environmentScore: number;
    environmentSource: string;
    uMa60: number;
  }>;
};
const results = calculateEtfStrategies(input.dataset);
assert.equal(input.expected.length, 144);
const rows = input.expected.map((e) => {
  const a = results.get(e.symbol)!;
  assert.ok(a && a.environment !== null, `missing environment ${e.symbol}`);
  const error = Math.abs(e.environmentScore - a.environment);
  assert.ok(error < 1e-8, `environment mismatch ${e.symbol}: ${error}`);
  assert.ok(a.underlyingMa60 !== null && Math.abs(a.underlyingMa60 - e.uMa60) < 1e-7);
  assert.equal(
    a.environmentSource,
    e.environmentSource === "regional_peer_mix_lag1" ? "peer_mix_lag1" : "own_index_lag1",
  );
  return {
    symbol: e.symbol,
    source: a.environmentSource,
    expected: e.environmentScore,
    actual: a.environment,
    error,
  };
});
const output = {
  policy: ETF_POLICY,
  date: input.dataset.asOfDate,
  sourceRuns: [35564981988, 35567515449],
  scope: "external environment and underlying MA60 parity; not total-score or live-source parity",
  checked: rows.length,
  maxAbsoluteError: Math.max(...rows.map((r) => r.error)),
  passed: true,
  rows,
};
writeFileSync(process.argv[3]!, JSON.stringify(output, null, 2));
console.log(
  JSON.stringify({
    checked: output.checked,
    maxAbsoluteError: output.maxAbsoluteError,
    passed: true,
  }),
);
