import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { largeScreeningSnapshot } from "../../tests/screening-snapshot-storage-fixture";
import { hashSeriesValue } from "./ledger/modelSeries";
import { persistScreeningSnapshot, type ScreeningSnapshot } from "./screeningSnapshot";
import {
  hydrateScreeningSnapshot,
  serializeScreeningSnapshot,
  screeningSnapshotJsonbBytes,
  SCREENING_HISTORY_MAX_BYTES,
  SCREENING_SNAPSHOT_STORAGE_FORMAT,
  type CompactScreeningSnapshot,
} from "./screeningSnapshotStorage";

function compactFixture() {
  const domain = largeScreeningSnapshot();
  const stored = serializeScreeningSnapshot(domain);
  expect(stored).toHaveProperty("storageFormat", SCREENING_SNAPSHOT_STORAGE_FORMAT);
  return { domain, stored: stored as CompactScreeningSnapshot };
}
function persistence(existing: unknown = null, failure: { message: string } | null = null) {
  const upsert = vi.fn(async () => ({ error: failure }));
  const query = {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => ({ data: existing ? { snapshot: existing } : null, error: null }),
    upsert,
  };
  const client = { from: () => query } as unknown as SupabaseClient;
  return { client, upsert };
}

describe("lossless screening-history storage", () => {
  it("fits 1,785 rows under the existing JSONB limit without removing evidence or changing provenance", async () => {
    const { domain, stored } = compactFixture();
    expect(screeningSnapshotJsonbBytes(domain)).toBeGreaterThan(SCREENING_HISTORY_MAX_BYTES);
    expect(screeningSnapshotJsonbBytes(stored)).toBeLessThan(SCREENING_HISTORY_MAX_BYTES);
    expect(stored).toMatchObject({
      date: domain.date,
      asOfDate: domain.asOfDate,
      totalCount: 1785,
    });
    const hydrated = hydrateScreeningSnapshot(JSON.parse(JSON.stringify(stored)));
    expect(hydrated).toEqual(domain);
    expect(JSON.stringify(hydrated)).toBe(JSON.stringify(domain));
    expect(await hashSeriesValue(hydrated)).toBe(await hashSeriesValue(domain));
    expect(hydrated.entries).toHaveLength(1785);
    expect(hydrated.entries.filter((row) => row.instrumentType === "ETF")).toHaveLength(1171);
    expect(Object.hasOwn(hydrated.entries[0]!, "exitSignal")).toBe(true);
    expect(hydrated.entries[0]!.exitSignal).toBeNull();
    expect(Object.hasOwn(hydrated.entries[1]!, "exitSignal")).toBe(false);
    expect(hydrated.entries[614]!.pendingRules).toEqual(domain.entries[614]!.pendingRules);
    expect(hydrated.topStocks).toEqual(domain.topStocks);
    expect(hydrated.topEtfs).toEqual(domain.topEtfs);
  });

  it("leaves small and legacy stored snapshots unchanged", () => {
    const legacy = {
      asOfDate: "2026-01-01",
      entries: [{ symbol: "OLD", hardFilterPassed: false }],
    } as unknown as ScreeningSnapshot;
    expect(serializeScreeningSnapshot(legacy)).toBe(legacy);
    expect(hydrateScreeningSnapshot(legacy)).toBe(legacy);
    expect(Object.hasOwn(hydrateScreeningSnapshot(legacy).entries[0]!, "hardFilterStatus")).toBe(
      false,
    );
  });

  it("rejects sparse arrays rather than undercounting their persisted nulls", () => {
    const snapshot = { asOfDate: "2026-10-07", entries: new Array(2) } as ScreeningSnapshot;
    expect(() => serializeScreeningSnapshot(snapshot)).toThrow(/비어 있는 배열 항목/);
  });

  it("never stores an envelope larger than the decoder's restored-size budget", () => {
    const key = "longProperty".repeat(800);
    const entries = Array.from({ length: 4000 }, () => ({ [key]: 0 }));
    const snapshot = { ...largeScreeningSnapshot(), entries } as unknown as ScreeningSnapshot;
    expect(() => serializeScreeningSnapshot(snapshot)).toThrow(/복원 크기 한도 초과/);
    const encoded = {
      storageFormat: SCREENING_SNAPSHOT_STORAGE_FORMAT,
      date: snapshot.date,
      asOfDate: snapshot.asOfDate,
      savedAt: snapshot.savedAt,
      totalCount: 4000,
      schemas: [["date", "asOfDate", "savedAt", "totalCount", "entries"], [key]],
      value: [
        0,
        snapshot.date,
        snapshot.asOfDate,
        snapshot.savedAt,
        4000,
        [-1, ...entries.map(() => [1, 0])],
      ],
    };
    expect(screeningSnapshotJsonbBytes(encoded)).toBeLessThan(SCREENING_HISTORY_MAX_BYTES);
    expect(() => hydrateScreeningSnapshot(encoded)).toThrow(/복원 크기 한도 초과/);
  });

  it("counts PostgreSQL separators, UTF-8, and exponent expansion conservatively", () => {
    // Independently checked with PostgreSQL octet_length(...::jsonb::text).
    expect(screeningSnapshotJsonbBytes({ 한글: [1e-7, 1e21, 0, "emoji😀"], pending: true })).toBe(
      80,
    );
    expect(screeningSnapshotJsonbBytes({ korean: "시가총액😀", values: [1, null, true] })).toBe(
      new TextEncoder().encode('{"korean": "시가총액😀", "values": [1, null, true]}').byteLength,
    );
    expect(screeningSnapshotJsonbBytes({ n: 1e21 })).toBe(29);
    expect(screeningSnapshotJsonbBytes({ n: 1e-7 })).toBe(16);
    expect(screeningSnapshotJsonbBytes({ n: -1.25e-7 })).toBe(19);
    expect(screeningSnapshotJsonbBytes({ n: Number.MAX_VALUE })).toBe(316);
  });

  it.each([NaN, Infinity, -Infinity])(
    "rejects non-finite %s instead of silently replacing it with null",
    (value) => {
      expect(() =>
        serializeScreeningSnapshot({ entries: [], score: value } as unknown as ScreeningSnapshot),
      ).toThrow(/유한하지 않은 숫자/);
    },
  );

  it("rejects malformed references, duplicate keys, unsafe keys, and mismatched headers", () => {
    const { stored } = compactFixture();
    const broken = [
      { ...stored, storageFormat: "screening-snapshot-unknown" },
      { ...stored, value: [stored.schemas.length] },
      { ...stored, value: [-2] },
      { ...stored, value: [0] },
      { ...stored, schemas: [["duplicate", "duplicate"]] },
      { ...stored, schemas: [["__proto__"]] },
      { ...stored, schemas: [["constructor"]] },
      { ...stored, value: { unencoded: true } },
      { ...stored, totalCount: 1 },
    ];
    for (const value of broken)
      expect(() => hydrateScreeningSnapshot(value)).toThrow(/저장 형식 오류/);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("fails clearly before upload if genuinely unique values cannot fit losslessly", async () => {
    const snapshot = largeScreeningSnapshot();
    snapshot.entries[0]!.status = "가".repeat(SCREENING_HISTORY_MAX_BYTES);
    const db = persistence();
    await expect(persistScreeningSnapshot(db.client, "owner", snapshot)).rejects.toThrow(
      /압축 후에도 1 MiB 저장 한도를 초과/,
    );
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("writes compact storage but returns the original domain snapshot", async () => {
    const { domain, stored } = compactFixture();
    const db = persistence();
    expect(await persistScreeningSnapshot(db.client, "owner", domain)).toBe(domain);
    expect(db.upsert).toHaveBeenCalledExactlyOnceWith(
      { user_id: "owner", date: domain.asOfDate, snapshot: stored },
      { onConflict: "user_id,date" },
    );
  });

  it("hydrates a pre-adoption stored record and never rewrites it", async () => {
    const domain = largeScreeningSnapshot();
    domain.date = domain.asOfDate = "2026-01-01";
    const stored = serializeScreeningSnapshot(domain);
    const db = persistence(stored);
    const incoming = { ...domain, savedAt: "2026-10-08T00:00:00Z", entries: [] };
    expect(await persistScreeningSnapshot(db.client, "owner", incoming)).toEqual(domain);
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("turns database error objects into readable errors", async () => {
    const db = persistence(null, { message: "synthetic storage failure" });
    const snapshot = { asOfDate: "2026-10-07", entries: [] } as unknown as ScreeningSnapshot;
    await expect(persistScreeningSnapshot(db.client, "owner", snapshot)).rejects.toThrow(
      "스크리닝 이력 저장 실패: synthetic storage failure",
    );
  });
});
