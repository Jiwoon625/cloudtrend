import { describe, expect, it, vi } from "vitest";
import {
  persistKospiShadow,
  reuseCompletedKospiShadow,
  shadowObjectPath,
  type KospiShadowView,
  type ShadowObjectStore,
} from "../src/lib/kospiShadowStore";
import {
  KOSPI_SHADOW_POLICY,
  type KospiShadowSession,
  type KospiShadowSnapshot,
} from "../src/lib/engine/kospiShadow";
import { equivalentCompletedKospiShadow } from "../src/lib/kospiShadowEquivalence";
import { createShadowRevisionFixture, SHADOW_TEST_UID } from "./fixtures/kospiShadowRevision";
import { openKospiShadowRevisionStore } from "../src/lib/kospiShadowSeries";
import { buildKospiShadowSession } from "../src/lib/engine/kospiShadowDataset";
import { getMockDataset } from "../src/lib/engine/mockProvider";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { readFile } from "node:fs/promises";

const uid = SHADOW_TEST_UID;
const config = { policy: KOSPI_SHADOW_POLICY, fixture: true };
function session(date: string, previous: string, score: number): KospiShadowSession {
  return {
    date,
    previousSessionDate: previous,
    sourceHash: `original-${date}`,
    configHash: "config",
    codeVersion: "original-commit",
    sourceCollectedAt: `${date}T08:00:00Z`,
    confirmedClose: true,
    benchmarkClose: 2500,
    gate: { date, status: "NEUTRAL", issues: [], benchmarkAboveMa60: true },
    rows: ["005930", "100000"].map((symbol) => ({
      symbol,
      name: symbol,
      sector: "TECH",
      date,
      open: 100,
      close: 101,
      volume: 1000,
      score,
      priority: 1,
      rsAccel: 1,
      commonHistory: true,
      onsetEligible: true,
      priceObserved: true,
    })),
  };
}
async function fixture() {
  const data = new Map<string, unknown>();
  const store: ShadowObjectStore = {
    read: async <T>(path: string) => structuredClone(data.get(path) ?? null) as T | null,
    latestSessionDate: async (prefix) =>
      [...data.keys()]
        .filter((key) => key.startsWith(`${prefix}/`))
        .map((key) => key.split("/").at(-1)!.replace(".json", ""))
        .sort()
        .at(-1) ?? null,
    putImmutable: vi.fn(async (path, value) => {
      if (data.has(path)) throw new Error("immutable collision");
      data.set(path, structuredClone(value));
    }),
    putLatest: vi.fn(async (path, value) => {
      data.set(path, structuredClone(value));
    }),
  };
  await persistKospiShadow(store, uid, session("2026-10-22", "2026-10-21", 7), config);
  const current = session("2026-10-23", "2026-10-22", 8);
  const result = await persistKospiShadow(store, uid, current, config);
  vi.mocked(store.putImmutable).mockClear();
  vi.mocked(store.putLatest).mockClear();
  const incoming = {
    ...structuredClone(current),
    sourceHash: "changed-KR-provenance",
    codeVersion: "new-commit",
    sourceCollectedAt: "2026-10-26T00:41:00Z",
  };
  const bytes = () => JSON.stringify([...data]);
  const replace = (date: string, mutate: (snapshot: KospiShadowSnapshot) => void) => {
    const key = shadowObjectPath(uid, `sessions/${date}.json`);
    const saved = data.get(key) as KospiShadowSnapshot;
    mutate(saved);
    if (date === current.date)
      (data.get(shadowObjectPath(uid, "latest.json")) as KospiShadowView).latest =
        structuredClone(saved);
  };
  return { data, store, result, current, incoming, bytes, replace };
}

describe("completed KOSPI materialized-input equivalence", () => {
  it("proves legacy duplicate equivalence without new identity metadata or any write", async () => {
    const f = await fixture(),
      before = f.bytes();
    const result = await persistKospiShadow(f.store, uid, f.incoming, config);
    expect(result).toEqual({ reused: true, view: f.result.view });
    expect(result.view.latest.source).toMatchObject({
      sourceHash: f.current.sourceHash,
      codeVersion: "original-commit",
    });
    expect(f.bytes()).toBe(before);
    expect(f.store.putImmutable).not.toHaveBeenCalled();
    expect(f.store.putLatest).not.toHaveBeenCalled();
  });
  it("preserves the known legacy string research reference on changed-source equivalence", async () => {
    const f = await fixture();
    f.replace("2026-10-23", (s) =>
      Object.assign(s.policy, { researchReference: "synthetic-private-reference" }),
    );
    f.replace("2026-10-22", (s) =>
      Object.assign(s.policy, { researchReference: "synthetic-private-reference" }),
    );
    const before = f.bytes();
    const result = await persistKospiShadow(f.store, uid, f.incoming, config);
    expect(result.reused).toBe(true);
    expect(result.view.latest.policy).toHaveProperty(
      "researchReference",
      "synthetic-private-reference",
    );
    expect(f.bytes()).toBe(before);
    expect(f.store.putImmutable).not.toHaveBeenCalled();
    expect(f.store.putLatest).not.toHaveBeenCalled();
  });
  it.each([
    { researchReference: 42 },
    { researchReference: null },
    { researchReference: { note: "not a string" } },
    { unknownPolicyRule: "cannot-ignore" },
  ])("rejects malformed or unknown policy metadata %j", async (extra) => {
    const f = await fixture();
    f.replace("2026-10-23", (s) => Object.assign(s.policy, extra));
    const before = f.bytes();
    await expect(persistKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow(/immutable/);
    expect(f.bytes()).toBe(before);
  });
  it.each([
    ["open", 102],
    ["close", 102],
    ["volume", null],
    ["score", 8.1],
    ["priority", 2],
    ["rsAccel", -1],
    ["commonHistory", false],
    ["onsetEligible", false],
    ["priceObserved", false],
    ["universeDataPending", true],
    ["name", "renamed"],
    ["sector", "OTHER"],
  ])(
    "rejects materialized KOSPI row %s changes even when final NAV is unchanged",
    async (field, value) => {
      const f = await fixture(),
        before = f.bytes();
      Object.assign(f.incoming.rows[0]!, { [field as string]: value });
      await expect(persistKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow(
        /immutable/,
      );
      expect(f.bytes()).toBe(before);
    },
  );
  it.each([
    [
      "benchmark",
      (s: KospiShadowSession) => {
        s.benchmarkClose++;
      },
    ],
    [
      "calendar",
      (s: KospiShadowSession) => {
        s.previousSessionDate = "2026-10-21";
      },
    ],
    [
      "gate detail",
      (s: KospiShadowSession) => {
        s.gate["benchmarkAboveMa60"] = false;
      },
    ],
    [
      "missing symbol",
      (s: KospiShadowSession) => {
        s.rows.pop();
      },
    ],
    [
      "extra symbol",
      (s: KospiShadowSession) => {
        s.rows.push({ ...s.rows[0]!, symbol: "200000" });
      },
    ],
    [
      "duplicate symbol",
      (s: KospiShadowSession) => {
        s.rows.push({ ...s.rows[0]! });
      },
    ],
    [
      "unknown source metadata",
      (s: KospiShadowSession) => {
        Object.assign(s, { extraEvidence: true });
      },
    ],
    [
      "row order",
      (s: KospiShadowSession) => {
        s.rows.reverse();
      },
    ],
  ] as const)("rejects %s changes without writes", async (_, mutate) => {
    const f = await fixture(),
      before = f.bytes();
    mutate(f.incoming);
    await expect(persistKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow();
    expect(f.bytes()).toBe(before);
  });
  it("does not treat equal row maps as an original input-order proof", async () => {
    const f = await fixture();
    const original = f.result.view.latest;
    const predecessor = await f.store.read<KospiShadowSnapshot>(
      shadowObjectPath(uid, "sessions/2026-10-22.json"),
    );
    expect(Object.keys(original.state.previousRows)).toEqual(["100000", "005930"]);
    f.incoming.rows.reverse();
    expect(Object.fromEntries(f.incoming.rows.map((r) => [r.symbol, r]))).toEqual(
      original.state.previousRows,
    );
    expect(equivalentCompletedKospiShadow(f.incoming, original, predecessor, "2026-10-22")).toBe(
      false,
    );
  });
  it("rejects changes even with identical claimed raw hash or config hash", async () => {
    const f = await fixture();
    f.incoming.sourceHash = f.current.sourceHash;
    f.incoming.rows[0]!.score = 8.2;
    await expect(persistKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow(/immutable/);
    await expect(
      persistKospiShadow(f.store, uid, f.current, { ...config, fixture: false }),
    ).rejects.toThrow(/frozen/);
  });
  it.each([
    [
      "missing row map",
      (s: KospiShadowSnapshot) => {
        delete (s.state as Partial<typeof s.state>).previousRows;
      },
    ],
    [
      "missing required row field",
      (s: KospiShadowSnapshot) => {
        delete (s.state.previousRows["005930"] as Partial<(typeof s.state.previousRows)[string]>)
          .open;
      },
    ],
    [
      "mismatched row key",
      (s: KospiShadowSnapshot) => {
        s.state.previousRows["005930"]!.symbol = "OTHER";
      },
    ],
    [
      "policy content",
      (s: KospiShadowSnapshot) => {
        Object.assign(s.policy, { slots: 29 });
      },
    ],
    [
      "artifact schema",
      (s: KospiShadowSnapshot) => {
        Object.assign(s, { schemaVersion: 2 });
      },
    ],
    [
      "unknown source field",
      (s: KospiShadowSnapshot) => {
        Object.assign(s.source, { evidence: "not carried" });
      },
    ],
    [
      "late metadata",
      (s: KospiShadowSnapshot) => {
        Object.assign(s.source, { lateRecovery: { review: true } });
      },
    ],
    [
      "unknown output field",
      (s: KospiShadowSnapshot) => {
        Object.assign(s, { evidence: "not replayed" });
      },
    ],
    [
      "inconsistent outputs",
      (s: KospiShadowSnapshot) => {
        s.daily.navKrw++;
      },
    ],
  ] as const)("fails closed on original %s", async (_, mutate) => {
    const f = await fixture();
    f.replace("2026-10-23", mutate);
    const before = f.bytes();
    await expect(persistKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow();
    expect(f.bytes()).toBe(before);
  });
  it.each(["missing", "wrong date", "wrong config", "missing provenance"])(
    "fails closed on %s predecessor",
    async (mode) => {
      const f = await fixture();
      if (mode === "missing") f.data.delete(shadowObjectPath(uid, "sessions/2026-10-22.json"));
      else
        f.replace("2026-10-22", (s) => {
          if (mode === "wrong date") s.source.date = "2026-10-21";
          if (mode === "wrong config") s.source.configHash = "other";
          if (mode === "missing provenance")
            delete (s.source as Partial<typeof s.source>).sourceHash;
        });
      const before = f.bytes();
      await expect(persistKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow(
        /immutable/,
      );
      expect(f.bytes()).toBe(before);
    },
  );
  it("does not repair a failed projection with changed provenance", async () => {
    const f = await fixture();
    f.data.set(shadowObjectPath(uid, "latest.json"), {
      ...f.result.view,
      latest: f.data.get(shadowObjectPath(uid, "sessions/2026-10-22.json")),
    });
    const before = f.bytes();
    await expect(persistKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow(/immutable/);
    expect(f.bytes()).toBe(before);
  });
  it("works inside the validated correction revision without altering its original or revised bytes", async () => {
    const f = await createShadowRevisionFixture(),
      before = f.bytes();
    const adapter = await openKospiShadowRevisionStore(f.store, uid);
    const result = await persistKospiShadow(
      adapter,
      uid,
      { ...f.corrected, sourceHash: `sha256:${"f".repeat(64)}`, codeVersion: "new" },
      f.correctedView.registry.config,
    );
    expect(result.reused).toBe(true);
    expect(f.bytes()).toBe(before);
  });
});

describe("timing-independent completed-only path", () => {
  it("reuses a proven completed date after open without writes", async () => {
    const f = await fixture(),
      before = f.bytes();
    expect((await reuseCompletedKospiShadow(f.store, uid, f.incoming, config))?.reused).toBe(true);
    expect(f.bytes()).toBe(before);
    expect(f.store.putLatest).not.toHaveBeenCalled();
  });
  it("fails changed completed input but returns null for an uncompleted date", async () => {
    const f = await fixture();
    f.incoming.benchmarkClose++;
    await expect(reuseCompletedKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow(
      /immutable/,
    );
    expect(
      await reuseCompletedKospiShadow(f.store, uid, session("2026-10-26", "2026-10-23", 8), config),
    ).toBeNull();
    expect(f.store.putImmutable).not.toHaveBeenCalled();
    expect(f.store.putLatest).not.toHaveBeenCalled();
  });
  it("does not conceal missing authoritative snapshot or absorb late-recovery evidence", async () => {
    const f = await fixture();
    f.replace("2026-10-23", (s) =>
      Object.assign(s.source, { lateRecovery: { version: "original" } }),
    );
    expect(await reuseCompletedKospiShadow(f.store, uid, f.incoming, config)).toBeNull();
    f.replace("2026-10-23", (s) => {
      delete (s.source as unknown as Record<string, unknown>)["lateRecovery"];
    });
    f.data.delete(shadowObjectPath(uid, "sessions/2026-10-23.json"));
    await expect(reuseCompletedKospiShadow(f.store, uid, f.incoming, config)).rejects.toThrow(
      /authoritative/,
    );
  });
  it("runner proves completed-only reuse before strict late recovery, never writable advance", async () => {
    const code = await readFile("scripts/run-kospi-shadow.ts", "utf8");
    const late = code.slice(
      code.indexOf("if (!dryRun && !initializeCorrection && !official)"),
      code.indexOf("  if (dryRun) {"),
    );
    expect(late.indexOf("reuseCompletedKospiShadow(")).toBeLessThan(
      late.indexOf("runLateRecovery(client, store"),
    );
    expect(late).not.toContain("publishKospiShadowTarget(");
    expect(late).toContain('"VERIFIED_EQUIVALENT_INPUT"');
  });
});

describe("full-market dependency closure at the materialized boundary", () => {
  function liveDataset() {
    const raw = structuredClone(getMockDataset());
    const shift = Date.parse("2026-10-23T00:00:00Z") - Date.parse(`${raw.asOfDate}T00:00:00Z`);
    const moveDates = (value: unknown): unknown => {
      if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value))
        return new Date(Date.parse(`${value}T00:00:00Z`) + shift).toISOString().slice(0, 10);
      if (Array.isArray(value)) return value.map(moveDates);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, moveDates(v)]));
      return value;
    };
    return { ...(moveDates(raw) as typeof raw), isLive: true };
  }
  const provenance = {
    sourceHash: "original-full-KR",
    configHash: "config",
    codeVersion: "before",
    sourceCollectedAt: "2026-10-26T00:00:00Z",
    now: "2026-10-26T00:50:00Z",
  };
  it("unused ETF underlying-index correction changes raw provenance but not KOSPI inputs", async () => {
    const raw = liveDataset();
    const etf = raw.instruments.find((i) => i.instrumentType === "ETF")!;
    raw.bars[etf.symbol]!.at(-1)!.etfUnderlyingIndexClose = 1234.5;
    const first = buildKospiShadowSession(raw, DEFAULT_SCORING_CONFIG, provenance);
    const changed = structuredClone(raw);
    changed.bars[etf.symbol]!.at(-1)!.etfUnderlyingIndexClose = 1250.75;
    const second = buildKospiShadowSession(changed, DEFAULT_SCORING_CONFIG, {
      ...provenance,
      sourceHash: "changed-full-KR",
      codeVersion: "after",
    });
    expect(second.rows).toEqual(first.rows);
    expect(second.gate).toEqual(first.gate);
    const { stepKospiShadow } = await import("../src/lib/engine/kospiShadow");
    const frozen = stepKospiShadow(first, null);
    expect(equivalentCompletedKospiShadow(second, frozen, null, first.date)).toBe(true);
  });
  it("does not discard KOSDAQ inputs that change shared KOSPI sector/priority calculations", async () => {
    const raw = liveDataset();
    const first = buildKospiShadowSession(raw, DEFAULT_SCORING_CONFIG, provenance);
    const changed = structuredClone(raw);
    for (const inst of changed.instruments.filter(
      (i) => i.market === "KOSDAQ" && i.instrumentType === "STOCK",
    ))
      for (const [i, bar] of changed.bars[inst.symbol]!.slice(-60).entries()) {
        const scale = 1 + i * 10;
        bar.open *= scale;
        bar.close *= scale;
        bar.high *= scale;
        bar.low *= scale;
        bar.tradingValue *= scale;
      }
    // KOSPI's own raw bars are unchanged; the full-market calculation sees the context.
    for (const inst of raw.instruments.filter((i) => i.market === "KOSPI"))
      expect(changed.bars[inst.symbol]).toEqual(raw.bars[inst.symbol]);
    const second = buildKospiShadowSession(changed, DEFAULT_SCORING_CONFIG, {
      ...provenance,
      sourceHash: "changed-context",
    });
    expect(second.rows).not.toEqual(first.rows);
    const { stepKospiShadow } = await import("../src/lib/engine/kospiShadow");
    expect(
      equivalentCompletedKospiShadow(second, stepKospiShadow(first, null), null, first.date),
    ).toBe(false);
  });
});
