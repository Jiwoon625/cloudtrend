import assert from "node:assert/strict";
import test from "node:test";

import { parseCloudTrendCommand } from "../scripts/parse-cloudtrend-command.mjs";

test("uses safe defaults", () => {
  assert.deepEqual(parseCloudTrendCommand("/cloudtrend run"), {
    mode: "all",
    force: false,
    roundTripCostBps: 0,
    limit: 613,
    includeEtf: false,
  });
});

test("parses bounded options", () => {
  assert.deepEqual(
    parseCloudTrendCommand("/cloudtrend run backtest cost=30 limit=700 include-etf force"),
    {
      mode: "backtest",
      force: true,
      roundTripCostBps: 30,
      limit: 700,
      includeEtf: true,
    },
  );
});

test("rejects shell text and unknown options", () => {
  assert.throws(() => parseCloudTrendCommand("/cloudtrend run all; rm"));
  assert.throws(() => parseCloudTrendCommand("/cloudtrend run cost=-1"));
  assert.throws(() => parseCloudTrendCommand("run all"));
});
