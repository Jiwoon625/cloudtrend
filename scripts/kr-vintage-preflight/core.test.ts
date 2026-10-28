/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from "vitest";
import {
  deriveCollectorOverlay,
  overlayDataset,
  verifyCapturePlan,
} from "../kr-vintage-preflight-core";
import { createHash } from "node:crypto";
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function fixture() {
  const symbol = "999999",
    date = "2026-10-15";
  const old = {
    tradeDate: date,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 20,
    tradingValue: 200,
    marketCap: 10000,
    foreignNetBuyValue: 30,
    institutionNetBuyValue: -20,
    shortSellingVolumeRate: 0.25,
    lendingBalanceQuantity: 999,
    openObserved: true,
    volumeObserved: true,
  };
  const ds = {
    instruments: [{ symbol }],
    bars: { [symbol]: [old] },
    observedBars: { [symbol]: [old] },
    unaffected: { v: 1 },
  };
  const scope: any = {
    symbol,
    captureThroughDate: "2026-10-20",
    captureManifestHash: "sha256:" + "0".repeat(64),
  };
  const capture = new Map([
    [date, { symbol, date, open: 5, high: 5.5, low: 4.5, close: 5, volume: 40 }],
  ]);
  const fields = {
    ...Object.fromEntries(Object.entries(old).map(([k, v]) => [k, String(v)])),
    foreignNetBuyVolume: "3",
    institutionNetBuyVolume: "-2",
    tradingValueSource: "CLOSE_X_VOLUME_PROXY",
    investorValueSource: "TOSS_NET_VOLUME_X_CLOSE_PROXY",
    investorVolumeSource: "TOSS_KRX_NXT",
    marketCapSource: "KRX_STOCK",
    listedShares: "1000",
  };
  const raw = new Map([
    [
      date,
      {
        fields,
        sourceByField: Object.fromEntries(
          Object.keys(fields).map((k) => [k, "synthetic-source:row-1"]),
        ),
      },
    ],
  ]);
  return { symbol, date, old, ds, scope, capture, fields, raw };
}
describe("pure adjusted overlay", () => {
  it("recomputes only tagged proxies; preserves accounting inputs, quantities, independent observations and original dataset", () => {
    const f = fixture(),
      plan = deriveCollectorOverlay(f.ds, f.capture, f.raw, f.scope),
      next = overlayDataset(f.ds, plan, f.scope),
      bar = next.bars[f.symbol][0];
    expect(bar.tradingValue).toBe(200);
    expect(bar.foreignNetBuyValue).toBe(15);
    expect(bar.institutionNetBuyValue).toBe(-10);
    for (const k of ["shortSellingVolumeRate", "marketCap", "lendingBalanceQuantity"])
      expect(bar[k]).toBe((f.old as any)[k]);
    expect(plan.rows[0].untouchedRawQuantities.foreignNetBuyVolume).toBe("3");
    expect(plan.economicCashEquivalenceClaim).toBe(false);
    expect(f.ds.bars[f.symbol][0].close).toBe(10);
    expect(next.unaffected).toEqual(f.ds.unaffected);
  });
  it.each([
    { foreignNetBuyVolume: "" },
    { investorValueSource: "UNKNOWN" },
    { foreignNetBuyVolume: "4" },
    { tradingValueSource: "UNKNOWN" },
  ])("fails closed on incomplete proxy provenance %j", (edit) => {
    const f = fixture();
    expect(() =>
      deriveCollectorOverlay(
        f.ds,
        f.capture,
        new Map([[f.date, { fields: { ...f.fields, ...edit }, sourceByField: {} }]]),
        f.scope,
      ),
    ).toThrow();
  });
  it("rejects stale tags or operands inherited from a different source row", () => {
    const f = fixture();
    for (const field of [
      "tradingValueSource",
      "close",
      "volume",
      "investorValueSource",
      "foreignNetBuyVolume",
      "investorVolumeSource",
    ]) {
      const raw = structuredClone(f.raw);
      raw.get(f.date)!.sourceByField[field] = "different-source:row-2";
      expect(() => deriveCollectorOverlay(f.ds, f.capture, raw, f.scope)).toThrow();
    }
  });
  it("retains official monetary values rather than manufacturing cash equivalence", () => {
    const f = fixture(),
      plan = deriveCollectorOverlay(
        f.ds,
        f.capture,
        new Map([
          [
            f.date,
            {
              fields: {
                ...f.fields,
                tradingValueSource: "KRX_STOCK",
                investorValueSource: "KRX_STOCK",
              },
              sourceByField: Object.fromEntries(
                Object.keys(f.fields).map((k) => [k, "synthetic-source:row-1"]),
              ),
            },
          ],
        ]),
        f.scope,
      );
    for (const k of ["foreignNetBuyValue", "institutionNetBuyValue", "tradingValue"])
      expect(plan.rows[0].bar[k]).toBe((f.old as any)[k]);
  });
  it("does not permit caller-replaced predecessors, duplicate dates or missing field provenance", () => {
    const f = fixture(),
      plan = deriveCollectorOverlay(f.ds, f.capture, f.raw, f.scope);
    for (const mutate of [
      (p: any) => p.rows.push(p.rows[0]),
      (p: any) => (p.rows[0].oldObservedHash = null),
      (p: any) => (p.rows[0].fieldEvidence = {}),
    ]) {
      const p = structuredClone(plan);
      mutate(p);
      expect(() => overlayDataset(f.ds, p, f.scope)).toThrow();
    }
  });
  it("reconstructs full raw history and rejects unobserved/malformed values, not just normalized tail", () => {
    const symbol = "999999",
      rows: any[] = [],
      candles: any[] = [];
    for (let i = 0; i < 400; i++) {
      const date = new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10);
      rows.push({ symbol, date, open: 10, high: 11, low: 9, close: 10, volume: 20 });
      candles.push({
        timestamp: date + "T00:00:00+09:00",
        openPrice: 10,
        highPrice: 11,
        lowPrice: 9,
        closePrice: 10,
        volume: 20,
      });
    }
    const raw = Buffer.from(JSON.stringify({ result: { candles } })),
      pages = [{ name: "provider-page-001.json", raw }];
    const manifest = {
      status: "CAPTURED_REVIEW_REQUIRED",
      symbol,
      adjusted: true,
      rows: 360,
      firstDate: rows[40].date,
      lastDate: rows.at(-1).date,
      artifacts: {
        "provider-page-001.json": { sha256: sha(raw), bytes: raw.length, responseCandles: 400 },
      },
    };
    const scope: any = { symbol, captureThroughDate: manifest.lastDate };
    expect(
      verifyCapturePlan(
        {},
        null,
        manifest,
        rows.slice(40),
        pages,
        sha(JSON.stringify(manifest)),
        scope,
      ).size,
    ).toBe(400);
    for (const invalid of [false, " ", true]) {
      const changed = structuredClone(candles);
      changed[0].volume = invalid as any;
      const raw = Buffer.from(JSON.stringify({ result: { candles: changed } }));
      const mf = structuredClone(manifest);
      mf.artifacts["provider-page-001.json"] = {
        sha256: sha(raw),
        bytes: raw.length,
        responseCandles: 400,
      };
      expect(() =>
        verifyCapturePlan(
          {},
          null,
          mf,
          rows.slice(40),
          [{ name: "provider-page-001.json", raw }],
          sha(JSON.stringify(mf)),
          scope,
        ),
      ).toThrow();
    }
  });
});
