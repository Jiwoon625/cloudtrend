import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fixtureSeries, hash } from "../../../tests/october-shadow-fixtures";
import { runUsProspectiveAnalysis, type UsProspectiveInputRow } from "../engine/usProspective";
import { US_PROSPECTIVE_STRATEGIES } from "../engine/usProspectivePortfolio";
import { octoberShadowStore } from "./octoberShadowRepository.server";
import {
  canonicalSeriesJson,
  hashSeriesValue,
  stepAdoptedUsSeries,
  type FrozenModelSeries,
} from "./modelSeries";

const owner = "11111111-1111-4111-8111-111111111111";
// PostgreSQL jsonb object output orders shorter keys first, then lexicographically.
function jsonbRoundTrip<T>(value: T): T {
  const reorder = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(reorder);
    if (input !== null && typeof input === "object")
      return Object.fromEntries(
        Object.keys(input)
          .sort((a, b) => a.length - b.length || a.localeCompare(b))
          .map((key) => [key, reorder((input as Record<string, unknown>)[key])]),
      );
    return input;
  };
  return reorder(JSON.parse(JSON.stringify(value))) as T;
}
function reader(payload: FrozenModelSeries | null) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data: payload ? { payload } : null, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const from = vi.fn().mockReturnValue(query);
  return { store: octoberShadowStore({ from } as unknown as SupabaseClient, owner), query, from };
}
function input(date: string, series: FrozenModelSeries) {
  const row: UsProspectiveInputRow = {
    date,
    symbol: "TEST",
    name: "Synthetic",
    market: "NASDAQ",
    sector: "TECH",
    securityType: "STOCK",
    status: "ACTIVE",
    currency: "USD",
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1e6,
    dollarVolume: 1e8,
    sharesOutstanding: 1e8,
    marketCap: 1e10,
    ret120: 1,
    ret252: 1,
    beta60Spy: 1,
    ichimokuTkGap: 1,
    relvol1_20: 1,
    adv20Usd: 1e9,
    amihud20: 0.001,
    active20: true,
    tossTradable: true,
    isCommonShare: true,
    fxUsdKrw: 1359.6,
  };
  return {
    analysis: runUsProspectiveAnalysis([row]),
    sourceHash: hash("b"),
    codeHash: series.codeHash,
    configHash: series.configHash,
    calendar: {
      market: "US" as const,
      sourceHash: hash("d"),
      coverageStart: "2026-10-01",
      coverageEnd: "2026-10-16",
      regularSessions: [
        "2026-10-01",
        "2026-10-02",
        "2026-10-12",
        "2026-10-13",
        "2026-10-14",
        "2026-10-15",
        "2026-10-16",
      ],
    },
    availableAt: `${date}T21:00:00Z`,
    decisionAt: `${date}T21:30:00Z`,
  };
}

describe("JSONB registry strategy hydration preserves frozen values and engine guards", () => {
  it.each(["US_A0", "US_A2", "US_B3"] as const)(
    "hydrates %s and survives persisted next-session execution",
    async (kind) => {
      const original = await fixtureSeries(kind),
        stored = jsonbRoundTrip(original);
      const before = JSON.stringify(stored),
        originalCatalog = structuredClone(US_PROSPECTIVE_STRATEGIES);
      const firstInput = input("2026-10-12", original);
      // Reproduce the production failure without any strategy/value mismatch.
      expect(canonicalSeriesJson(stored)).toBe(canonicalSeriesJson(original));
      await expect(stepAdoptedUsSeries(stored, firstInput, null)).rejects.toThrow(
        "unchanged adopted strategy",
      );
      const { store, query, from } = reader(stored);
      const hydrated = (await store.readSeries(original.bookId))!;
      expect(canonicalSeriesJson(hydrated)).toBe(canonicalSeriesJson(original));
      expect(JSON.stringify(stored)).toBe(before);
      expect(hydrated.policy.usAllocationPolicy).toBe(stored.policy.usAllocationPolicy);
      expect(from).toHaveBeenCalledWith("ledger_model_series");
      expect(query.eq).toHaveBeenCalledWith("user_id", owner);
      expect(query.eq).toHaveBeenCalledWith("series_id", original.bookId);
      const expectedFirst = await stepAdoptedUsSeries(original, firstInput, null);
      const first = await stepAdoptedUsSeries(hydrated, firstInput, null);
      expect(canonicalSeriesJson(first)).toBe(canonicalSeriesJson(expectedFirst));
      const persisted = jsonbRoundTrip(first.run);
      const reopened = (await reader(jsonbRoundTrip(original)).store.readSeries(original.bookId))!;
      const retry = await stepAdoptedUsSeries(reopened, firstInput, persisted);
      expect(retry.status).toBe("REUSE");
      const nextInput = input("2026-10-13", original);
      const expectedNext = await stepAdoptedUsSeries(original, nextInput, expectedFirst.run);
      const next = await stepAdoptedUsSeries(reopened, nextInput, persisted);
      expect(canonicalSeriesJson(next)).toBe(canonicalSeriesJson(expectedNext));
      (hydrated.policy.enginePolicy as unknown as { label: string }).label =
        "mutated returned copy";
      expect(US_PROSPECTIVE_STRATEGIES).toEqual(originalCatalog);
      expect(JSON.stringify(stored)).toBe(before);
    },
  );
  it.each(["exitCore", "betaExit", "extraKey", "bookId"])(
    "rejects tampering of %s before normalization",
    async (field) => {
      const stored = jsonbRoundTrip(await fixtureSeries());
      const policy = stored.policy.enginePolicy as Record<string, unknown>;
      if (field === "bookId") stored.bookId = "adopted-shadow-2026-10-12-v2:US_A2";
      else if (field === "betaExit") policy[field] = { rankBelow: 0.61, consecutiveDays: 3 };
      else policy[field] = field === "exitCore" ? 0.5 : true;
      await expect(reader(stored).store.readSeries(stored.bookId)).rejects.toThrow();
    },
  );
  it("rejects a self-consistent contract with a non-adopted strategy rather than normalizing it", async () => {
    const stored = jsonbRoundTrip(await fixtureSeries());
    (stored.policy.enginePolicy as Record<string, unknown>)["exitCore"] = 0.5;
    const { contractHash: _oldHash, ...body } = stored;
    stored.contractHash = await hashSeriesValue(body);
    await expect(reader(stored).store.readSeries(stored.bookId)).rejects.toThrow(
      "US registry strategy differs from the adopted strategy",
    );
  });
  it("leaves non-US registries and missing rows unchanged", async () => {
    const stored = jsonbRoundTrip(await fixtureSeries("KR_MIXED"));
    expect(await reader(stored).store.readSeries(stored.bookId)).toBe(stored);
    expect(await reader(null).store.readSeries("missing")).toBeNull();
  });
});
