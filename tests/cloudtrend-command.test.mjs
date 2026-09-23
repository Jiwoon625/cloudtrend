import assert from "node:assert/strict";
import test from "node:test";

import { parseCloudTrendCommand } from "../scripts/parse-cloudtrend-command.mjs";

test("uses screening-only safe defaults", () => {
  assert.deepEqual(parseCloudTrendCommand("/cloudtrend run"), { force: false });
  assert.deepEqual(parseCloudTrendCommand("/cloudtrend run screening"), { force: false });
});

test("accepts force for screening", () => {
  assert.deepEqual(parseCloudTrendCommand("/cloudtrend run screening force"), { force: true });
  assert.deepEqual(parseCloudTrendCommand("/cloudtrend run force"), { force: true });
});

test("rejects retired backtest and shell-like options", () => {
  assert.throws(() => parseCloudTrendCommand("/cloudtrend run backtest"));
  assert.throws(() => parseCloudTrendCommand("/cloudtrend run all"));
  assert.throws(() => parseCloudTrendCommand("/cloudtrend run cost=30"));
  assert.throws(() => parseCloudTrendCommand("/cloudtrend run all; rm"));
  assert.throws(() => parseCloudTrendCommand("run screening"));
});
