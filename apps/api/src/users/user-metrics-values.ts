import { Prisma } from "@tokenpilot/db";

export function metricDecimal(value: unknown): Prisma.Decimal {
  try {
    return new Prisma.Decimal(typeof value === "string" || typeof value === "number" ? value : 0);
  } catch {
    return new Prisma.Decimal(0);
  }
}

export function metricInteger(value: unknown): bigint {
  try {
    return BigInt(typeof value === "string" || typeof value === "number" ? value : 0);
  } catch {
    return 0n;
  }
}
