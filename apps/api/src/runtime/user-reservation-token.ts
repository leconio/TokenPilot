import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { ConflictException, ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";

import type { ApiConfiguration } from "../api-config.js";

const claimsSchema = z.strictObject({
  version: z.literal("user-aiu-reservation-1"),
  key_version: z.string().min(1).max(64),
  reservation_id: z.string().uuid(),
  application_id: z.string().uuid(),
  user_id: z.string().uuid(),
  quota_id: z.string().uuid(),
  operation_id: z.string().min(1).max(256),
  virtual_model: z.string().min(1).max(120),
  candidate_model_ids: z.array(z.string().uuid()).min(1).max(32),
  reserved_aiu_micros: z.string().regex(/^(?:0|[1-9][0-9]*)$/u),
  expires_at: z.string().datetime({ offset: true }),
});

export type UserReservationClaims = z.infer<typeof claimsSchema>;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class UserReservationTokenCodec {
  constructor(private readonly configuration: ApiConfiguration) {}

  sign(claims: Omit<UserReservationClaims, "version" | "key_version">): string {
    const payload = Buffer.from(
      JSON.stringify({
        version: "user-aiu-reservation-1",
        key_version: this.keyVersion(),
        ...claims,
      } satisfies UserReservationClaims),
      "utf8",
    ).toString("base64url");
    const signature = createHmac("sha256", this.secret())
      .update(payload, "utf8")
      .digest("base64url");
    return `tpur1.${payload}.${signature}`;
  }

  verify(token: string): UserReservationClaims {
    const [prefix, payload, signature, extra] = token.split(".");
    if (
      prefix !== "tpur1" ||
      payload === undefined ||
      signature === undefined ||
      extra !== undefined
    ) {
      throw new ConflictException("Reservation token is invalid");
    }
    const expected = createHmac("sha256", this.secret()).update(payload, "utf8").digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, "base64url");
    } catch {
      throw new ConflictException("Reservation token is invalid");
    }
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      throw new ConflictException("Reservation token is invalid");
    }
    try {
      const parsed = claimsSchema.parse(
        JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
      );
      if (parsed.key_version !== this.keyVersion()) {
        throw new ConflictException("Reservation token key is no longer active");
      }
      return parsed;
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ConflictException("Reservation token is invalid");
    }
  }

  hash(token: string): string {
    return digest(token);
  }

  private secret(): string {
    const value = this.configuration.aiuReservationSigningKey;
    if (value === undefined) {
      throw new ServiceUnavailableException("AIU reservation signing is not configured");
    }
    return value;
  }

  private keyVersion(): string {
    return this.configuration.aiuReservationKeyVersion ?? "current";
  }
}
