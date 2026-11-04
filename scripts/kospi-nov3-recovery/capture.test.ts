import { expect, it } from "vitest";
import fs from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { SOURCE_MAX_FILE_BYTES } from "../../src/lib/sourceData";
import os from "node:os";
import path from "node:path";
import { computeNov3Capture } from "./capture-compute";
import { assertWorkflow } from "./entry";
const owner = "00000000-0000-0000-0000-000000000001",
  id = "00000000-0000-0000-0000-000000000002";
it("PLAN alone can omit hashes, never AUTHORIZE/VALIDATE/APPLY", () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_WORKFLOW: "KOSPI Nov3 reviewed recovery",
    RECOVERY_CONCURRENCY_GROUP: "kospi-prospective-shadow",
    GITHUB_SHA: "a".repeat(40),
    RECOVERY_MODE: "PLAN",
  };
  expect(() => assertWorkflow(env)).not.toThrow();
  for (const mode of ["AUTHORIZE", "VALIDATE", "APPLY"])
    expect(() => assertWorkflow({ ...env, RECOVERY_MODE: mode })).toThrow();
});
it("pure capture rejects changed source bytes before parsing and never emits a plan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nov3-capture-test-"));
  try {
    fs.mkdirSync(path.join(dir, "sources"));
    fs.writeFileSync(path.join(dir, "sources", id), "changed bytes");
    const capture = {
      version: "kospi-nov3-readonly-capture-v1",
      owner,
      sourceRows: [
        {
          id,
          user_id: owner,
          storage_bucket: "cloudtrend-data",
          storage_path: owner + "/source/screening/source.csv",
          file_hash: "sha256:" + "a".repeat(64),
        },
      ],
    };
    fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify(capture));
    await expect(computeNov3Capture(dir)).rejects.toThrow("NOV3_CAPTURE_REJECTED");
    expect(fs.existsSync(path.join(dir, "capsule.json"))).toBe(false);
    capture.sourceRows[0].id = "../../outside";
    fs.writeFileSync(path.join(dir, "capture.json"), JSON.stringify(capture));
    await expect(computeNov3Capture(dir)).rejects.toThrow("NOV3_CAPTURE_REJECTED");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("rejects oversized gzip expansion before validation or plan creation", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nov3-gzip-test-"));
  try {
    fs.mkdirSync(path.join(dir, "sources"));
    const bytes = gzipSync(Buffer.alloc(SOURCE_MAX_FILE_BYTES + 1, 65));
    fs.writeFileSync(path.join(dir, "sources", id), bytes);
    fs.writeFileSync(
      path.join(dir, "capture.json"),
      JSON.stringify({
        version: "kospi-nov3-readonly-capture-v1",
        owner,
        sourceRows: [
          {
            id,
            user_id: owner,
            storage_bucket: "cloudtrend-data",
            storage_path: owner + "/source/screening/source.csv.gz",
            file_hash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
            canonical_format: "csv.gz",
          },
        ],
      }),
    );
    await expect(computeNov3Capture(dir)).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, "capsule.json"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
