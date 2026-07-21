import { performance } from "node:perf_hooks";

import type { UsageEvent } from "@tokenpilot/contracts";
import { ulid } from "ulid";

import { AiControlSdkError } from "../errors.js";
import {
  chatTargets,
  eventFor,
  mergeUsage,
  mutableProperties,
  type ChatEnvironment,
} from "./chat-common.js";
import { requireAiContext } from "./context.js";
import {
  AiProviderRequestError,
  providerFailure,
  requestProviderStream,
} from "./provider-transport.js";
import type { AiChatAttempt, AiChatInput, AiChatStream } from "./types.js";

export function executeChatStream<T>(
  input: AiChatInput,
  environment: ChatEnvironment,
): AiChatStream<T> {
  return (async function* stream(): AiChatStream<T> {
    const context = requireAiContext();
    if (input.messages.length === 0) throw new TypeError("chat messages cannot be empty");
    const route = environment.selectRoute(input.model, {
      userId: context.userId,
      userProperties: context.userProperties,
      selectionKey: context.requestId,
      ...(context.callSource === null ? {} : { callSource: context.callSource }),
    });
    const targets = chatTargets(route, input, true);
    if (environment.snapshot.aiu.mode === "hard_limit" && input.estimatedAiuMicros === undefined) {
      throw new AiControlSdkError(
        "SDK_AIU_ESTIMATE_REQUIRED",
        "estimatedAiuMicros is required while the hard AIU limit is enabled.",
      );
    }
    const reservation = await environment.reserve({
      user_id: context.userId,
      ...(context.displayUser === null ? {} : { display_user: context.displayUser }),
      ...(Object.keys(context.userProperties).length === 0
        ? {}
        : { user_properties: mutableProperties(context.userProperties) }),
      operation_id: context.operationId,
      virtual_model: input.model,
      candidate_model_ids: targets.map((target) => target.model_id),
      estimated_aiu_micros: input.estimatedAiuMicros ?? "0",
    });
    const events: UsageEvent[] = [];
    const attempts: AiChatAttempt[] = [];
    let lastError: AiProviderRequestError | null = null;
    let attemptIndex = 0;
    for (const [targetIndex, target] of targets.entries()) {
      const connection = environment.snapshot.connections[target.connection_id];
      if (connection === undefined) {
        lastError = new AiProviderRequestError(
          "Published route references an unknown connection.",
          null,
          "failure",
          false,
        );
        break;
      }
      const adapter = environment.adapterFor(connection);
      let credential: string;
      try {
        credential =
          adapter?.requiresCredential === false
            ? ""
            : await environment.resolveCredential(connection);
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error("Connection credential resolution failed.");
        environment.onError(failure);
        lastError = new AiProviderRequestError(failure.message, null, "failure", true);
        continue;
      }
      for (let retry = 0; retry <= connection.max_retries; retry += 1) {
        const attemptId = `att_${ulid(environment.now().getTime())}`;
        const started = performance.now();
        let usage: UsageEvent["usage"] = { request_count: "1" };
        let sourceCost: UsageEvent["source_cost"] = null;
        let emitted = false;
        let completed = false;
        let streamError: unknown;
        try {
          const provider = await requestProviderStream<T>(
            input,
            target,
            connection,
            credential,
            environment.providerFetch,
            adapter,
          );
          try {
            for await (const part of provider.stream) {
              emitted = true;
              usage = mergeUsage(usage, part.usage);
              if (part.sourceCost !== undefined) sourceCost = part.sourceCost;
              yield part.value;
            }
            completed = true;
          } catch (error) {
            streamError = error;
          } finally {
            if (!completed && streamError === undefined) {
              const attempt: AiChatAttempt = {
                attemptId,
                attemptIndex,
                target,
                connection,
                status: "cancelled",
                httpStatus: provider.status,
                latencyMs: Math.max(0, Math.round(performance.now() - started)),
              };
              attempts.push(attempt);
              events.push(
                eventFor(environment, {
                  route,
                  target,
                  prior: targets[targetIndex - 1],
                  attemptIndex,
                  attemptId,
                  operationId: context.operationId,
                  connection,
                  status: "cancelled",
                  httpStatus: provider.status,
                  latencyMs: attempt.latencyMs,
                  usage,
                  final: true,
                  reservationId: reservation.token?.id ?? null,
                }),
              );
              if (reservation.token !== null) {
                try {
                  await environment.release(reservation.token, "stream was cancelled");
                } catch (error) {
                  environment.onError(
                    error instanceof Error ? error : new Error("AIU release failed"),
                  );
                }
              }
              try {
                await environment.report(events);
              } catch (error) {
                environment.onError(
                  error instanceof Error ? error : new Error("Usage upload failed"),
                );
              }
            }
          }
          if (streamError !== undefined) throw streamError;
          const latencyMs = Math.max(0, Math.round(performance.now() - started));
          attempts.push({
            attemptId,
            attemptIndex,
            target,
            connection,
            status: "success",
            httpStatus: provider.status,
            latencyMs,
          });
          events.push(
            eventFor(environment, {
              route,
              target,
              prior: targets[targetIndex - 1],
              attemptIndex,
              attemptId,
              operationId: context.operationId,
              connection,
              status: "success",
              httpStatus: provider.status,
              latencyMs,
              usage,
              sourceCost,
              final: true,
              reservationId: reservation.token?.id ?? null,
            }),
          );
          try {
            await environment.report(events);
          } catch (error) {
            environment.onError(error instanceof Error ? error : new Error("Usage upload failed"));
          }
          if (reservation.token !== null) {
            try {
              await environment.settle(reservation.token, input.estimatedAiuMicros ?? "0");
            } catch (error) {
              environment.onError(
                error instanceof Error ? error : new Error("AIU settlement failed"),
              );
            }
          }
          return Object.freeze({
            response: null,
            virtualModel: route.virtualModel,
            target,
            connection,
            attempts: Object.freeze(attempts),
            operationId: context.operationId,
          });
        } catch (error) {
          const classified = providerFailure(
            error,
            input,
            input.signal ?? new AbortController().signal,
          );
          const failure =
            emitted && classified.retryable
              ? new AiProviderRequestError(
                  classified.message,
                  classified.status,
                  classified.kind,
                  false,
                )
              : classified;
          lastError = failure;
          const latencyMs = Math.max(0, Math.round(performance.now() - started));
          const final =
            !failure.retryable ||
            (targetIndex === targets.length - 1 && retry === connection.max_retries);
          attempts.push({
            attemptId,
            attemptIndex,
            target,
            connection,
            status: failure.kind,
            httpStatus: failure.status,
            latencyMs,
          });
          events.push(
            eventFor(environment, {
              route,
              target,
              prior: targets[targetIndex - 1],
              attemptIndex,
              attemptId,
              operationId: context.operationId,
              connection,
              status: failure.kind,
              httpStatus: failure.status,
              latencyMs,
              usage,
              final,
              reservationId: reservation.token?.id ?? null,
            }),
          );
          attemptIndex += 1;
          if (!failure.retryable) break;
        }
      }
      if (lastError?.retryable === false) break;
    }
    if (reservation.token !== null) {
      try {
        await environment.release(reservation.token, "all model attempts failed");
      } catch (error) {
        environment.onError(error instanceof Error ? error : new Error("AIU release failed"));
      }
    }
    try {
      await environment.report(events);
    } catch (error) {
      environment.onError(error instanceof Error ? error : new Error("Usage upload failed"));
    }
    throw new AiControlSdkError(
      "SDK_MODEL_REQUEST_FAILED",
      lastError?.message ?? "No model target could be called.",
    );
  })();
}
