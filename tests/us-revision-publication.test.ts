import { describe, it, expect } from "vitest";
import {
  publishSameSessionRevision,
  revisionHash,
  revisionPaths,
  type RevisionSource,
  type RevisionIO,
  type RevisionOriginal,
} from "../scripts/us-same-session-revision";
import { US_PROSPECTIVE_RULE_VERSION } from "../src/lib/engine/usProspective";
const uid = "bdfc8818-33a7-4030-9dbd-ecad39f223ac";
const header =
  "date,symbol,open,high,low,close,volume,dollar_volume,ret120,ret252,beta60_spy,ichimoku_tk_gap,relvol1_20,adv20_usd,amihud20,active20,toss_tradable,is_common_share";
const csv = (price: number) =>
  `${header}\n2026-10-16,SPY,100,${Math.max(100, price)},99,${price},10000,1000000,0.1,0.2,1,1,1,100000000,0.001,true,true,true\n`;
function fixture() {
  const originalCsv = csv(100),
    revisedCsv = csv(101);
  const source: RevisionSource = {
    version: "us-same-session-source-v1",
    userId: uid,
    date: "2026-10-16",
    originalDataHash: revisionHash(originalCsv),
    revisionDataHash: revisionHash(revisedCsv),
    collectedAt: "2026-10-19T00:00:00Z",
    rowCount: 1,
    symbolCount: 1,
    metadata: {
      confirmedRegularClose: true,
      failedSymbols: 0,
      sourceCoverageComplete: true,
      previousSessionDate: "2026-10-15",
    },
  };
  const original: RevisionOriginal = {
    date: source.date,
    dataHash: source.originalDataHash,
    ruleVersion: US_PROSPECTIVE_RULE_VERSION,
    csv: originalCsv,
    previousState: { lastDate: "2026-10-15", coreRanks: {} },
    result: {
      generatedAt: "2026-10-17T00:00:00Z",
      dataHash: source.originalDataHash,
      source: {
        provider: "toss",
        collectedAt: "2026-10-17T00:00:00Z",
        schemaVersion: "v1",
        metadata: {},
      },
      analysis: {
        date: source.date,
        ruleVersion: US_PROSPECTIVE_RULE_VERSION,
        summary: {},
        rows: [],
      },
    },
  };
  const objects = new Map<string, string>();
  const writes: string[] = [];
  const paths = revisionPaths(source);
  const saveSource = () => {
    objects.set(paths.source, JSON.stringify(source));
    objects.set(paths.csv, revisedCsv);
  };
  saveSource();
  const io: RevisionIO = {
    read: async (p) => objects.get(p) ?? null,
    original: async () => original,
    immutable: async (p, b) => {
      if (objects.has(p) && objects.get(p) !== b) throw Error("conflict");
      objects.set(p, b);
      writes.push(p);
    },
    pointer: async (p, b) => {
      objects.set(p, b);
      writes.push(p);
    },
  };
  const run = () =>
    publishSameSessionRevision(io, uid, paths.source, revisionHash(objects.get(paths.source)!));
  return { source, original, objects, writes, paths, io, run, saveSource };
}
describe("reference-only revision publication", () => {
  it("publishes only immutable bundle and atomic pointer, leaving original unchanged", async () => {
    const f = fixture(),
      before = JSON.stringify(f.original);
    expect((await f.run()).status).toBe("published");
    expect(f.writes).toEqual([f.paths.bundle, f.paths.pointer]);
    expect(JSON.stringify(f.original)).toBe(before);
    const b = JSON.parse(f.objects.get(f.paths.bundle)!);
    expect(b.view.analysis.state).toBeUndefined();
    expect(b.view.analysis.rows[0].close).toBe(101);
    expect(b.screening).toEqual(b.view);
    expect(b.summary.analysis.rowCount).toBe(1);
  });
  it("same exact revision is idempotent with no second write", async () => {
    const f = fixture();
    await f.run();
    f.writes.length = 0;
    expect((await f.run()).status).toBe("already_published");
    expect(f.writes).toEqual([]);
  });
  it("failed bundle leaves previous pointer untouched", async () => {
    const f = fixture();
    f.io.immutable = async () => {
      throw Error("storage outage");
    };
    await expect(f.run()).rejects.toThrow("storage outage");
    expect(f.objects.has(f.paths.pointer)).toBe(false);
  });
  it("failed readback never publishes pointer", async () => {
    const f = fixture();
    f.io.immutable = async () => {};
    await expect(f.run()).rejects.toThrow("readback");
    expect(f.writes).toEqual([]);
  });
  it("rejects wrong owner before any data write", async () => {
    const f = fixture();
    f.source.userId = "00000000-0000-0000-0000-000000000000";
    f.saveSource();
    await expect(f.run()).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });
  it("rejects tampered CSV", async () => {
    const f = fixture();
    f.objects.set(f.paths.csv, csv(999));
    await expect(f.run()).rejects.toThrow("hash mismatch");
    expect(f.writes).toEqual([]);
  });
  it("rejects original hash mismatch", async () => {
    const f = fixture();
    f.original.dataHash = revisionHash("other");
    await expect(f.run()).rejects.toThrow("immutable original");
  });
  it("rejects older session after canonical next day", async () => {
    const f = fixture();
    f.original.date = "2026-10-19";
    await expect(f.run()).rejects.toThrow("immutable original");
    expect(f.writes).toEqual([]);
  });
  it("rechecks canonical before pointer commit", async () => {
    const f = fixture();
    let n = 0;
    f.io.original = async () => {
      n++;
      return n === 1 ? f.original : { ...f.original, date: "2026-10-19" };
    };
    await expect(f.run()).rejects.toThrow("immutable original");
    expect(f.objects.has(f.paths.pointer)).toBe(false);
  });
  it("never uses same-session revision as engine predecessor", async () => {
    const f = fixture();
    f.original.previousState.lastDate = "2026-10-16";
    await expect(f.run()).rejects.toThrow("predecessor");
  });
  it("refuses incomplete source QA", async () => {
    const f = fixture();
    f.source.metadata["failedSymbols"] = 1;
    f.saveSource();
    await expect(f.run()).rejects.toThrow("source");
  });
  it("rejects stale revision retry instead of rolling pointer backward", async () => {
    const f = fixture();
    f.objects.set(
      f.paths.pointer,
      JSON.stringify({
        version: "us-same-session-pointer-v1",
        userId: uid,
        date: f.source.date,
        collectedAt: "2026-10-20T00:00:00Z",
        revisionDataHash: revisionHash("new"),
      }),
    );
    await expect(f.run()).rejects.toThrow("Stale revision");
    expect(f.writes).toEqual([]);
  });
  it("rejects concurrent pointer change before commit", async () => {
    const f = fixture();
    const original = f.io.immutable;
    f.io.immutable = async (p, b) => {
      await original(p, b);
      f.objects.set(f.paths.pointer, "changed");
    };
    await expect(f.run()).rejects.toThrow("concurrently");
    expect(f.objects.get(f.paths.pointer)).toBe("changed");
  });
  it("rejects NaN even when the engine parser would coerce to null", async () => {
    const f = fixture();
    const bad = csv(101).replace(",0.1,", ",NaN,");
    f.source.revisionDataHash = revisionHash(bad);
    const p = revisionPaths(f.source);
    f.objects.set(p.csv, bad);
    f.objects.set(p.source, JSON.stringify(f.source));
    await expect(
      publishSameSessionRevision(f.io, uid, p.source, revisionHash(f.objects.get(p.source)!)),
    ).rejects.toThrow("Invalid revision number");
  });
  it("rejects invalid OHLC ordering", async () => {
    const f = fixture();
    const bad = csv(101).replace(",100,101,99,101,", ",100,90,99,101,");
    f.source.revisionDataHash = revisionHash(bad);
    const p = revisionPaths(f.source);
    f.objects.set(p.csv, bad);
    f.objects.set(p.source, JSON.stringify(f.source));
    await expect(
      publishSameSessionRevision(f.io, uid, p.source, revisionHash(f.objects.get(p.source)!)),
    ).rejects.toThrow("OHLCV");
  });
  it("rejects a non-price identity change accompanying price revision", async () => {
    const f = fixture();
    f.original.csv = f.original.csv
      .replace("date,symbol,", "date,symbol,name,")
      .replace("2026-10-16,SPY,", "2026-10-16,SPY,Original,");
    f.original.dataHash = revisionHash(f.original.csv);
    f.original.result.dataHash = f.original.dataHash;
    f.source.originalDataHash = f.original.dataHash;
    const bad = csv(101)
      .replace("date,symbol,", "date,symbol,name,")
      .replace("2026-10-16,SPY,", "2026-10-16,SPY,Changed,");
    f.source.revisionDataHash = revisionHash(bad);
    const p = revisionPaths(f.source);
    f.objects.set(p.csv, bad);
    f.objects.set(p.source, JSON.stringify(f.source));
    await expect(
      publishSameSessionRevision(f.io, uid, p.source, revisionHash(f.objects.get(p.source)!)),
    ).rejects.toThrow("identity/roster");
  });
  it("refuses collection timestamp equal to original", async () => {
    const f = fixture();
    f.source.collectedAt = f.original.result.source.collectedAt;
    f.saveSource();
    await expect(f.run()).rejects.toThrow("predates");
  });
});
