import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { captureProgress, safeCaptureProgress, safeChildTermination } from "./diagnostics";
import { computeNov3Capture } from "./capture-compute";

it("allows only fixed stages and bounded nonnegative integer counters", () => {
  expect(
    safeCaptureProgress({
      stage: "SOURCE_MANIFEST",
      sourceIndex: 6,
      elapsedMs: 1,
      rssBytes: 2,
      heapUsedBytes: 3,
      externalBytes: 4,
      secret: "private",
    }),
  ).toEqual({
    stage: "SOURCE_MANIFEST",
    sourceIndex: 6,
    elapsedMs: 1,
    rssBytes: 2,
    heapUsedBytes: 3,
    externalBytes: 4,
  });
  expect(
    safeCaptureProgress({
      stage: "private",
      sourceIndex: 128,
      elapsedMs: -1,
      rssBytes: Infinity,
      heapUsedBytes: NaN,
      externalBytes: 1.5,
    }),
  ).toEqual({
    stage: "UNKNOWN",
    sourceIndex: null,
    elapsedMs: null,
    rssBytes: null,
    heapUsedBytes: null,
    externalBytes: null,
  });
  expect(captureProgress("CAPTURE_READ", null, Date.now()).stage).toBe("CAPTURE_READ");
});

it("never returns child error messages, stderr, stdout, paths or unknown enum values", () => {
  const secret = "PRIVATE_OWNER_SOURCE_PATH_AND_CREDENTIAL";
  const result = safeChildTermination({
    status: 1,
    signal: secret,
    error: { code: secret, message: secret, path: secret },
    stdout: secret,
    stderr: secret,
  });
  expect(result).toEqual({
    exitCode: 1,
    signal: "OTHER",
    spawnError: "OTHER",
    outOfMemoryMarker: false,
  });
  expect(JSON.stringify(result)).not.toContain(secret);
});

it("reports known termination details and OOM marker only as fixed values", () => {
  expect(
    safeChildTermination({
      status: null,
      signal: "SIGABRT",
      error: { code: "ETIMEDOUT" },
      stderr: "private FATAL ERROR: Reached heap limit private",
    }),
  ).toEqual({
    exitCode: null,
    signal: "SIGABRT",
    spawnError: "ETIMEDOUT",
    outOfMemoryMarker: true,
  });
  expect(safeChildTermination({ status: 0, signal: null })).toEqual({
    exitCode: 0,
    signal: null,
    spawnError: null,
    outOfMemoryMarker: false,
  });
});

it("records safe progress before a private malformed capture fails closed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nov3-diagnostic-test-"));
  try {
    fs.writeFileSync(path.join(dir, "capture.json"), "PRIVATE_MALFORMED_CAPTURE");
    await expect(computeNov3Capture(dir)).rejects.toThrow();
    const contents = fs.readFileSync(path.join(dir, "capture-progress.json"), "utf8");
    expect(JSON.parse(contents).stage).toBe("CAPTURE_READ");
    expect(contents).not.toContain("PRIVATE");
    expect(fs.statSync(path.join(dir, "capture-progress.json")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(dir, "capture-status.json"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("records the exact failing source stage without leaking captured identifiers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nov3-diagnostic-source-test-"));
  try {
    const id = "11111111-1111-4111-8111-111111111111";
    const bytes = "not,a,market,file\nprivate,private,private,private\n";
    fs.mkdirSync(path.join(dir, "sources"));
    fs.writeFileSync(path.join(dir, "sources", id), bytes);
    fs.writeFileSync(
      path.join(dir, "capture.json"),
      JSON.stringify({
        version: "kospi-nov3-readonly-capture-v1",
        owner: "PRIVATE_OWNER",
        sourceRows: [
          {
            id,
            user_id: "PRIVATE_OWNER",
            storage_bucket: "cloudtrend-data",
            storage_path: "PRIVATE_OWNER/source/screening/PRIVATE_PATH",
            original_filename: "private.csv",
            file_hash: "sha256:" + createHash("sha256").update(bytes).digest("hex"),
          },
        ],
      }),
    );
    await expect(computeNov3Capture(dir)).rejects.toThrow("NOV3_CAPTURE_REJECTED");
    const text = fs.readFileSync(path.join(dir, "capture-progress.json"), "utf8");
    expect(JSON.parse(text)).toMatchObject({ stage: "SOURCE_MANIFEST", sourceIndex: 0 });
    expect(text).not.toContain("PRIVATE");
    expect(text).not.toContain(id);
    expect(fs.existsSync(path.join(dir, "receipt.json"))).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("passes only fixed companion phase and check through the public diagnostic boundary", () => {
  const current = safeCaptureProgress({
    stage: "KR_COMPANION",
    krCompanion: { phase: "RAW_EVIDENCE", check: "RAW_SHORT_VOLUME", private: "SECRET" },
  });
  expect(current).toMatchObject({
    stage: "KR_COMPANION",
    krCompanion: { phase: "RAW_EVIDENCE", check: "RAW_SHORT_VOLUME" },
  });
  expect(JSON.stringify(current)).not.toContain("SECRET");
  const hostile = safeCaptureProgress({
    stage: "KR_COMPANION",
    krCompanion: { phase: "PRIVATE_SOURCE_PATH", check: "PRIVATE_FIELD_VALUE" },
  });
  expect(hostile.krCompanion).toEqual({ phase: "UNKNOWN", check: "UNKNOWN" });
  expect(JSON.stringify(hostile)).not.toContain("PRIVATE");
  expect(
    captureProgress("KR_COMPANION", null, Date.now(), {
      phase: "CAPTURE_ENCODING",
      check: "CAPTURE_CODEC_REJECTED",
    }).krCompanion,
  ).toEqual({ phase: "CAPTURE_ENCODING", check: "CAPTURE_CODEC_REJECTED" });
});
