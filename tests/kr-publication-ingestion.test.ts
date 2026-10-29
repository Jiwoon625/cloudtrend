import { KR_ETF_LIFECYCLE_EVENTS, parseKrEtfLifecyclePlan } from "../src/lib/krEtfLifecycle";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { preliminarySource } from "./kr-preliminary-fixture";
const mocks = vi.hoisted(() => ({ register: vi.fn(), download: vi.fn(), remove: vi.fn() }));
vi.mock("../scripts/analysis-run-store", () => ({
  ANALYSIS_BUCKET: "cloudtrend-data",
  trustedSupabaseClient: () => ({
    storage: { from: () => ({ download: mocks.download, remove: mocks.remove }) },
  }),
}));
vi.mock("../scripts/source-registry-store", () => ({
  registerSourceBytes: mocks.register,
  listSourceRecords: vi.fn(),
  removeSourceRecord: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (options: unknown) => options }));
import { finalizeUpload, Route } from "../src/routes/api.gpt.upload";
import { ingestSource, parseArgs } from "../scripts/ingest-source";
const uid = "00000000-0000-4000-8000-000000000001";
let dir = "";
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("SUPABASE_USER_ID", uid);
  vi.stubEnv("CLOUDTREND_GPT_API_KEY", "synthetic-test-key");
  dir = await mkdtemp(path.join(tmpdir(), "kr-ingest-"));
  mocks.register.mockRejectedValue(new Error("REGISTRATION_BOUNDARY"));
  mocks.download.mockResolvedValue({ data: new Blob(["synthetic source"]), error: null });
  mocks.remove.mockResolvedValue({ error: null });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});
it("forwards an allowlisted optional contract through authenticated API finalize", async () => {
  const p = preliminarySource().source.validation_result.krPublication;
  await expect(
    finalizeUpload({
      action: "finalize",
      tempPath: `${uid}/incoming/gpt/test/source.csv`,
      filename: "source.csv",
      sourceType: "screening",
      krPublication: p,
    }),
  ).rejects.toThrow("REGISTRATION_BOUNDARY");
  expect(mocks.register.mock.calls[0]![0].krPublication).toMatchObject({
    requestId: p.requestId,
    manifestSha256: p.manifestSha256,
  });
  expect(mocks.register.mock.calls[0]![0].krPublication).not.toHaveProperty("sourceFileHash");
});
it("keeps API authentication and owner-path restrictions before registration", async () => {
  const route = Route as unknown as {
    server: { handlers: { POST: (input: { request: Request }) => Promise<Response> } };
  };
  const response = await route.server.handlers.POST({
    request: new Request("https://example.test/api/gpt/upload", { method: "POST", body: "{}" }),
  });
  expect(response.status).toBe(401);
  await expect(
    finalizeUpload({
      action: "finalize",
      tempPath: "another-owner/incoming/file.csv",
      filename: "source.csv",
      sourceType: "screening",
    }),
  ).rejects.toThrow("허용되지");
  expect(mocks.register).not.toHaveBeenCalled();
});
it("forwards a validated local request JSON through CLI registration", async () => {
  const p = preliminarySource().source.validation_result.krPublication;
  const csv = path.join(dir, "source.csv"),
    request = path.join(dir, "request.json");
  await writeFile(
    csv,
    "symbol,name,market,type,date,close,volume,marketCapSource\nTEST,Synthetic,KOSPI,STOCK,2026-10-06,100,1000,KRX_PENDING_PUBLICATION\n",
  );
  await writeFile(request, JSON.stringify(p));
  await expect(
    ingestSource([
      "--input",
      csv,
      "--source-type",
      "screening",
      "--mode",
      "merge",
      "--supabase-user-id",
      uid,
      "--kr-publication",
      request,
    ]),
  ).rejects.toThrow("REGISTRATION_BOUNDARY");
  expect(mocks.register.mock.calls[0]![0].krPublication).toMatchObject({ requestId: p.requestId });
});
it("rejects publication contracts on a backtest CLI request", () => {
  expect(() =>
    parseArgs([
      "--input",
      "source.csv",
      "--source-type",
      "backtest",
      "--kr-publication",
      "request.json",
    ]),
  ).toThrow("requires screening");
});

it("forwards independently validated lifecycle through CLI and API without requiring pending KRX", async () => {
  const life = parseKrEtfLifecyclePlan({
    version: "kr-etf-lifecycle-v1",
    sourceUniverseSymbols: ["005930", "261920", "280320", "465620"],
    requestedCollectionDates: ["2026-10-29"],
    events: KR_ETF_LIFECYCLE_EVENTS,
    requestedSymbols: ["005930"],
    latestExpectedSymbols: ["005930"],
  });
  const input = path.join(dir, "life.csv"),
    request = path.join(dir, "life.json");
  await writeFile(
    input,
    "symbol,name,market,type,date,close,volume\nKOSPI,KOSPI,INDEX,INDEX,2026-10-29,2500,0\nKOSDAQ,KOSDAQ,INDEX,INDEX,2026-10-29,800,0\n005930,Test,KOSPI,STOCK,2026-10-29,100,1000\n",
  );
  await writeFile(request, JSON.stringify(life));
  await expect(
    ingestSource([
      "--input",
      input,
      "--source-type",
      "screening",
      "--mode",
      "merge",
      "--supabase-user-id",
      uid,
      "--kr-lifecycle",
      request,
    ]),
  ).rejects.toThrow("REGISTRATION_BOUNDARY");
  expect(mocks.register.mock.calls[0]![0].krLifecycle).toEqual(life);
  await expect(
    finalizeUpload({
      action: "finalize",
      tempPath: `${uid}/incoming/gpt/life.csv`,
      filename: "life.csv",
      sourceType: "screening",
      krLifecycle: life,
    }),
  ).rejects.toThrow("REGISTRATION_BOUNDARY");
  expect(mocks.register.mock.calls[1]![0].krLifecycle).toEqual(life);
  expect(() =>
    parseArgs(["--input", input, "--source-type", "backtest", "--kr-lifecycle", request]),
  ).toThrow("requires screening");
});
