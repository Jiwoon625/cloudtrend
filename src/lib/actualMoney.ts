import { decimal, format, fromLegacyNumber, representedLegacyNumber } from "./ledger/decimal";

/** Preserve JSON's exact decimal spelling for actual fills; frozen model arithmetic stays unchanged. */
export function actualNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    throw new Error("Unsafe actual amount");
  const text = String(value);
  return /e/i.test(text) ? fromLegacyNumber(value) : format(decimal(text));
}
export function representedActualNumber(value: number): string {
  try {
    return actualNumber(value);
  } catch {
    return representedLegacyNumber(value);
  }
}
export function actualGross(price: number, shares: number): number {
  if (!Number.isSafeInteger(shares) || shares <= 0) throw new Error("Invalid integer quantity");
  const exact = format(decimal(actualNumber(price)) * BigInt(shares));
  const value = Number(exact);
  if (actualNumber(value) !== exact)
    throw new Error("Gross cannot preserve eight-decimal precision");
  return value;
}
