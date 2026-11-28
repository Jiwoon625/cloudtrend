import process from "node:process";

/** Reversible server-only rollout barrier. Do not enable until cutover gates pass. */
export const LEGACY_LEDGER_RETIRED_MESSAGE =
  "기존 원장 운영은 종료되었습니다. 실제 보유현황은 종목마스터DB에서 수정하세요.";

export function legacyLedgerArchiveOnly(): boolean {
  return process.env["CLOUDTREND_LEDGER_ARCHIVE_ONLY"] === "1";
}

export function assertLegacyLedgerActive(): void {
  if (legacyLedgerArchiveOnly()) throw new Error(LEGACY_LEDGER_RETIRED_MESSAGE);
}
