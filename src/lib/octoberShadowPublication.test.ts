import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordWebOctoberShadow } from "./octoberShadowPublication.server";
import { DEFAULT_SCORING_CONFIG } from "./engine/scoring";
import type { AnalysisResult } from "./engine/pipeline";
import type { MarketDataset } from "./engine/dataset";
import type { ScreeningSnapshot } from "./screeningSnapshot";

const capture = vi.hoisted(() => ({ replay: vi.fn() }));
vi.mock("./shadowReplay.server", () => ({ replayKrShadow: capture.replay }));

beforeEach(() => {
  capture.replay.mockReset();
  capture.replay.mockResolvedValue({
    market: "KR",
    calculatedAt: "2026-10-08T00:00:00Z",
    processed: [{ date: "2026-10-06", status: "RECORDED", replayMode: "RETROSPECTIVE", records: [] }],
    deferred: null,
    latestRecordedDate: "2026-10-06",
    throughDate: "2026-10-06",
  });
});

const uid = "11111111-1111-4111-8111-111111111111";
function setup(date: string) {
  return {
    client: {} as SupabaseClient,
    userId: uid,
    dataset: { asOfDate: date } as MarketDataset,
    analysis: { asOfDate: date, rows: [] } as unknown as AnalysisResult,
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
        activated_at: "2026-10-08T00:00:00Z",
        created_at: "2026-10-08T00:00:00Z",
      },
    ],
    decisionAt: "2026-10-08T00:00:00Z",
  };
}

describe("authenticated web Shadow replay connection", () => {
  it("does nothing before accounting start", async () => {
    const input = setup("2026-10-02");
    expect((await recordWebOctoberShadow(input)).status).toBe("WAITING_START");
    expect(capture.replay).not.toHaveBeenCalled();
  });

  it("replays all missing dates independently of the web-screen calculation time", async () => {
    const input = setup("2026-10-06");
    const result = await recordWebOctoberShadow(input);
    expect(result.status).toBe("RECORDED");
    expect(capture.replay).toHaveBeenCalledWith(
      expect.objectContaining({
        client: input.client,
        userId: uid,
        dataset: input.dataset,
        config: DEFAULT_SCORING_CONFIG,
        mode: "authenticated-owner",
        calculatedAt: input.decisionAt,
      }),
    );
  });

  it("surfaces replay failures rather than reporting a successful Shadow write", async () => {
    capture.replay.mockRejectedValueOnce(new Error("append permission denied"));
    await expect(recordWebOctoberShadow(setup("2026-10-06"))).rejects.toThrow("permission denied");
  });
});
