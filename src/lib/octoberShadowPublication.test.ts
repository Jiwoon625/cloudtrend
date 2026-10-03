import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordWebOctoberShadow } from "./octoberShadowPublication.server";
import { DEFAULT_SCORING_CONFIG } from "./engine/scoring";
import type { AnalysisResult } from "./engine/pipeline";
import type { MarketDataset } from "./engine/dataset";
import type { ScreeningSnapshot } from "./screeningSnapshot";
const capture = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock("./ledger/octoberShadowPipeline", () => ({ recordOctoberPublication: capture.record }));
beforeEach(() => {
  capture.record.mockReset();
  capture.record.mockResolvedValue({ status: "RECORDED", records: [] });
});
const uid = "11111111-1111-4111-8111-111111111111";
function setup(date: string) {
  const previous = { asOfDate: "2026-10-02", entries: [{ symbol: "000001" }] };
  const eq = vi.fn();
  const builder = {
    select: () => builder,
    eq: (...args: unknown[]) => {
      eq(...args);
      return builder;
    },
    lt: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => ({ data: { snapshot: previous }, error: null }),
  };
  const from = vi.fn(() => builder);
  return {
    from,
    eq,
    input: {
      client: { from } as unknown as SupabaseClient,
      userId: uid,
      dataset: {} as MarketDataset,
      analysis: { asOfDate: date, rows: [{ instrument: { symbol: "000001" } }] } as AnalysisResult,
      config: DEFAULT_SCORING_CONFIG,
      snapshot: {} as ScreeningSnapshot,
      sources: [
        {
          id: "source",
          original_filename: "synthetic",
          storage_bucket: "cloudtrend-data",
          storage_path: `${uid}/source`,
          file_hash: `sha256:${"1".repeat(64)}`,
          data_hash: `sha256:${"2".repeat(64)}`,
          schema_hash: `sha256:${"3".repeat(64)}`,
          min_date: "2026-10-02",
          max_date: date,
          activated_at: `${date}T07:00:00Z`,
          created_at: `${date}T06:50:00Z`,
        },
      ],
      decisionAt: `${date}T08:00:00Z`,
    },
  };
}
describe("authenticated web publication connection", () => {
  it("does nothing before accounting start and does not create fake sessions", async () => {
    const { input, from } = setup("2026-10-02");
    expect((await recordWebOctoberShadow(input)).status).toBe("WAITING_START");
    expect(from).not.toHaveBeenCalled();
    expect(capture.record).not.toHaveBeenCalled();
  });
  it("binds the prior owner universe and source availability before invoking the common engine", async () => {
    const { input, eq } = setup("2026-10-06");
    await recordWebOctoberShadow(input);
    expect(eq).toHaveBeenCalledWith("user_id", uid);
    const payload = capture.record.mock.calls[0]![1];
    expect(payload).toMatchObject({
      market: "KR",
      availableAt: "2026-10-06T07:00:00Z",
      failedSymbols: 0,
      universeEvidence: { asOfDate: "2026-10-02", symbols: ["000001"] },
    });
    expect(payload.sourceEvidence).toHaveLength(1);
    expect(payload.codeHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(payload.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
  it("exposes append failures rather than reporting successful Shadow recording", async () => {
    const { input } = setup("2026-10-06");
    capture.record.mockRejectedValueOnce(new Error("owner append permission denied"));
    await expect(recordWebOctoberShadow(input)).rejects.toThrow("permission denied");
  });
});
