import { Decimal } from "decimal.js";

export const ReconciliationDecimal = Decimal.clone({
  precision: 100,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1_000_000,
  toExpPos: 1_000_000,
});

export function canonicalReconciliationDecimal(value: Decimal): string {
  const fixed = value.toFixed();
  if (!fixed.includes(".")) return fixed;
  return fixed.replace(/\.0+$|(?<=\.[0-9]*[1-9])0+$/u, "");
}
