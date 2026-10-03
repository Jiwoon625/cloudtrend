import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  loadOctoberShadowSummaryForOwner,
  isOctoberShadowReady,
  summarizeOctoberShadowBook,
} from "./octoberShadowSummary.server";
import { ADOPTED_SERIES_KINDS } from "./ledger/modelSeries";
import { fixtureSeries, registry, sessionRow, usRun } from "../../tests/october-shadow-fixtures";
const now = "2026-10-07T21:00:00Z";
describe("October Shadow read-only summary", () => {
  it("distinguishes absent registration from initialized cash-only waiting", async () => {
    expect((await summarizeOctoberShadowBook("US_A0", null, [], true, now)).status).toBe(
      "NOT_INITIALIZED",
    );
    const series = await fixtureSeries();
    const result = await summarizeOctoberShadowBook("US_A0", registry(series), [], true, now);
    expect(result).toMatchObject({
      status: "INITIALIZED_WAITING",
      initialCapital: "73551.04",
      cash: "73551.04",
      residualKrw: "6.016",
      firstSessionDate: null,
      latestSessionDate: null,
      nav: null,
      positions: 0,
      pending: 0,
    });
    expect(result.tax?.currentYearTaxKrw).toBeNull();
  });
  it("keeps all eight book identities and exact opening state isolated", async () => {
    const books = await Promise.all(
      ADOPTED_SERIES_KINDS.map(async (kind) =>
        summarizeOctoberShadowBook(kind, registry(await fixtureSeries(kind)), [], true, now),
      ),
    );
    expect(new Set(books.map((b) => b.bookId)).size).toBe(8);
    expect(books.filter((b) => b.role === "ALTERNATIVE_SHADOW").length).toBe(3);
    expect(
      books
        .filter((b) => b.currency === "KRW")
        .every((b) => b.cash === "100000000" && b.tax === null),
    ).toBe(true);
  });
  it("uses actual persisted sessions for first/latest dates", async () => {
    const series = await fixtureSeries(),
      first = await usRun(series);
    const next = await usRun(series, "2026-10-06", first);
    const result = await summarizeOctoberShadowBook(
      "US_A0",
      registry(series),
      [sessionRow(first), sessionRow(next, first)],
      true,
      now,
    );
    expect(result).toMatchObject({
      status: "RECORDED",
      firstSessionDate: "2026-10-05",
      latestSessionDate: "2026-10-06",
      nav: "73551.04",
    });
    expect(result.tax?.currentYearTaxKrw).toBe(0);
  });
  it("rejects registry mismatch, invalid hash, future publication and missing predecessor", async () => {
    const series = await fixtureSeries(),
      first = await usRun(series),
      row = registry(series);
    expect(
      (await summarizeOctoberShadowBook("US_A0", { ...row, role: "ACTUAL" }, [], true, now)).status,
    ).toBe("UNAVAILABLE");
    expect(
      (
        await summarizeOctoberShadowBook(
          "US_A0",
          row,
          [sessionRow(first)],
          true,
          "2026-10-03T00:00:00Z",
        )
      ).status,
    ).toBe("UNAVAILABLE");
    const next = await usRun(series, "2026-10-06", first);
    expect(
      (await summarizeOctoberShadowBook("US_A0", row, [sessionRow(next, first)], true, now)).status,
    ).toBe("UNAVAILABLE");
    first.stateHash = `sha256:${"0".repeat(64)}`;
    expect(
      (await summarizeOctoberShadowBook("US_A0", row, [sessionRow(first)], true, now)).status,
    ).toBe("UNAVAILABLE");
  });
  it("uses only owner-filtered SELECT queries and does not hide a session query failure as zero", async () => {
    const series = await fixtureSeries();
    const queries: Array<{ table: string; filters: Array<[string, unknown]> }> = [];
    const uid = "11111111-1111-4111-8111-111111111111";
    const client = {
      from(table: string) {
        const query = { table, filters: [] as Array<[string, unknown]> };
        queries.push(query);
        const builder = {
          select() {
            return builder;
          },
          eq(key: string, value: unknown) {
            query.filters.push([key, value]);
            return builder;
          },
          in(key: string, value: unknown) {
            query.filters.push([key, value]);
            return builder;
          },
          order() {
            return builder;
          },
          range() {
            return builder;
          },
          then(resolve: (value: unknown) => unknown) {
            return Promise.resolve(
              resolve(
                table === "ledger_model_series"
                  ? { data: [registry(series)], error: null }
                  : { data: null, error: { message: "fixture read failed" } },
              ),
            );
          },
        };
        return builder;
      },
    } as unknown as SupabaseClient;
    const result = await loadOctoberShadowSummaryForOwner(client, uid);
    expect(result.books.find((book) => book.kind === "US_A0")?.status).toBe("UNAVAILABLE");
    expect(result.books.find((book) => book.kind === "US_A0")?.tax).toBeNull();
    expect(queries.length).toBe(2);
    expect(
      queries.every((query) =>
        query.filters.some(([key, value]) => key === "user_id" && value === uid),
      ),
    ).toBe(true);
    expect(queries[1]!.filters).toContainEqual(["series_id", series.bookId]);
    await expect(loadOctoberShadowSummaryForOwner(client, "untrusted")).rejects.toThrow("소유자");
  });
});

it("consolidation waits for all eight verified holdings/tax shapes, including explicit pending openings", async () => {
  const books = await Promise.all(
    ADOPTED_SERIES_KINDS.map(async (kind) =>
      summarizeOctoberShadowBook(kind, registry(await fixtureSeries(kind)), [], true, now),
    ),
  );
  expect(isOctoberShadowReady(books)).toBe(true);
  expect(isOctoberShadowReady(books.slice(1))).toBe(false);
  expect(
    isOctoberShadowReady(
      books.map((book) => (book.kind === "US_A0" ? { ...book, tax: null } : book)),
    ),
  ).toBe(false);
  expect(
    isOctoberShadowReady(
      books.map((book) =>
        book.kind === "KR_KOSDAQ" ? { ...book, status: "UNAVAILABLE" as const } : book,
      ),
    ),
  ).toBe(false);
});
