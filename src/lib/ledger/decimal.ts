/** Exact fixed-point journal arithmetic, eight decimal places; no binary money rounding. */
const SCALE = 100_000_000n;
export function decimal(value: string): bigint {
  if (!/^-?\d+(\.\d{1,8})?$/.test(value)) throw new Error(`Invalid decimal: ${value}`);
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  return (negative ? -1n : 1n) * (BigInt(whole!) * SCALE + BigInt(fraction.padEnd(8, "0")));
}
export function format(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const fraction = (abs % SCALE).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${abs / SCALE}${fraction ? `.${fraction}` : ""}`;
}
export const multiply = (a: bigint, b: bigint) => (a * b) / SCALE;
export const divide = (a: bigint, b: bigint) => {
  if (!b) throw new Error("Division by zero");
  return (a * SCALE) / b;
};
export function fromLegacyNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    throw new Error("Legacy number is not safely representable");
  const exact = value.toFixed(8);
  if (Number(exact) !== value)
    throw new Error("Legacy number needs more than eight decimal places");
  return format(decimal(exact));
}
/** Journal representation only; retain the original legacy observation separately. */
export function representedLegacyNumber(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    throw new Error("Legacy number is not safely representable");
  return format(decimal(value.toFixed(8)));
}
export function integerBudgetQuantity(
  budget: string,
  cash: string,
  price: string,
  oneWayCost = "0.0015",
) {
  const b = decimal(budget),
    c = decimal(cash),
    p = decimal(price),
    f = decimal(oneWayCost);
  if (b < 0n || c < 0n || p <= 0n || f < 0n || f >= SCALE) throw new Error("Invalid model budget");
  // Exact rational division keeps the target inclusive of fees and cannot round a share up.
  return (((b < c ? b : c) * SCALE) / (p * (SCALE + f))).toString();
}
