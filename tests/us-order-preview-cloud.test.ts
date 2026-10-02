import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadUsPortfolioSnapshots } from "../src/lib/usProspectiveCloud";
import { supabase } from "../src/lib/cloud";
import { usOrderPreviewsServer } from "../src/lib/usOrderPreview.functions";
import { buildUsOrderPreview } from "../src/lib/engine/usProspectiveOrderPreview";
import {
  US_PROSPECTIVE_STRATEGIES,
  type UsPortfolioState,
} from "../src/lib/engine/usProspectivePortfolio";

vi.mock("../src/lib/cloud", () => ({
  supabase: { from: vi.fn(), auth: { getSession: vi.fn() } },
  userId: vi.fn(async () => "owner"),
  ownerPath: vi.fn(),
  readObject: vi.fn(),
  readBinaryObject: vi.fn(),
}));
vi.mock("../src/lib/usOrderPreview.functions", () => ({ usOrderPreviewsServer: vi.fn() }));
const date = "2026-09-30";
const strategyId = "A0_QUARTER_PRIMARY";
const position = { symbol: "ABC", shares: 100 };
const preview = buildUsOrderPreview(
  US_PROSPECTIVE_STRATEGIES[0]!,
  {
    lastDate: date,
    positions: {},
    pendingTargets: {},
    pendingExits: {},
    cash: 100000,
  } as UsPortfolioState,
  [],
)!;
function rows(taxProjection: Record<string, unknown> = {}) {
  vi.mocked(supabase.from).mockImplementation(() => {
    const filters: Record<string, unknown> = {};
    const query = {
      select: vi.fn(() => query),
      eq: vi.fn((field: string, value: unknown) => {
        filters[field] = value;
        return query;
      }),
      order: vi.fn(() => query),
      limit: vi.fn(async () => ({
        data:
          filters["strategy_id"] === strategyId
            ? [
                { strategy_id: strategyId, date },
                { strategy_id: strategyId, date: "2026-09-29" },
              ]
            : filters["strategy_id"] === "SPY_BENCHMARK"
              ? [{ strategy_id: "SPY_BENCHMARK", date }]
              : [],
        error: null,
      })),
      single: vi.fn(async () => ({
        data: { positions: { ABC: position }, ...taxProjection },
        error: null,
      })),
    };
    return query as unknown as ReturnType<typeof supabase.from>;
  });
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: { session: { access_token: "access-token" } },
    error: null,
  } as Awaited<ReturnType<typeof supabase.auth.getSession>>);
}
beforeEach(() => {
  vi.clearAllMocks();
  rows();
});

describe("portfolio preview isolation", () => {
  it("attaches only the current matching preview, while retaining projected holdings", async () => {
    vi.mocked(usOrderPreviewsServer).mockResolvedValue([
      { strategyId, sourceDate: date, preview, error: null },
    ]);
    const result = await loadUsPortfolioSnapshots();
    const latest = result.find((r) => r.strategy_id === strategyId && r.date === date)!;
    expect(latest.state["positions"]).toEqual({ ABC: position });
    expect(latest.state.orderPreview).toEqual(preview);
    expect(latest.state.orderPreviewError).toBeNull();
    expect(result.find((r) => r.date === "2026-09-29")?.state).toEqual({});
    expect(result.find((r) => r.strategy_id === "SPY_BENCHMARK")?.state).not.toHaveProperty(
      "orderPreview",
    );
    expect(usOrderPreviewsServer).toHaveBeenCalledExactlyOnceWith({
      data: { accessToken: "access-token", requests: [{ strategyId, sourceDate: date }] },
    });
  });
  it("keeps holdings available when the preview transport fails", async () => {
    vi.mocked(usOrderPreviewsServer).mockRejectedValue(new Error("server offline"));
    const latest = (await loadUsPortfolioSnapshots()).find((r) => r.strategy_id === strategyId)!;
    expect(latest.state["positions"]).toEqual({ ABC: position });
    expect(latest.state.orderPreview).toBeNull();
    expect(latest.state.orderPreviewError).toBe("server offline");
  });
  it.each([
    { response: [{ strategyId, sourceDate: "2026-10-01", preview, error: null }] },
    {
      response: [
        {
          strategyId,
          sourceDate: date,
          preview: { ...preview, sourceDate: "2026-10-01" },
          error: null,
        },
      ],
    },
    { response: [] },
  ])("does not attach a missing or cross-snapshot preview: %j", async ({ response }) => {
    vi.mocked(usOrderPreviewsServer).mockResolvedValue(response);
    const latest = (await loadUsPortfolioSnapshots()).find((r) => r.strategy_id === strategyId)!;
    expect(latest.state["positions"]).toEqual({ ABC: position });
    expect(latest.state.orderPreview).toBeNull();
    expect(latest.state.orderPreviewError).toContain("갱신 중");
  });
  it("does not turn null data into an empty successful order plan", async () => {
    vi.mocked(usOrderPreviewsServer).mockResolvedValue([
      { strategyId, sourceDate: date, preview: null, error: null },
    ]);
    const latest = (await loadUsPortfolioSnapshots()).find((r) => r.strategy_id === strategyId)!;
    expect(latest.state.orderPreview).toBeNull();
    expect(latest.state.orderPreviewError).toContain("없습니다");
  });
  it("keeps holdings when preview authentication cannot be obtained", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: null }, error: null });
    const latest = (await loadUsPortfolioSnapshots()).find((r) => r.strategy_id === strategyId)!;
    expect(latest.state["positions"]).toEqual({ ABC: position });
    expect(latest.state.orderPreviewError).toContain("로그인");
    expect(usOrderPreviewsServer).not.toHaveBeenCalled();
  });
});

describe("tax source read isolation", () => {
  it("returns holdings without waiting for expensive tax-history projection", async () => {
    rows({ initialCapital: 100000 });
    vi.mocked(usOrderPreviewsServer).mockResolvedValue([]);
    const result = await loadUsPortfolioSnapshots();
    const latest = result.find((r) => r.strategy_id === strategyId && r.date === date)!;
    expect(latest.state["initialCapital"]).toBe(100000);
    expect(latest.state).not.toHaveProperty("taxEvidence");
    expect(latest.state["positions"]).toEqual({ ABC: position });
  });
});
