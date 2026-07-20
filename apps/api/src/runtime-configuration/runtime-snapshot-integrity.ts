import { createHash } from "node:crypto";

import { runtimeSnapshotSchema, type RuntimeSnapshot } from "@tokenpilot/contracts";

export type UnsignedRuntimeSnapshot = Omit<RuntimeSnapshot, "etag" | "signature">;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function runtimeFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value), "utf8").digest("hex")}`;
}

function bindingSignature(applicationId: string, etag: string): string {
  return runtimeFingerprint({ application_id: applicationId, etag });
}

export function signRuntimeSnapshot(value: UnsignedRuntimeSnapshot): RuntimeSnapshot {
  const etag = runtimeFingerprint(value);
  return runtimeSnapshotSchema.parse({
    ...value,
    etag,
    signature: bindingSignature(value.application_id, etag),
  });
}

export function verifyRuntimeSnapshot(value: unknown): RuntimeSnapshot {
  const parsed = runtimeSnapshotSchema.parse(value);
  const { etag, signature, ...unsigned } = parsed;
  if (runtimeFingerprint(unsigned) !== etag) {
    throw new TypeError("Runtime Snapshot ETag does not match its immutable content");
  }
  if (bindingSignature(parsed.application_id, etag) !== signature) {
    throw new TypeError("Runtime Snapshot signature does not match its application binding");
  }
  return parsed;
}
