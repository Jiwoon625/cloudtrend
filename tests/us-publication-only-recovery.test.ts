import { beforeEach, describe, expect, it, vi } from "vitest";
import { usBrowserViews } from "../src/lib/usBrowserViews";
import {
  assertPublicationRecoveryRequest,
  recoverUsScreeningPublication,
} from "../scripts/recover-us-screening-publication";
const fixture = vi.hoisted(() => ({ calls: 0, corrupt: false, fail: false }));
vi.mock("../scripts/us-screening-publication", () => ({
  publishBrowserViews: async (client: unknown, uid: string, result: unknown) => {
    fixture.calls++;
    if (fixture.fail) throw new Error("archive failed");
    const { usBrowserViews } = await import("../src/lib/usBrowserViews");
    const { gzipSync } = await import("node:zlib");
    const views = usBrowserViews(result as never);
    const c = client as ReturnType<typeof setup>["client"];
    c.objects.set(
      `${uid}/cache/us-screening/view-v1.json.gz`,
      gzipSync(JSON.stringify(views.screening)),
    );
    c.objects.set(
      `${uid}/cache/us-screening/summary-v1.json`,
      Buffer.from(JSON.stringify(fixture.corrupt ? { wrong: true } : views.summary)),
    );
  },
}));
const request = {
  version: "us-publication-only-recovery-v1" as const,
  date: "2026-10-19",
  dataHash: `sha256:${"a".repeat(64)}`,
  ruleVersion: "frozen-v1",
  expectedRows: 1,
};
function setup() {
  const result = {
    generatedAt: "2026-10-20T00:09:22Z",
    dataHash: request.dataHash,
    source: {
      provider: "fixture",
      collectedAt: "2026-10-20T00:05:00Z",
      schemaVersion: "v1",
      metadata: {},
    },
    analysis: {
      date: request.date,
      ruleVersion: request.ruleVersion,
      summary: {},
      state: { retained: true },
      rows: [
        {
          date: request.date,
          symbol: "TEST",
          name: "Test",
          sector: "Technology",
          open: 10,
          close: 11,
        },
      ],
    },
  };
  const prefix = "owner";
  const objects = new Map<string, Buffer>([
    [`${prefix}/results/us-screening/${request.date}.json`, Buffer.from(JSON.stringify(result))],
    [`${prefix}/cache/us-screening/latest.json`, Buffer.from(JSON.stringify(result))],
  ]);
  const history = {
    date: request.date,
    data_hash: request.dataHash,
    rule_version: request.ruleVersion,
    created_at: "original",
  };
  const ingest = {
    as_of_date: request.date,
    data_hash: request.dataHash,
    storage_bucket: "cloudtrend-data",
  };
  const tables: string[] = [];
  const client = {
    objects,
    from: (table: string) => {
      tables.push(table);
      if (!["us_screening_history", "us_screening_ingest"].includes(table))
        throw new Error("Unexpected model/ledger access");
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        single: async () => ({
          data: table === "us_screening_history" ? { ...history } : { ...ingest },
          error: null,
        }),
      };
      return q;
    },
    storage: {
      from: (bucket: string) => {
        expect(bucket).toBe("cloudtrend-data");
        return {
          download: async (path: string) => {
            const data = objects.get(path);
            return {
              data: data ? new Blob([new Uint8Array(data)]) : null,
              error: data ? null : { message: "missing" },
            };
          },
        };
      },
    },
  };
  return { client, result, objects, history, ingest, tables };
}
beforeEach(() => {
  fixture.calls = 0;
  fixture.corrupt = false;
  fixture.fail = false;
});
describe("bounded publication-only repair", () => {
  it("publishes exact saved views and verifies them without model/ledger/history/result/latest writes", async () => {
    const { client, result, objects, tables } = setup();
    const before = [...objects].map(([path, bytes]) => [path, bytes.toString("hex")]);
    const receipt = await recoverUsScreeningPublication(client as never, "owner", request);
    expect(receipt).toMatchObject({
      ok: true,
      date: request.date,
      dataHash: request.dataHash,
      rows: 1,
      browserViewVerified: true,
      summaryVerified: true,
    });
    for (const [path, hex] of before) expect(objects.get(path!)?.toString("hex")).toBe(hex);
    expect(fixture.calls).toBe(1);
    expect(new Set(tables)).toEqual(new Set(["us_screening_ingest", "us_screening_history"]));
    expect(JSON.parse(objects.get("owner/cache/us-screening/summary-v1.json")!.toString())).toEqual(
      usBrowserViews(result as never).summary,
    );
  });
  it("rejects incomplete or newer source before any publication", async () => {
    const { client, ingest } = setup();
    ingest.as_of_date = "2026-10-20";
    await expect(recoverUsScreeningPublication(client as never, "owner", request)).rejects.toThrow(
      "exact latest completed",
    );
    expect(fixture.calls).toBe(0);
  });
  it("does not roll back a reviewed replacement latest view", async () => {
    const { client, objects } = setup();
    objects.set("owner/cache/us-screening/latest.json", Buffer.from('{"different":true}'));
    await expect(recoverUsScreeningPublication(client as never, "owner", request)).rejects.toThrow(
      "Current latest differs",
    );
    expect(fixture.calls).toBe(0);
  });
  it("fails on archived-result identity mismatch", async () => {
    const { client } = setup();
    await expect(
      recoverUsScreeningPublication(client as never, "owner", { ...request, expectedRows: 2 }),
    ).rejects.toThrow("identity or universe");
    expect(fixture.calls).toBe(0);
  });
  it("does not continue past archive publication failure", async () => {
    const { client } = setup();
    fixture.fail = true;
    await expect(recoverUsScreeningPublication(client as never, "owner", request)).rejects.toThrow(
      "archive failed",
    );
    expect(client.objects.size).toBe(2);
  });
  it("rejects mismatched actual summary readback", async () => {
    const { client } = setup();
    fixture.corrupt = true;
    await expect(recoverUsScreeningPublication(client as never, "owner", request)).rejects.toThrow(
      "browser view or summary differs",
    );
  });
  it("rejects requests with unknown scope fields", () => {
    expect(() => assertPublicationRecoveryRequest({ ...request, replay: true })).toThrow(
      "Invalid bounded",
    );
  });
});
