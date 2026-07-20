import type { RuntimeUserReservationRequest } from "@tokenpilot/contracts";

import type { AiRuntimeClient } from "./client.js";
import type { ReservationOperationResult } from "./types.js";

export async function withAiuReservation<T>(input: {
  readonly client: AiRuntimeClient;
  readonly reservation: RuntimeUserReservationRequest;
  readonly operation: (reservationToken: string | null) => Promise<T>;
  readonly settledAiuMicros: (value: T) => string;
}): Promise<ReservationOperationResult<T>> {
  const reservation = await input.client.reserveUserAiu(input.reservation);
  const token = reservation.token;
  try {
    const value = await input.operation(token?.token ?? null);
    if (token !== null)
      await input.client.settleUserAiuReservation(token, input.settledAiuMicros(value));
    return { value, reservation };
  } catch (error) {
    if (token !== null) {
      try {
        await input.client.releaseUserAiuReservation(token, "model operation failed");
      } catch {
        // The authoritative reservation expires if release cannot reach the Control Plane.
      }
    }
    throw error;
  }
}
