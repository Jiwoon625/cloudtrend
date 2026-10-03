import { ADOPTED_SERIES_KINDS } from "../src/lib/ledger/modelSeries";
import {
  summarizeOctoberShadowBook,
  isOctoberShadowReady,
} from "../src/lib/octoberShadowSummary.server";
import { fixtureSeries, registry } from "./october-shadow-fixtures";
import { describe, expect, it } from "vitest";
import { isPortfolioModelComparisonReady } from "../src/lib/portfolioModelConsolidation";
const kinds = [
  "KR_MIXED",
  "KR_KOSPI",
  "KR_KOSDAQ",
  "US_A0",
  "ETF_V02",
  "US_A2",
  "US_B3",
  "KR_KOSPI_CONFIRM1_BEAR",
];
const fixture = () => ({
  viewVersion: "october-shadow-holdings-tax-v1",
  readyForPortfolioConsolidation: true,
  books: kinds.map((kind) => ({
    bookId: `fixture:${kind}`,
    kind,
    currency: kind.startsWith("US_") ? "USD" : "KRW",
    status: "INITIALIZED_WAITING",
    initialCapital: "1000",
    cash: "1000",
    holdings: [] as unknown[],
    positions: 0,
    nav: null as string | null,
    returnPercent: null as number | null,
    tax: kind.startsWith("US_") ? { status: "UNAVAILABLE" } : null,
  })),
});
describe("runtime-gated portfolio comparison move", () => {
  it("allows eight verified initialized books without inventing a NAV or tax estimate", () =>
    expect(isPortfolioModelComparisonReady(fixture())).toBe(true));
  it.each([
    null,
    {},
    { readyForPortfolioConsolidation: true },
    { ...fixture(), viewVersion: "old" },
    { ...fixture(), readyForPortfolioConsolidation: false },
  ])("rejects missing/stale runtime contracts %j", (value) =>
    expect(isPortfolioModelComparisonReady(value)).toBe(false),
  );
  it("requires all eight distinct kinds and book ids", () => {
    const missing = fixture();
    missing.books.pop();
    expect(isPortfolioModelComparisonReady(missing)).toBe(false);
    const duplicate = fixture();
    duplicate.books[7] = duplicate.books[0]!;
    expect(isPortfolioModelComparisonReady(duplicate)).toBe(false);
  });
  it("does not hide old cards when a replacement book is unavailable or holdings coverage is incomplete", () => {
    const unavailable = fixture();
    unavailable.books[2]!.status = "UNAVAILABLE";
    expect(isPortfolioModelComparisonReady(unavailable)).toBe(false);
    const missingHoldings = fixture();
    missingHoldings.books[0]!.positions = 1;
    expect(isPortfolioModelComparisonReady(missingHoldings)).toBe(false);
    const badCash = fixture();
    badCash.books[0]!.cash = "NaN";
    expect(isPortfolioModelComparisonReady(badCash)).toBe(false);
  });
  it("requires a displayed tax status for each US comparison book", () => {
    const data = fixture();
    data.books.find((book) => book.kind === "US_A0")!.tax = null;
    expect(isPortfolioModelComparisonReady(data)).toBe(false);
  });
  it("requires real NAV and return fields only for recorded sessions", () => {
    const data = fixture();
    const book = data.books[0]!;
    book.status = "RECORDED";
    expect(isPortfolioModelComparisonReady(data)).toBe(false);
    book.nav = "1001";
    book.returnPercent = 0.1;
    expect(isPortfolioModelComparisonReady(data)).toBe(true);
  });
});

it("accepts the actual eight-book server summary contract including explicit cash-only opening state", async () => {
  const books = await Promise.all(
    ADOPTED_SERIES_KINDS.map(async (kind) =>
      summarizeOctoberShadowBook(
        kind,
        registry(await fixtureSeries(kind)),
        [],
        true,
        "2026-10-03T02:00:00Z",
      ),
    ),
  );
  expect(
    isPortfolioModelComparisonReady({
      viewVersion: "october-shadow-holdings-tax-v1",
      readyForPortfolioConsolidation: isOctoberShadowReady(books),
      books,
    }),
  ).toBe(true);
});
