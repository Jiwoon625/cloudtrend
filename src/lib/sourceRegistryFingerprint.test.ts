import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SCORING_CONFIG } from "./engine/scoring";
import { screeningInputIdentity } from "./screeningInputIdentity";
import { stableCacheJson } from "./screeningCacheContract";
import { inputFingerprint, listActiveSources } from "./screeningSources.server";

const state = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  error: null as null | { message: string },
}));
const client = vi.hoisted(() => ({
  from: () => ({
    select: (columns: string) => {
      const query = {
        eq: () => query,
        order: () => query,
        then: (resolve: (value: unknown) => void) =>
          resolve({
            error: state.error,
            data: state.rows.map((row) =>
              columns.includes("kr_publication:")
                ? {
                    id: row["id"],
                    data_hash: row["data_hash"],
                    schema_hash: row["schema_hash"],
                    activated_at: row["activated_at"],
                    created_at: row["created_at"],
                    kr_publication: columns.includes("validation_result->krPublication")
                      ? ((row["validation_result"] as { krPublication?: unknown })?.krPublication ??
                        null)
                      : null,
                  }
                : row,
            ),
          }),
      };
      return query;
    },
  }),
}));
vi.mock("./cloud", () => ({ userId: async () => "owner", supabase: client }));

const row = (id: string, publication?: unknown) => ({
  id,
  data_hash: `data-${id}`,
  schema_hash: "schema",
  activated_at: null,
  created_at: id,
  validation_result: publication
    ? { krPublication: publication, stats: { large: "excluded" } }
    : {},
});
async function fingerprints() {
  const { listActiveScreeningSourceFingerprints } = await import("./sourceRegistry");
  const browserRows = await listActiveScreeningSourceFingerprints();
  const serverRows = await listActiveSources(client as never, "owner");
  const browser = createHash("sha256")
    .update(stableCacheJson(screeningInputIdentity(browserRows, DEFAULT_SCORING_CONFIG)))
    .digest("hex");
  const server = inputFingerprint(serverRows, DEFAULT_SCORING_CONFIG);
  expect(browser).toBe(server);
  return browser;
}
describe("browser/server source identity contract", () => {
  it.each([
    undefined,
    { phase: "PRELIMINARY", manifestText: "verified" },
    { phase: "FINAL", supersedesPending: [{ date: "2026-10-26", fileHash: "previous" }] },
  ])("preserves identity for legacy/preliminary/final publication %j", async (publication) => {
    state.rows = [row("old"), row("new", publication)];
    state.error = null;
    await fingerprints();
  });
  it.each(["data_hash", "schema_hash", "activated_at", "created_at"])(
    "invalidates changed %s on both readers",
    async (field) => {
      state.rows = [row("new", { phase: "PRELIMINARY" })];
      const before = await fingerprints();
      state.rows[0]![field] = "changed";
      expect(await fingerprints()).not.toBe(before);
    },
  );
  it("invalidates publication proof changes, source additions and precedence changes", async () => {
    state.rows = [row("old"), row("new", { phase: "PRELIMINARY", manifestText: "proof-a" })];
    const before = await fingerprints();
    state.rows[1]!["validation_result"] = {
      krPublication: { phase: "PRELIMINARY", manifestText: "proof-b" },
    };
    const changed = await fingerprints();
    expect(changed).not.toBe(before);
    state.rows.push(row("added"));
    const added = await fingerprints();
    expect(added).not.toBe(changed);
    state.rows.reverse();
    expect(await fingerprints()).not.toBe(added);
  });
});
