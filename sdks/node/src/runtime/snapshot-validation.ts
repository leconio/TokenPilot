import { createHash } from "node:crypto";

import { runtimeSnapshotSchema, type RuntimeSnapshot } from "@tokenpilot/contracts";

import { AiControlSdkError } from "../errors.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function parseVerifiedRuntimeSnapshot(
  input: unknown,
  now: Date,
  options: Readonly<{ allowExpired: boolean }>,
): RuntimeSnapshot {
  const snapshot = runtimeSnapshotSchema.parse(input);
  const { etag, signature, ...unsigned } = snapshot;
  const expected = `sha256:${createHash("sha256").update(canonical(unsigned)).digest("hex")}`;
  if (etag !== expected) {
    throw new AiControlSdkError(
      "SDK_RUNTIME_CHECKSUM_MISMATCH",
      "Runtime Snapshot ETag does not match its canonical content.",
    );
  }
  const expectedSignature = `sha256:${createHash("sha256")
    .update(canonical({ application_id: snapshot.application_id, etag }))
    .digest("hex")}`;
  if (signature !== expectedSignature) {
    throw new AiControlSdkError(
      "SDK_RUNTIME_SIGNATURE_MISMATCH",
      "Runtime Snapshot signature does not match its application binding.",
    );
  }
  if (!options.allowExpired && new Date(snapshot.expires_at).getTime() <= now.getTime()) {
    throw new AiControlSdkError(
      "SDK_RUNTIME_EXPIRED",
      "Control Plane returned an expired Runtime Snapshot.",
    );
  }
  return snapshot;
}
