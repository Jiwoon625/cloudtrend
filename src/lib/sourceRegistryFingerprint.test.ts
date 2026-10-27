import { describe, expect, it, vi } from "vitest";
import { sourceFingerprintRecords } from "./sourceFingerprintRecords";

const { select, rows } = vi.hoisted(() => {
  const rows = [
    {
      id: "old",
      data_hash: "a",
      schema_hash: "s",
      activated_at: null,
      created_at: "1",
      kr_publication: null,
    },
    {
      id: "new",
      data_hash: "b",
      schema_hash: "s",
      activated_at: "2",
      created_at: "2",
      kr_publication: { phase: "PRELIMINARY", manifestText: "signed data" },
    },
  ];
  const query = {
    eq: () => query,
    order: () => query,
    then: (resolve: (value: unknown) => void) => resolve({ data: rows, error: null }),
  };
  const select = vi.fn(() => query);
  return { select, rows };
});

vi.mock("./cloud", () => ({ userId: async () => "owner", supabase: { from: () => ({ select }) } }));

describe("screening source identity", () => {
  it("matches server identity for legacy and preliminary sources and changes when the contract changes", async () => {
    const { listActiveScreeningSourceFingerprints } = await import("./sourceRegistry");
    const client = await listActiveScreeningSourceFingerprints();
    const server = rows.map(({ kr_publication, ...row }) => ({
      ...row,
      validation_result: { krPublication: kr_publication },
    }));
    expect(select).toHaveBeenCalledWith(
      expect.stringContaining("kr_publication:validation_result->krPublication"),
    );
    expect(sourceFingerprintRecords(client)).toEqual(sourceFingerprintRecords(server));
    const changed = structuredClone(server);
    changed[1]!.validation_result.krPublication!.phase = "FINAL";
    expect(sourceFingerprintRecords(client)).not.toEqual(sourceFingerprintRecords(changed));
  });
});
