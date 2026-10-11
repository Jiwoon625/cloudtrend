import { describe, expect, it } from "vitest";
import { ETF_SECTOR_BY_SYMBOL, resolveCuratedEtfSectorCode } from "./sectors";
import { normalizeReviewedStockSymbol } from "./stockSectorMaster";

// Keep the previous regex source verbatim as data, so this regression test
// compares its actual parsed behavior with the cleaned-up production literals.
const legacyEtfPrefix = new RegExp(String.raw`^[\'\"]+`);
const legacyStockPrefix = new RegExp(String.raw`^['\"]+`);
const cleanedPrefix = /^['"]+/;

function normalizeLegacySymbol(value: string, isEtf: boolean): string {
  let symbol = String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(isEtf ? legacyEtfPrefix : legacyStockPrefix, "");
  const prefixedCode = isEtf ? /^A[0-9A-Z]{6}$/ : /^A\d{1,6}$/;
  if (prefixedCode.test(symbol)) symbol = symbol.slice(1);
  if (/^\d+\.0$/.test(symbol)) symbol = symbol.slice(0, -2);
  if (/^\d{1,6}$/.test(symbol)) symbol = symbol.padStart(6, "0");
  return symbol;
}

const alphabet = ["'", '"', "\\", "A", "0", " ", "\n"];
const prefixes = [""];
let frontier = [""];
for (let length = 1; length <= 4; length += 1) {
  frontier = frontier.flatMap((prefix) => alphabet.map((char) => prefix + char));
  prefixes.push(...frontier);
}

const symbolCases = [
  "",
  "'",
  '"',
  "\\",
  "005930",
  "5930.0",
  "a005930",
  "0183j0",
  "a0183j0",
  "487240.0",
  "'\"'005930",
  "\\'005930",
  "'\\005930",
  "005'930",
  "' 005930",
  '\t"005930\n',
];

describe("symbol leading-quote regex cleanup", () => {
  it("preserves matches and replacements for both legacy regex spellings", () => {
    for (const prefix of prefixes) {
      for (const value of [prefix, `${prefix}005930`]) {
        for (const legacy of [legacyEtfPrefix, legacyStockPrefix]) {
          expect(value.match(cleanedPrefix), JSON.stringify(value)).toEqual(value.match(legacy));
          expect(value.replace(cleanedPrefix, ""), JSON.stringify(value)).toBe(
            value.replace(legacy, ""),
          );
        }
      }
    }
  });

  it("preserves stock normalization, including backslashes and empty input", () => {
    for (const value of symbolCases) {
      expect(normalizeReviewedStockSymbol(value), JSON.stringify(value)).toBe(
        normalizeLegacySymbol(value, false),
      );
    }
  });

  it("preserves curated ETF resolution for quoted and prefixed symbol variants", () => {
    for (const value of [
      ...symbolCases,
      ...prefixes.flatMap((prefix) => [`${prefix}0183J0`, `${prefix}487240`]),
    ]) {
      expect(resolveCuratedEtfSectorCode(value), JSON.stringify(value)).toBe(
        ETF_SECTOR_BY_SYMBOL[normalizeLegacySymbol(value, true)],
      );
    }
  });
});
