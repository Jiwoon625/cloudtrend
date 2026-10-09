import { afterEach, describe, expect, it, vi } from "vitest";
import { RESTART_SERIES_VERSION } from "./ledger/modelSeries";
const load = vi.hoisted(() => vi.fn().mockResolvedValue({ books: [] }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (value: unknown) => unknown) => ({
      handler: (handle: (args: { data: unknown }) => unknown) => async (args: { data: unknown }) =>
        handle({ data: validate(args.data) }),
    }),
  }),
}));
vi.mock("./octoberShadowSummary.server", () => ({ loadOctoberShadowSummary: load }));
import { octoberShadowSummaryServer } from "./octoberShadowSummary.functions";
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("website Shadow request boundary", () => {
  it("defaults to the restart even before its start date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-09T15:00:00Z"));
    await octoberShadowSummaryServer({ data: { accessToken: "synthetic-session" } });
    expect(load).toHaveBeenCalledWith("synthetic-session", RESTART_SERIES_VERSION, undefined);
  });
  it("rejects beta selection before reading data", async () => {
    await expect(
      octoberShadowSummaryServer({
        data: {
          accessToken: "synthetic-session",
          version: "adopted-shadow-2026-10-05-v1" as typeof RESTART_SERIES_VERSION,
        },
      }),
    ).rejects.toThrow();
    expect(load).not.toHaveBeenCalled();
  });
  it("keeps the authenticated current-series request and selected detail", async () => {
    await octoberShadowSummaryServer({
      data: {
        accessToken: "synthetic-session",
        version: RESTART_SERIES_VERSION,
        detailKind: "US_A0",
      },
    });
    expect(load).toHaveBeenCalledWith("synthetic-session", RESTART_SERIES_VERSION, "US_A0");
  });
});
