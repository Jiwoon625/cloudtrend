import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ScreeningSnapshot } from "../src/lib/screeningSnapshot";
import {
  hydrateScreeningRunArchive,
  serializeScreeningRunArchive,
  SCREENING_RUN_ARCHIVE_FORMAT,
  SCREENING_RUN_ARCHIVE_MAX_BYTES,
  type CompressedScreeningRunArchive,
} from "../src/lib/screeningRunArchiveStorage";
import { screeningSnapshotJsonbBytes } from "../src/lib/screeningSnapshotStorage";
import { archiveUsScreeningRun } from "../src/lib/usScreeningRunArchive";
import { createImmutableArchiveFixture } from "./immutable-archive-fixture";
import { largeUsArchiveSnapshot } from "./screening-run-archive-fixture";

let source: ScreeningSnapshot;
let stored: CompressedScreeningRunArchive;
beforeAll(async () => {
  source = largeUsArchiveSnapshot(200);
  stored = (await serializeScreeningRunArchive(source)) as CompressedScreeningRunArchive;
  expect(stored.storageFormat).toBe(SCREENING_RUN_ARCHIVE_FORMAT);
});

function encodedBody(body: Buffer): CompressedScreeningRunArchive {
  return {
    ...stored,
    uncompressedBytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    payload: gzipSync(body).toString("base64"),
  };
}

describe("lossless immutable archive encoding", () => {
  it("round-trips all evidence for 5,347 US symbols at much lower JSONB cost", async () => {
    const snapshot = largeUsArchiveSnapshot();
    const before = JSON.stringify(snapshot);
    const compressed = await serializeScreeningRunArchive(snapshot);
    const rawBytes = screeningSnapshotJsonbBytes(snapshot);
    const storedBytes = screeningSnapshotJsonbBytes(compressed);
    expect(rawBytes).toBeGreaterThan(6_000_000);
    expect(storedBytes).toBeLessThan(rawBytes / 4);
    expect(storedBytes).toBeLessThan(2_000_000);
    expect(compressed).toMatchObject({
      storageFormat: SCREENING_RUN_ARCHIVE_FORMAT,
      runId: snapshot.runId,
      asOfDate: snapshot.asOfDate,
      market: snapshot.market,
      strategyVersion: snapshot.strategyVersion,
      savedAt: snapshot.savedAt,
    });
    expect(await hydrateScreeningRunArchive(JSON.parse(JSON.stringify(compressed)))).toEqual(
      snapshot,
    );
    expect(JSON.stringify(snapshot)).toBe(before);
    console.info(
      `Archive fixture: ${snapshot.entries.length} entries, ${rawBytes} raw JSONB bytes -> ${storedBytes} stored bytes`,
    );
  });

  it("retains legacy raw archives and small writes without inventing missing evidence", async () => {
    const legacy = { ...largeUsArchiveSnapshot(1), futureEvidence: { zero: 0, absent: null } };
    expect(await hydrateScreeningRunArchive(legacy)).toBe(legacy);
    expect(await serializeScreeningRunArchive(legacy)).toEqual(legacy);
    expect(await serializeScreeningRunArchive(legacy)).not.toHaveProperty("storageFormat");
  });

  it("preserves exact Unicode, number, null, array, and unknown evidence values", async () => {
    const snapshot = structuredClone(source);
    snapshot.entries[0]!.evidence!["extended"] = {
      text: "한글 😀 café",
      number: 0.1234567890123456,
      tiny: 1e-100,
      values: [null, false, true, 0, "", { missing: null }],
    };
    expect(await hydrateScreeningRunArchive(await serializeScreeningRunArchive(snapshot))).toEqual(
      snapshot,
    );
  });

  it.each([1, 200])(
    "preserves the original JSON normalization boundary for %i entries",
    async (count) => {
      const snapshot = largeUsArchiveSnapshot(count);
      snapshot.entries[0]!.evidence!["optional"] = {
        missing: undefined,
        notFinite: NaN,
        array: [undefined, Infinity, null, 0],
      };
      const expected = JSON.parse(JSON.stringify(snapshot));
      const encoded = await serializeScreeningRunArchive(snapshot);
      expect(await hydrateScreeningRunArchive(encoded)).toEqual(expected);
      const archive = createImmutableArchiveFixture();
      const db = { from: () => archive() } as unknown as SupabaseClient;
      await archiveUsScreeningRun(db, "owner", snapshot);
      // A JSONB roundtrip may also reorder object keys during a duplicate retry.
      await archiveUsScreeningRun(
        db,
        "owner",
        Object.fromEntries(Object.entries(snapshot).reverse()) as unknown as ScreeningSnapshot,
      );
    },
  );

  it("checks the original expansion limit before writing", async () => {
    const oversized = largeUsArchiveSnapshot(1);
    oversized.entries[0]!.evidence!["note"] = "x".repeat(SCREENING_RUN_ARCHIVE_MAX_BYTES);
    await expect(serializeScreeningRunArchive(oversized)).rejects.toThrow("복원 크기 한도");
  });

  it.each([
    { storageFormat: "unknown-archive-v2" },
    { uncompressedBytes: 0 },
    { uncompressedBytes: 1.5 },
    { uncompressedBytes: SCREENING_RUN_ARCHIVE_MAX_BYTES + 1 },
    { uncompressedBytes: "300" },
    { sha256: "invalid" },
    { payload: "invalid=" },
    { payload: "!!!!" },
    { payload: "" },
    { payload: null },
    { runId: "" },
    { market: "XX" },
    { savedAt: "not-a-date" },
  ])("rejects malformed archive metadata: %j", async (change) => {
    await expect(hydrateScreeningRunArchive({ ...stored, ...change })).rejects.toThrow(
      "저장 형식 오류",
    );
  });

  it.each([
    { runId: "different-run" },
    { asOfDate: "2026-10-16" },
    { market: "KR" },
    { strategyVersion: "changed-version" },
    { savedAt: "2026-10-20T00:15:00.000Z" },
  ])("rejects valid but mismatched identity headers: %j", async (change) => {
    await expect(hydrateScreeningRunArchive({ ...stored, ...change })).rejects.toThrow(
      "헤더와 본문 불일치",
    );
  });

  it("rejects corrupt or truncated gzip, forged checksum, and false expansion sizes", async () => {
    const corrupt = Buffer.from(stored.payload, "base64");
    corrupt[0] = 0;
    for (const change of [
      { payload: corrupt.toString("base64") },
      { payload: stored.payload.slice(0, -4) },
      { sha256: "0".repeat(64) },
      { uncompressedBytes: stored.uncompressedBytes + 1 },
      { uncompressedBytes: 64 },
    ])
      await expect(hydrateScreeningRunArchive({ ...stored, ...change })).rejects.toThrow(
        "저장 형식 오류",
      );
  });

  it("rejects valid gzip with invalid UTF-8, JSON, snapshot structure, or unsafe keys", async () => {
    for (const body of [
      Buffer.from([0xff]),
      Buffer.from("not json"),
      Buffer.from("[]"),
      Buffer.from(JSON.stringify({ ...source, entries: null })),
      Buffer.from(JSON.stringify({ ...source, storageFormat: SCREENING_RUN_ARCHIVE_FORMAT })),
      Buffer.from(JSON.stringify(source).replace('"market":"US"', '"__proto__":{},"market":"US"')),
    ])
      await expect(hydrateScreeningRunArchive(encodedBody(body))).rejects.toThrow();
  });

  it("preserves immutable duplicate handling after compressed write and full readback", async () => {
    const archive = createImmutableArchiveFixture();
    const db = { from: () => archive() } as unknown as SupabaseClient;
    await archiveUsScreeningRun(db, "owner", source);
    const read = () => archive().eq("user_id", "owner").eq("run_id", source.runId).single();
    const original = (await read()).data!;
    expect(original["snapshot"]).toHaveProperty("storageFormat", SCREENING_RUN_ARCHIVE_FORMAT);
    await archiveUsScreeningRun(
      db,
      "owner",
      Object.fromEntries(Object.entries(source).reverse()) as unknown as ScreeningSnapshot,
    );
    const changed = structuredClone(source);
    changed.entries[0]!.evidence!["rawOnset"] = !changed.entries[0]!.evidence!["rawOnset"];
    await expect(archiveUsScreeningRun(db, "owner", changed)).rejects.toThrow("재사용");
    expect((await read()).data).toEqual(original);
    expect(await hydrateScreeningRunArchive((await read()).data!["snapshot"])).toEqual(source);
  });

  it("can reuse a large legacy raw archive without rewriting its original evidence", async () => {
    const archive = createImmutableArchiveFixture();
    await archive().upsert(
      { user_id: "owner", run_id: source.runId, snapshot: source },
      { ignoreDuplicates: true },
    );
    const db = { from: () => archive() } as unknown as SupabaseClient;
    await archiveUsScreeningRun(db, "owner", source);
    const existing = await archive().eq("user_id", "owner").eq("run_id", source.runId).single();
    expect(existing.data!["snapshot"]).toEqual(source);
    expect(existing.data!["snapshot"]).not.toHaveProperty("storageFormat");
  });

  it("fits the unchanged PostgreSQL archive CHECK constraints for both markets", async () => {
    const migration = readFileSync(
      new URL(
        "../supabase/migrations/20261009014910_cloudtrend_consistency_restart.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const definition = migration.slice(
      migration.indexOf("create table public.screening_run_archive ("),
      migration.indexOf("alter table public.screening_run_archive enable"),
    );
    const db = new PGlite();
    try {
      await db.exec(
        "create schema auth; create table auth.users(id uuid primary key); insert into auth.users values ('11111111-1111-4111-8111-111111111111');",
      );
      await db.exec(definition);
      for (const market of ["US", "KR"] as const) {
        const snapshot = { ...source, runId: `fixture-${market}`, market };
        const encoded = await serializeScreeningRunArchive(snapshot);
        await db.query(
          "insert into public.screening_run_archive(user_id,run_id,date,market,strategy_version,calculated_at,snapshot) values ($1,$2,$3,$4,$5,$6,$7)",
          [
            "11111111-1111-4111-8111-111111111111",
            snapshot.runId,
            snapshot.asOfDate,
            market,
            snapshot.strategyVersion,
            snapshot.savedAt,
            JSON.stringify(encoded),
          ],
        );
        const result = await db.query<{ snapshot: unknown }>(
          "select snapshot from public.screening_run_archive where run_id=$1",
          [snapshot.runId],
        );
        expect(await hydrateScreeningRunArchive(result.rows[0]!.snapshot)).toEqual(snapshot);
      }
    } finally {
      await db.close();
    }
  });
});
