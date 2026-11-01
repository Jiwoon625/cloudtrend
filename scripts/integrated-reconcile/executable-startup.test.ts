import { afterAll, beforeAll, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const root = process.cwd();
const temporary = mkdtempSync(path.join(tmpdir(), "integrated-startup-"));
const preload = path.join(temporary, "deny-network.mjs");
const cleanEnvironment = {
  ...process.env,
  RUNNER_TEMP: temporary,
  SUPABASE_URL: "",
  SUPABASE_USER_ID: "",
  SUPABASE_SERVICE_ROLE_KEY: "",
  RECONCILE_APPLY: "false",
  RECONCILE_INSPECTION_BUDGET_MIB: "8",
  RECONCILE_THROUGH_DATE: "2026-10-30",
};
const dummyConnection = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_USER_ID: "11111111-1111-4111-8111-111111111111",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic-test-only-not-a-credential",
};
beforeAll(() => {
  writeFileSync(
    preload,
    `let calls=0; globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({message:"SMOKE_NETWORK_DENIED"}),{status:400,headers:{"Content-Type":"application/json"}})}; process.on("exit",()=>console.error("SMOKE_FETCH_CALLS="+calls));`,
  );
  for (const build of ["build-integrated-reconcile.mjs", "build-integrated-reconcile-probe.mjs"]) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts", build)], {
      cwd: root,
      env: cleanEnvironment,
      encoding: "utf8",
      timeout: 30000,
    });
    expect(result.status, result.stderr).toBe(0);
  }
}, 60000);
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
function start(probe = false, overrides: Record<string, string> = {}, cwd = root) {
  const file = path.join(
    temporary,
    probe ? "integrated-reconcile-probe-code/probe.mjs" : "integrated-reconcile-code/run.mjs",
  );
  const result = spawnSync(process.execPath, ["--import", preload, file], {
    cwd,
    env: { ...cleanEnvironment, ...overrides },
    encoding: "utf8",
    timeout: 30000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).not.toContain("Dynamic require");
  expect(result.stderr).not.toContain("__filename is not defined");
  expect(result.stderr).not.toContain("__dirname is not defined");
  return result.stderr;
}
it("built reconciler starts and blocks missing configuration without network", () => {
  const stderr = start();
  expect(stderr).toContain("INTEGRATED_RECONCILIATION_BLOCKED");
  expect(stderr).toContain("SMOKE_FETCH_CALLS=0");
  expect(stderr).not.toContain("BOUNDED_READ_USAGE");
});
it("built reconciler completes real runtime preflight then reaches intercepted bounded read", () => {
  const stderr = start(false, dummyConnection);
  expect(stderr).toContain("SMOKE_FETCH_CALLS=1");
  const usage = JSON.parse(
    stderr.split("\n").find((line) => line.startsWith('{"stage":"BOUNDED_READ_USAGE"'))!,
  );
  expect(usage.requests).toBe(1);
  expect(usage.bytes).toBeGreaterThan(0);
  expect(usage.bytes).toBeLessThan(1024);
});
it("invalid inspection budget is rejected before client/network use", () => {
  const stderr = start(false, { ...dummyConnection, RECONCILE_INSPECTION_BUDGET_MIB: "9000" });
  expect(stderr).toContain("SMOKE_FETCH_CALLS=0");
  expect(stderr).not.toContain("BOUNDED_READ_USAGE");
});
it("original runtime preflight still blocks an unreviewed checkout before any request", () => {
  const stderr = start(false, dummyConnection, temporary);
  expect(stderr).toContain("SMOKE_FETCH_CALLS=0");
  expect(stderr).not.toContain("BOUNDED_READ_USAGE");
});
it("bootstrap avoids imported verifier direct-CLI footer without editing verifier", () => {
  expect(readFileSync(path.join(temporary, "integrated-reconcile-code/run.mjs"), "utf8")).toBe(
    'import "./entry-module.mjs";\n',
  );
});
it("already deployed probe executable still starts safely without credentials", () => {
  const stderr = start(true);
  expect(stderr).toContain("FIXED_READ_ONLY_PROBE_BLOCKED");
  expect(stderr).toContain("SMOKE_FETCH_CALLS=0");
});
it("probe executable with synthetic connection reaches only denied fetch", () => {
  const stderr = start(true, dummyConnection);
  expect(stderr).toContain("FIXED_READ_ONLY_PROBE_BLOCKED");
  expect(stderr).toContain("SMOKE_FETCH_CALLS=1");
});
