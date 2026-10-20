import { expect, it } from "vitest";
import { recoverUsScreeningPublication } from "../scripts/recover-us-screening-publication";
import { createImmutableArchiveFixture } from "./immutable-archive-fixture";

it("uses the real publisher for a 5,347-row recovery with an explicit write allowlist", async () => {
  const date = "2026-10-19";
  const dataHash = `sha256:${"a".repeat(64)}`;
  const result = {
    generatedAt: "2026-10-20T00:09:22Z",
    dataHash,
    source: {
      provider: "fixture",
      collectedAt: "2026-10-20T00:05:00Z",
      schemaVersion: "v1",
      metadata: {},
    },
    analysis: {
      date,
      ruleVersion: "frozen-v1",
      summary: {},
      state: { retained: true },
      rows: Array.from({ length: 5347 }, (_, i) => ({
        date,
        symbol: `TEST${i}`,
        name: `Saved issuer ${i}`,
        sector: "Technology",
        open: 10 + i,
        close: 11 + i,
        coreRank: i / 5347,
        betaRank: 0.4,
        onset80: false,
        a0Entry: false,
        a0Exit: false,
        eligibleBase: true,
        originalEvidence: "Complete saved evidence remains unchanged",
      })),
    },
  };
  const objects = new Map<string, Buffer>([
    [`owner/results/us-screening/${date}.json`, Buffer.from(JSON.stringify(result))],
    ["owner/cache/us-screening/latest.json", Buffer.from(JSON.stringify(result))],
  ]);
  const before = [...objects].map(([name, body]) => [name, body.toString("hex")]);
  const writes: string[] = [];
  const archive = createImmutableArchiveFixture();
  let storedFormat: unknown;
  const client = {
    from: (table: string) => {
      if (table === "screening_run_archive") {
        const q = archive();
        return {
          ...q,
          upsert: async (row: Record<string, unknown>, options: { ignoreDuplicates?: boolean }) => {
            writes.push(table);
            storedFormat = (row["snapshot"] as Record<string, unknown>)["storageFormat"];
            return q.upsert(row, options);
          },
        };
      }
      if (!["us_screening_history", "us_screening_ingest"].includes(table))
        throw new Error(`Forbidden table: ${table}`);
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        single: async () => ({
          error: null,
          data:
            table === "us_screening_history"
              ? { date, data_hash: dataHash, rule_version: "frozen-v1", created_at: "original" }
              : { as_of_date: date, data_hash: dataHash, storage_bucket: "cloudtrend-data" },
        }),
      };
      return q;
    },
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("cloudtrend-data");
        return {
          download: async (path: string) => {
            const bytes = objects.get(path);
            return {
              data: bytes ? new Blob([new Uint8Array(bytes)]) : null,
              error: bytes ? null : { message: "missing" },
            };
          },
          upload: async (path: string, body: string | Buffer) => {
            if (
              ![
                "owner/cache/us-screening/view-v1.json.gz",
                "owner/cache/us-screening/summary-v1.json",
              ].includes(path)
            )
              throw new Error(`Forbidden write: ${path}`);
            writes.push(path);
            objects.set(path, Buffer.from(body));
            return { error: null };
          },
        };
      },
    },
  };
  const request = {
    version: "us-publication-only-recovery-v1" as const,
    date,
    dataHash,
    ruleVersion: "frozen-v1",
    expectedRows: 5347,
  };
  const receipt = await recoverUsScreeningPublication(client as never, "owner", request);
  expect(receipt).toMatchObject({
    ok: true,
    rows: 5347,
    archiveVerified: true,
    browserViewVerified: true,
    summaryVerified: true,
  });
  expect(storedFormat).toBe("screening-run-archive-gzip-v1");
  expect(writes).toEqual([
    "screening_run_archive",
    "owner/cache/us-screening/view-v1.json.gz",
    "owner/cache/us-screening/summary-v1.json",
  ]);
  for (const [name, hex] of before) expect(objects.get(name!)?.toString("hex")).toBe(hex);
  await expect(
    recoverUsScreeningPublication(client as never, "owner", request),
  ).resolves.toMatchObject({ ok: true });
});
