import { createHmac } from "node:crypto";

import type { ReconciliationDimensions } from "./types.js";

export function pseudonymizeReconciliationUser(
  userId: string,
  secret: string | Uint8Array,
): string {
  const key = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret);
  if (key.byteLength < 32)
    throw new TypeError("reconciliation user HMAC secret must be at least 32 bytes");
  if (userId.length === 0) throw new TypeError("userId is required");
  return `user_hmac:${createHmac("sha256", key).update(userId, "utf8").digest("hex")}`;
}

export function redactReconciliationDimensions(
  dimensions: ReconciliationDimensions,
  secret: string | Uint8Array,
): ReconciliationDimensions {
  return {
    ...dimensions,
    userId:
      dimensions.userId === null ? null : pseudonymizeReconciliationUser(dimensions.userId, secret),
  };
}
