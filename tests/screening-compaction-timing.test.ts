import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sourceTimingEvidence } from "../src/lib/sourceTimingEvidence";
import { latestSourceRegistration } from "../src/lib/screeningSnapshot";
import { sourceCaptureForDate } from "../src/lib/shadowReplay.server";
import { inputFingerprint, listActiveSources } from "../src/lib/screeningSources.server";
import { DEFAULT_SCORING_CONFIG } from "../src/lib/engine/scoring";
import { shadowEngineManifest } from "../scripts/october-shadow-code-manifest";
import manifest from "../src/lib/ledger/octoberShadowEngineManifest.generated.json";

const originals = [
  {
    id: "original-range",
    min_date: "2026-10-01",
    max_date: "2026-10-06",
    activated_at: "2026-10-06T23:00:00Z",
    created_at: "2026-10-06T22:59:00Z",
  },
  {
    id: "original-overlap",
    min_date: "2026-10-05",
    max_date: "2026-10-07",
    activated_at: "2026-10-07T23:00:00Z",
    created_at: "2026-10-07T22:59:00Z",
  },
  {
    id: "original-null-activation",
    min_date: "2026-10-09",
    max_date: "2026-10-09",
    activated_at: null,
    created_at: "2026-10-10T08:00:00.123456+09:00",
  },
];

function compacted(evidence: unknown = originals) {
  return {
    id: "compacted-candidate",
    min_date: "2026-10-01",
    max_date: "2026-10-09",
    activated_at: "2026-10-20T23:00:00Z",
    created_at: "2026-10-20T22:59:00Z",
    savedAt: "2026-10-20T23:00:00Z",
    validation_result: {
      screeningCompaction: { original_source_evidence: evidence },
    },
  };
}

describe("logical source timing across compaction", () => {
  it("leaves ordinary record/fallback behavior unchanged", () => {
    expect(sourceTimingEvidence(originals[0]!)).toEqual([originals[0]]);
    expect(sourceTimingEvidence({ ...originals[0], validation_result: {} })).toEqual([
      { ...originals[0], validation_result: {} },
    ]);
    expect(sourceCaptureForDate([{ savedAt: "2026-10-07T23:00:00Z" }], "2026-10-06")).toBe(
      "2026-10-07T23:00:00Z",
    );
    expect(sourceCaptureForDate([{ created_at: "invalid" }], "2026-10-06")).toBeNull();
    expect(latestSourceRegistration([], "2026-10-06")).toBeUndefined();
  });

  it("preserves latest registration and replay capture for every covered date and gaps", () => {
    const after = [compacted()];
    const expected: Record<string, string | undefined> = {
      "2026-09-30": undefined,
      "2026-10-01": originals[0]!.activated_at!,
      "2026-10-02": originals[0]!.activated_at!,
      "2026-10-03": originals[0]!.activated_at!,
      "2026-10-04": originals[0]!.activated_at!,
      "2026-10-05": originals[1]!.activated_at!,
      "2026-10-06": originals[1]!.activated_at!,
      "2026-10-07": originals[1]!.activated_at!,
      "2026-10-08": undefined,
      "2026-10-09": originals[2]!.created_at,
      "2026-10-10": undefined,
    };
    for (const [date, capture] of Object.entries(expected)) {
      expect(latestSourceRegistration(originals, date), date).toBe(capture);
      expect(latestSourceRegistration(after, date), date).toBe(capture);
      expect(sourceCaptureForDate(originals, date), date).toBe(capture ?? null);
      expect(sourceCaptureForDate(after, date), date).toBe(capture ?? null);
    }
  });

  it("lets a newly appended original source dominate only its own dates", () => {
    const appended = {
      id: "new-appended-source",
      min_date: "2026-10-06",
      max_date: "2026-10-06",
      activated_at: "2026-10-21T23:00:00Z",
      created_at: "2026-10-21T22:59:00Z",
    };
    for (const date of ["2026-10-01", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-09"]) {
      expect(latestSourceRegistration([compacted(), appended], date)).toBe(
        latestSourceRegistration([...originals, appended], date),
      );
      expect(sourceCaptureForDate([compacted(), appended], date)).toBe(
        sourceCaptureForDate([...originals, appended], date),
      );
    }
    expect(sourceCaptureForDate([compacted(), appended], "2026-10-06")).toBe(appended.activated_at);
  });

  it("supports repeated flattened receipts and deduplicates identical origins without mutation", () => {
    const first = compacted();
    const repeated = compacted([...sourceTimingEvidence(first), ...sourceTimingEvidence(first)]);
    const before = structuredClone(repeated);
    expect(sourceTimingEvidence(repeated)).toEqual(originals);
    expect(repeated).toEqual(before);
    // Every candidate carries the complete original lineage, even if physical
    // chunks split date ranges. Do not clip logical evidence to a chunk's range.
    const chunks = [
      { ...first, max_date: "2026-10-04" },
      { ...repeated, id: "second-chunk", min_date: "2026-10-05" },
    ];
    for (const date of ["2026-10-01", "2026-10-06", "2026-10-08", "2026-10-09"]) {
      expect(latestSourceRegistration(chunks, date)).toBe(
        latestSourceRegistration(originals, date),
      );
      expect(sourceCaptureForDate(chunks, date)).toBe(sourceCaptureForDate(originals, date));
    }
  });

  const malformedEvidence = [
    undefined,
    null,
    {},
    [],
    [null],
    [originals[0], {}],
    [{ ...originals[0], id: "" }],
    [{ ...originals[0], created_at: undefined }],
    [{ ...originals[0], activated_at: "not-a-time" }],
    [{ ...originals[0], activated_at: "2026-10-06T23:00:00" }],
    [{ ...originals[0], min_date: "2026-02-30" }],
    [{ ...originals[0], min_date: "2026-10-09", max_date: "2026-10-01" }],
    [{ ...originals[0], validation_result: compacted().validation_result }],
    [originals[0], { ...originals[0], activated_at: "2026-10-19T00:00:00Z" }],
  ];
  for (const [index, evidence] of malformedEvidence.entries()) {
    it(`fails closed for corrupt lineage case ${index}`, () => {
      const record = compacted();
      record.validation_result.screeningCompaction.original_source_evidence = evidence;
      expect(() => sourceTimingEvidence(record)).toThrow(
        "Invalid screening compaction timing evidence",
      );
      expect(() => latestSourceRegistration([record], "2026-10-06")).toThrow();
      expect(() => sourceCaptureForDate([record], "2026-10-06")).toThrow();
      // An unrelated range cannot mask a corrupt active receipt.
      expect(() => sourceCaptureForDate([record], "2026-11-01")).toThrow();
    });
  }
  for (const receipt of [null, undefined, [], "bad", {}]) {
    it(`fails closed for malformed receipt ${JSON.stringify(receipt)}`, () => {
      expect(() =>
        sourceTimingEvidence({
          ...compacted(),
          validation_result: { screeningCompaction: receipt },
        }),
      ).toThrow("Invalid screening compaction timing evidence");
    });
  }
});

it("carries receipt through the web active-source query without changing physical ordering/fingerprint", async () => {
  const source = {
    ...compacted(),
    original_filename: "compacted.csv",
    storage_bucket: "cloudtrend-data",
    storage_path: "user/compacted.csv",
    file_hash: "file",
    data_hash: "data",
    schema_hash: "schema",
  };
  const select = vi.fn();
  const order = vi.fn();
  const query = {
    select,
    order,
    eq: vi.fn(),
    then: (resolve: (value: unknown) => unknown) => resolve({ data: [source], error: null }),
  };
  select.mockReturnValue(query);
  order.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  const client = { from: () => query } as unknown as SupabaseClient;
  const loaded = await listActiveSources(client, "user");
  expect(select).toHaveBeenCalledWith(expect.stringContaining("validation_result"));
  expect(order.mock.calls).toEqual([
    ["activated_at", { ascending: true, nullsFirst: true }],
    ["created_at", { ascending: true }],
  ]);
  expect(loaded[0]!.validation_result).toEqual(source.validation_result);
  expect(sourceCaptureForDate(loaded, "2026-10-06")).toBe(originals[1]!.activated_at);
  expect(inputFingerprint(loaded, DEFAULT_SCORING_CONFIG)).toBe(
    inputFingerprint([{ ...source, validation_result: {} }], DEFAULT_SCORING_CONFIG),
  );
  expect(loaded[0]!.activated_at).toBe(source.activated_at);
});

it("leaves the frozen Shadow calculation manifest byte-for-byte equivalent", async () => {
  const current = await shadowEngineManifest();
  expect(current).toEqual(manifest);
  expect(current.manifest.files).not.toHaveProperty("src/lib/sourceTimingEvidence.ts");
  expect(current.manifest.files).not.toHaveProperty("src/lib/screeningSnapshot.ts");
  expect(current.manifest.files).not.toHaveProperty("src/lib/shadowReplay.server.ts");
}, 30_000);
