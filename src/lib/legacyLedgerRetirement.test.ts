import { afterEach, expect, it, vi } from "vitest";
import {
  assertLegacyLedgerActive,
  legacyLedgerArchiveOnly,
  LEGACY_LEDGER_RETIRED_MESSAGE,
} from "./legacyLedgerRetirement.server";

afterEach(() => vi.unstubAllEnvs());

it("keeps existing operational behavior until the explicit cutover switch is enabled", () => {
  vi.stubEnv("CLOUDTREND_LEDGER_ARCHIVE_ONLY", "");
  expect(legacyLedgerArchiveOnly()).toBe(false);
  expect(() => assertLegacyLedgerActive()).not.toThrow();
});

it("blocks legacy operations in archive-only mode and supports explicit rollback", () => {
  vi.stubEnv("CLOUDTREND_LEDGER_ARCHIVE_ONLY", "1");
  expect(legacyLedgerArchiveOnly()).toBe(true);
  expect(() => assertLegacyLedgerActive()).toThrow(LEGACY_LEDGER_RETIRED_MESSAGE);
  vi.stubEnv("CLOUDTREND_LEDGER_ARCHIVE_ONLY", "0");
  expect(() => assertLegacyLedgerActive()).not.toThrow();
});
