import { beforeEach, expect, it, vi } from "vitest";
import { largeScreeningSnapshot } from "./screening-snapshot-storage-fixture";
import { serializeScreeningSnapshot } from "../src/lib/screeningSnapshotStorage";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";
const mocks = vi.hoisted(() => ({ client: {} as Record<string, unknown>, createStore: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({ inputValidator: () => ({ handler: (fn: unknown) => fn }) }),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: () => mocks.client }));
vi.mock("../src/lib/portfolioStoreCore", () => ({ createPortfolioStore: mocks.createStore }));
import { portfolioServer } from "../src/lib/portfolio.functions";

beforeEach(() => vi.resetAllMocks());
it.each([false, true])(
  "legacy portfolio endpoint hydrates compact history before sync=%s",
  async (sync) => {
    const snapshot = largeScreeningSnapshot();
    const stored = JSON.parse(JSON.stringify(serializeScreeningSnapshot(snapshot)));
    const query = {
      select: () => query,
      eq: () => query,
      order: () => query,
      limit: async () => ({ data: [{ snapshot: stored }], error: null }),
    };
    mocks.client = {
      auth: { getUser: async () => ({ data: { user: { id: "owner" } }, error: null }) },
      from: () => query,
    };
    mocks.createStore.mockImplementation(
      ({ loadSnapshots }: { loadSnapshots: () => ScreeningSnapshot[] }) => ({
        syncPortfolioFromHistory: loadSnapshots,
        loadPortfolioState: loadSnapshots,
      }),
    );
    const handler = portfolioServer as unknown as (input: {
      data: { accessToken: string; sync: boolean };
    }) => Promise<ScreeningSnapshot[]>;
    expect(await handler({ data: { accessToken: "synthetic-token", sync } })).toEqual([snapshot]);
  },
);
