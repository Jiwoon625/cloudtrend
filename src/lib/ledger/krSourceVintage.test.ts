import { describe, expect, it } from "vitest";
import type { DailyPrice } from "../engine/types";
import type { StrategyLedger } from "../portfolioLedgers";
import { hashSeriesValue } from "./modelSeries";
import {
  reconcileKrHistoricalSourceVintage,
  assertKrSourceVintageReceipt,
  type KrSourceVintageReview,
} from "./krSourceVintage";

async function fixture() {
  const archived: DailyPrice = {
    tradeDate: "2026-10-12",
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 0,
    tradingValue: 0,
    marketCap: 1000,
    foreignNetBuyValue: 0,
    institutionNetBuyValue: 0,
    openObserved: true,
    volumeObserved: true,
  };
  const incoming = { ...archived, open: 500, high: 500, low: 500, close: 500 };
  const review: KrSourceVintageReview = {
    id: "synthetic-reviewed-pair",
    symbol: "TEST",
    date: archived.tradeDate,
    notBefore: "2026-10-14",
    archivedHash: await hashSeriesValue(archived),
    incomingHash: await hashSeriesValue(incoming),
    evidenceUrl: "https://example.invalid/evidence",
  };
  return {
    symbol: "TEST",
    archived,
    incoming,
    publicationDate: "2026-10-14",
    previousResult: {
      trades: [],
      candidates: [],
      quotes: { TEST: { price: 100, date: "2026-10-12", exitSignal: null } },
    } as unknown as StrategyLedger,
    reviews: [review],
  };
}

describe("separate incoming analysis vintage from frozen economic observations", () => {
  it("rejects forged retained review identity and duplicate review definitions", async () => {
    const f = await fixture();
    const receipt = (await reconcileKrHistoricalSourceVintage(f))!;
    expect(() =>
      assertKrSourceVintageReceipt({ ...receipt, id: "forged-review" }, f.reviews),
    ).toThrow("Unreviewed retained");
    expect(() => assertKrSourceVintageReceipt({ ...receipt, fields: [] }, f.reviews)).toThrow(
      "Unreviewed retained",
    );
    expect(() => assertKrSourceVintageReceipt(receipt, [...f.reviews, ...f.reviews])).toThrow(
      "Unreviewed retained",
    );
  });
  it("returns no metadata for unchanged inputs and keeps the old path byte-equivalent", async () => {
    const f = await fixture();
    expect(
      await reconcileKrHistoricalSourceVintage({ ...f, incoming: f.archived, reviews: [] }),
    ).toBeNull();
  });
  it("records both exact digests without modifying either input or an unheld quote", async () => {
    const f = await fixture();
    const before = JSON.stringify(f);
    const receipt = await reconcileKrHistoricalSourceVintage(f);
    expect(receipt).toMatchObject({
      archivedHash: f.reviews[0]!.archivedHash,
      incomingHash: f.reviews[0]!.incomingHash,
      policy: "KEEP_FROZEN_EXECUTION_PREFIX_NO_ECONOMIC_EXPOSURE_V1",
      fields: ["close", "high", "low", "open"],
    });
    expect(JSON.stringify(f)).toBe(before);
    expect(f.archived.close).toBe(100);
  });
  it("rejects reversion to the original value after accepting a distinct analysis vintage", async () => {
    const f = await fixture();
    const previousReceipt = (await reconcileKrHistoricalSourceVintage(f))!;
    expect(await reconcileKrHistoricalSourceVintage({ ...f, previousReceipt })).toEqual(
      previousReceipt,
    );
    await expect(
      reconcileKrHistoricalSourceVintage({ ...f, previousReceipt, incoming: f.archived }),
    ).rejects.toThrow("reverted or changed again");
    await expect(
      reconcileKrHistoricalSourceVintage({
        ...f,
        previousReceipt,
        incoming: { ...f.incoming, close: 501 },
      }),
    ).rejects.toThrow("reverted or changed again");
  });
  it.each(["OPEN", "CLOSED"])(
    "rejects a prior %s trade, not just a currently held position",
    async (status) => {
      const f = await fixture();
      f.previousResult.trades.push({
        symbol: "TEST",
        signalDate: "2026-10-12",
        entryDate: "2026-10-13",
        status,
      } as never);
      await expect(reconcileKrHistoricalSourceVintage(f)).rejects.toThrow("economic exposure");
    },
  );
  it.each(["pending", "confirmed", "rejected"])(
    "rejects a prior %s candidate or intent",
    async (entryState) => {
      const f = await fixture();
      f.previousResult.candidates.push({
        symbol: "TEST",
        signalDate: "2026-10-13",
        entryState,
      } as never);
      await expect(reconcileKrHistoricalSourceVintage(f)).rejects.toThrow("economic exposure");
    },
  );
  it("does not block subsequent positions first signaled entirely in the new vintage", async () => {
    const f = await fixture();
    f.publicationDate = "2026-10-16";
    f.previousResult.trades.push({
      symbol: "TEST",
      signalDate: "2026-10-14",
      entryDate: "2026-10-15",
    } as never);
    f.previousResult.candidates.push({
      symbol: "TEST",
      signalDate: "2026-10-14",
      originDate: "2026-10-14",
    } as never);
    expect(await reconcileKrHistoricalSourceVintage(f)).not.toBeNull();
    f.previousResult.candidates[0]!.originDate = "2026-10-13";
    await expect(reconcileKrHistoricalSourceVintage(f)).rejects.toThrow("economic exposure");
  });
  it("fails closed for malformed exposure dates", async () => {
    const f = await fixture();
    f.previousResult.trades.push({
      symbol: "TEST",
      signalDate: "not-a-date",
      entryDate: "2026-10-15",
    } as never);
    await expect(reconcileKrHistoricalSourceVintage(f)).rejects.toThrow("economic exposure");
  });
  it("rejects unreviewed symbols, values, auxiliary fields and ambiguous reviews", async () => {
    const f = await fixture();
    for (const changed of [
      { ...f, symbol: "OTHER" },
      { ...f, incoming: { ...f.incoming, close: 501 } },
      { ...f, incoming: { ...f.incoming, marketCap: 1001 } },
      { ...f, archived: { ...f.archived, volume: 1 } },
      { ...f, reviews: [] },
      { ...f, reviews: [...f.reviews, ...f.reviews] },
    ])
      await expect(reconcileKrHistoricalSourceVintage(changed)).rejects.toThrow(
        "unreviewed or ambiguous",
      );
  });
  it("never applies before the reviewed vintage or to current/future observations", async () => {
    const f = await fixture();
    await expect(
      reconcileKrHistoricalSourceVintage({ ...f, publicationDate: "2026-10-13" }),
    ).rejects.toThrow("unreviewed");
    await expect(
      reconcileKrHistoricalSourceVintage({ ...f, publicationDate: "2026-10-12" }),
    ).rejects.toThrow("not a historical");
    await expect(
      reconcileKrHistoricalSourceVintage({
        ...f,
        incoming: { ...f.incoming, tradeDate: "2026-10-13" },
      }),
    ).rejects.toThrow("not a historical");
  });
});
