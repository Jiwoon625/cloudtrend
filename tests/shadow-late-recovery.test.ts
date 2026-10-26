import { describe, expect, it } from "vitest";
import { persistKospiShadow } from "../src/lib/kospiShadowStore";
import { openKospiShadowRevisionStore } from "../src/lib/kospiShadowSeries";
import {
  assertHistoricalManifest,
  historicalRecords,
  memoryOverlay,
  planLateSessions,
  recoveryCutoff,
  verifyHistoricalBytes,
} from "../scripts/kospi-shadow-late-recovery";
import { sha256, stableJson } from "../scripts/analysis-run-store";
import type { SourceRecord } from "../scripts/source-registry-store";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { createShadowRevisionFixture, SHADOW_TEST_UID } from "./fixtures/kospiShadowRevision";
const H = `sha256:${"a".repeat(64)}`;
const source = (id = "a", savedAt = "2026-10-19T23:50:00Z") =>
  ({
    id,
    user_id: SHADOW_TEST_UID,
    source_type: "screening",
    status: "active",
    storage_bucket: "cloudtrend-data",
    storage_path: `${SHADOW_TEST_UID}/source/screening/${id}/source.csv`,
    activated_at: savedAt,
    created_at: savedAt,
    updated_at: savedAt,
    file_hash: H,
    data_hash: H,
    schema_hash: H,
    max_date: "2026-10-19",
    min_date: "2026-09-01",
  }) as SourceRecord;
function evidence(records = [source()]) {
  const version = `sha256:${sha256(
    records
      .map((r) => r.data_hash)
      .sort()
      .join("\n"),
  )}`;
  const bundle = {
    run: {
      id: "test",
      kind: "SCREENING",
      createdAt: "2026-10-19T23:55:00Z",
      codeVersion: "test",
      dataVersion: version,
    },
    data: {
      asOfDate: "2026-10-19",
      sources: records.map((r) => ({
        id: r.id,
        objectPath: r.storage_path,
        savedAt: r.activated_at!,
        fileHash: r.file_hash,
        dataHash: r.data_hash,
        schemaHash: r.schema_hash,
      })),
    },
    config: DEFAULT_SCORING_CONFIG,
  };
  return { bundle, version, records };
}
describe("historical pre-open proof", () => {
  it("keeps actual cutoff separate from computation and selects next regular session", () => {
    expect(recoveryCutoff("2026-10-16").next).toBe("2026-10-19");
    const { bundle, version, records } = evidence();
    const p = assertHistoricalManifest(bundle, records, "2026-10-19", version);
    expect(Date.parse(p.cutoff)).toBe(Date.parse("2026-10-20T09:00:00+09:00"));
    expect(p.sourceCollectedAt).toBe("2026-10-19T23:50:00Z");
  });
  it("excludes later registrations without admitting their data", () => {
    const { bundle, version, records } = evidence();
    records.push(source("later", "2026-10-20T00:00:01Z"));
    expect(assertHistoricalManifest(bundle, records, "2026-10-19", version).selected).toHaveLength(
      1,
    );
    const late = evidence(records);
    expect(() =>
      assertHistoricalManifest(late.bundle, records, "2026-10-19", late.version),
    ).toThrow("Incomplete");
  });
  it("fails closed when historical membership or source was subsequently changed", () => {
    const { bundle, version, records } = evidence();
    records[0]!.updated_at = "2026-10-20T01:00:00Z";
    expect(() => assertHistoricalManifest(bundle, records, "2026-10-19", version)).toThrow(
      "membership changed",
    );
  });
  it("requires full ordered manifest and the run aggregate digest", () => {
    const { bundle, version, records } = evidence([source("a"), source("b")]);
    bundle.data.sources.reverse();
    expect(() => assertHistoricalManifest(bundle, records, "2026-10-19", version)).toThrow("order");
    bundle.data.sources.reverse();
    bundle.data.sources.pop();
    expect(() => assertHistoricalManifest(bundle, records, "2026-10-19", version)).toThrow(
      "Incomplete",
    );
    const x = evidence();
    expect(() => assertHistoricalManifest(x.bundle, x.records, "2026-10-19", H)).toThrow(
      "version mismatch",
    );
  });
  it("rejects evening-only data, after-open sources and substituted file hashes", () => {
    for (const at of ["2026-10-19T13:00:00Z", "2026-10-20T00:00:00Z"]) {
      const e = evidence([source("x", at)]);
      expect(() =>
        assertHistoricalManifest(e.bundle, e.records, "2026-10-19", e.version),
      ).toThrow();
    }
    const e = evidence();
    e.bundle.data.sources[0]!.fileHash = `sha256:${"b".repeat(64)}`;
    expect(() => assertHistoricalManifest(e.bundle, e.records, "2026-10-19", e.version)).toThrow(
      "hash changed",
    );
  });
  it("verifies raw bytes before parsing", async () => {
    await expect(
      verifyHistoricalBytes(source(), new TextEncoder().encode("not original")),
    ).rejects.toThrow("byte hash mismatch");
  });
  it("does not let deleted pre-cutoff sources silently enter the set", () => {
    const r = source();
    r.status = "deleted";
    expect(historicalRecords([r], "2026-10-20T00:00:00Z")).toHaveLength(0);
  });
});
describe("unchanged authoritative journal gates in dry-run", () => {
  it("computes a sequential append without writing base store and rejects missing predecessor", async () => {
    const f = await createShadowRevisionFixture();
    const before = stableJson([...f.data]);
    const session = structuredClone(f.corrected);
    session.date = "2026-10-15";
    session.previousSessionDate = "2026-10-14";
    session.gate.date = session.date;
    session.rows.forEach((r) => (r.date = session.date));
    Object.assign(session, {
      lateRecovery: {
        retrospective: true,
        computedAt: "2026-10-21T01:00:00Z",
        dataCutoffAt: "2026-10-16T00:00:00Z",
      },
    });
    const plan = await planLateSessions(f.store, SHADOW_TEST_UID, [
      { session, config: f.correctedView.registry.config },
    ]);
    expect(plan.predecessorDate).toBe("2026-10-14");
    expect(plan.summaries[0]!.date).toBe("2026-10-15");
    expect(stableJson([...f.data])).toBe(before);
    const missing = structuredClone(session);
    missing.date = "2026-10-19";
    missing.previousSessionDate = "2026-10-16";
    missing.gate.date = missing.date;
    missing.rows.forEach((r) => (r.date = missing.date));
    await expect(
      planLateSessions(f.store, SHADOW_TEST_UID, [
        { session: missing, config: f.correctedView.registry.config },
      ]),
    ).rejects.toThrow("exact next session");
  });
  it("binds economic inputs rather than actual clock or request commit and requires fresh review after append", async () => {
    const f = await createShadowRevisionFixture();
    const session = structuredClone(f.corrected);
    session.date = "2026-10-15";
    session.previousSessionDate = "2026-10-14";
    session.gate.date = session.date;
    session.rows.forEach((r) => (r.date = session.date));
    Object.assign(session, {
      lateRecovery: {
        version: "kospi-preopen-late-v1",
        retrospective: true,
        computedAt: "2026-10-21T01:00:00Z",
        dataCutoffAt: "2026-10-16T00:00:00Z",
      },
    });
    const config = f.correctedView.registry.config;
    const first = await planLateSessions(f.store, SHADOW_TEST_UID, [{ session, config }]);
    const later = structuredClone(session);
    later.codeVersion = "another-request-commit";
    Object.assign(later, {
      lateRecovery: { ...later.lateRecovery, computedAt: "2026-10-21T02:00:00Z" },
    });
    const second = await planLateSessions(f.store, SHADOW_TEST_UID, [{ session: later, config }]);
    expect(second.planHash).toBe(first.planHash);
    const revision = await openKospiShadowRevisionStore(f.store, SHADOW_TEST_UID);
    await persistKospiShadow(revision, SHADOW_TEST_UID, session, config);
    const repeated = await planLateSessions(f.store, SHADOW_TEST_UID, [{ session: later, config }]);
    expect(repeated.summaries[0]!.reused).toBe(true);
    expect(repeated.planHash).not.toBe(first.planHash);
    expect(repeated.summaries[0]!.sessionCount).toBe(first.summaries[0]!.sessionCount);
    const changedEvidence = structuredClone(session);
    Object.assign(changedEvidence, {
      lateRecovery: {
        ...changedEvidence.lateRecovery,
        dataCutoffAt: "2026-10-17T00:00:00Z",
      },
    });
    await expect(
      planLateSessions(f.store, SHADOW_TEST_UID, [{ session: changedEvidence, config }]),
    ).rejects.toThrow("provenance mismatch");
    const skipped = structuredClone(session);
    skipped.date = "2026-10-19";
    skipped.previousSessionDate = "2026-10-15";
    skipped.gate.date = skipped.date;
    skipped.rows.forEach((r) => (r.date = skipped.date));
    await expect(
      planLateSessions(f.store, SHADOW_TEST_UID, [{ session: skipped, config }]),
    ).rejects.toThrow("KR calendar");
  });
  it("preserves immutable collision checking in the memory overlay", async () => {
    const f = await createShadowRevisionFixture();
    const overlay = memoryOverlay(f.store);
    await overlay.putImmutable("new", { a: 1 });
    await overlay.putImmutable("new", { a: 1 });
    await expect(overlay.putImmutable("new", { a: 2 })).rejects.toThrow("immutable conflict");
    expect(f.data.has("new")).toBe(false);
  });
});
