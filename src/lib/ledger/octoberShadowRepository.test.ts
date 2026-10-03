import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { appendFrozenModelRun } from "./modelRepository.server";
import { fixtureSeries, usRun } from "../../../tests/october-shadow-fixtures";
import { octoberShadowStore } from "./octoberShadowRepository.server";

describe("service and owner-scoped October append boundaries", () => {
  it("uses owner-only RPC without caller-supplied user/registry fields for authenticated publication", async () => {
    const series = await fixtureSeries(),
      run = await usRun(series);
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { reused: false, stateHash: run.stateHash }, error: null });
    await appendFrozenModelRun(
      { rpc } as unknown as SupabaseClient,
      "11111111-1111-4111-8111-111111111111",
      series,
      run,
      null,
      "authenticated-owner",
    );
    expect(rpc).toHaveBeenCalledWith("ledger_append_own_october_model_session", {
      p_run: run,
      p_previous_date: null,
      p_previous_hash: null,
    });
    expect(rpc.mock.calls[0]![1]).not.toHaveProperty("p_user_id");
    expect(rpc.mock.calls[0]![1]).not.toHaveProperty("p_series");
  });
  it("preserves existing service-only RPC and refuses an authenticated initializer", async () => {
    const series = await fixtureSeries(),
      run = await usRun(series);
    const rpc = vi
      .fn()
      .mockResolvedValue({ data: { reused: false, stateHash: run.stateHash }, error: null });
    const client = { rpc } as unknown as SupabaseClient;
    await appendFrozenModelRun(client, "11111111-1111-4111-8111-111111111111", series, run, null);
    expect(rpc.mock.calls[0]![0]).toBe("ledger_append_model_session");
    await expect(
      octoberShadowStore(
        client,
        "11111111-1111-4111-8111-111111111111",
        "authenticated-owner",
      ).insertSeries(series),
    ).rejects.toThrow("service-only");
  });
  it("rejects body tampering before either RPC is called", async () => {
    const series = await fixtureSeries(),
      run = await usRun(series);
    run.publication.inputHash = `sha256:${"f".repeat(64)}`;
    const rpc = vi.fn();
    await expect(
      appendFrozenModelRun(
        { rpc } as unknown as SupabaseClient,
        "11111111-1111-4111-8111-111111111111",
        series,
        run,
        null,
        "authenticated-owner",
      ),
    ).rejects.toThrow("integrity");
    expect(rpc).not.toHaveBeenCalled();
  });
});
