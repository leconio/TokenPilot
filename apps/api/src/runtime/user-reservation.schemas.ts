import { BadRequestException } from "@nestjs/common";
import type { z } from "zod";
import {
  runtimeUserReservationReleaseSchema,
  runtimeUserReservationRequestSchema,
  runtimeUserReservationSettlementSchema,
} from "@tokenpilot/contracts";

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException(message);
  return result.data;
}

export function parseUserReservation(input: unknown) {
  return parse(runtimeUserReservationRequestSchema, input, "Invalid user AIU reservation request");
}

export function parseUserReservationSettlement(input: unknown) {
  return parse(
    runtimeUserReservationSettlementSchema,
    input,
    "Invalid user AIU settlement request",
  );
}

export function parseUserReservationRelease(input: unknown) {
  return parse(runtimeUserReservationReleaseSchema, input, "Invalid user AIU release request");
}

export type UserReservationRequest = z.infer<typeof runtimeUserReservationRequestSchema>;
