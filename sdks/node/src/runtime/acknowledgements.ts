import {
  runtimeConfigurationAcknowledgementSchema,
  type RuntimeConfigurationAcknowledgement,
} from "@tokenpilot/contracts";
import { ulid } from "ulid";

import { AiControlSdkError } from "../errors.js";

export type RuntimeAcknowledgementState = "received" | "applied" | "rejected";

export interface RuntimeSdkIdentity {
  readonly instanceId: string;
  readonly version: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function configurationReferences(value: unknown): readonly {
  readonly applicationId: string;
  readonly configurationVersion: number;
  readonly configurationEtag: string;
}[] {
  const snapshot = record(value);
  const routing = snapshot?.routing;
  const plans = record(routing);
  if (plans === null) return [];
  const versions = new Set<number>();
  for (const rawPlan of Object.values(plans)) {
    const plan = record(rawPlan);
    const version = plan?.configuration_version;
    if (typeof version === "number" && Number.isSafeInteger(version) && version > 0) {
      versions.add(version);
    }
  }
  const [configurationVersion] = [...versions];
  const configurationEtag = snapshot?.etag;
  const applicationId = snapshot?.application_id;
  if (
    versions.size !== 1 ||
    configurationVersion === undefined ||
    typeof applicationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      applicationId,
    ) ||
    typeof configurationEtag !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(configurationEtag)
  ) {
    return [];
  }
  return [{ applicationId, configurationVersion, configurationEtag }];
}

export function runtimeAcknowledgements(
  value: unknown,
  state: RuntimeAcknowledgementState,
  identity: RuntimeSdkIdentity,
  now: Date,
  error?: Error,
): readonly RuntimeConfigurationAcknowledgement[] {
  return configurationReferences(value).map(
    ({ applicationId, configurationVersion, configurationEtag }) =>
      runtimeConfigurationAcknowledgementSchema.parse({
        schema_version: "2.0",
        application_id: applicationId,
        acknowledgement_id: ulid(now.getTime()),
        acknowledged_at: now.toISOString(),
        connector: { instance_id: identity.instanceId, name: "node", version: identity.version },
        configuration_version: configurationVersion,
        configuration_etag: configurationEtag,
        state,
        applied_at: state === "applied" ? now.toISOString() : null,
        error:
          state === "rejected"
            ? {
                code: "SDK_RUNTIME_SNAPSHOT_REJECTED",
                message: (error?.message ?? "Runtime Snapshot was rejected").slice(0, 500),
              }
            : null,
      }),
  );
}

function errorValue(value: unknown): Error {
  return value instanceof Error ? value : new Error("Unknown acknowledgement failure");
}

export class RuntimeAcknowledgementQueue {
  readonly #controlPlaneUrl: string;
  readonly #apiKey: string;
  readonly #identity: RuntimeSdkIdentity;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #onError: (error: Error) => void;
  readonly #pending: RuntimeConfigurationAcknowledgement[] = [];

  public constructor(options: {
    readonly controlPlaneUrl: string;
    readonly apiKey: string;
    readonly identity: RuntimeSdkIdentity;
    readonly fetch: typeof fetch;
    readonly now: () => Date;
    readonly onError: (error: Error) => void;
  }) {
    if (options.identity.instanceId.length < 1 || options.identity.instanceId.length > 256) {
      throw new AiControlSdkError(
        "SDK_INVALID_CONFIGURATION",
        "SDK instanceId must contain between 1 and 256 characters.",
      );
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(options.identity.version)) {
      throw new AiControlSdkError("SDK_INVALID_CONFIGURATION", "sdkVersion must be semantic.");
    }
    this.#controlPlaneUrl = options.controlPlaneUrl;
    this.#apiKey = options.apiKey;
    this.#identity = options.identity;
    this.#fetch = options.fetch;
    this.#now = options.now;
    this.#onError = options.onError;
  }

  public queue(value: unknown, state: RuntimeAcknowledgementState, error?: Error): void {
    this.#pending.push(
      ...runtimeAcknowledgements(value, state, this.#identity, this.#now(), error),
    );
  }

  public async flush(required: boolean): Promise<void> {
    while (this.#pending.length > 0) {
      try {
        const response = await this.#fetch(
          `${this.#controlPlaneUrl}/runtime/configuration-acknowledgements`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.#apiKey}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(this.#pending[0]),
          },
        );
        if (!response.ok) {
          throw new AiControlSdkError(
            "SDK_RUNTIME_ACK_FAILED",
            `Control Plane rejected runtime configuration acknowledgement with HTTP ${response.status}.`,
          );
        }
        this.#pending.shift();
      } catch (error) {
        const failure = errorValue(error);
        if (required) throw failure;
        this.#onError(failure);
        return;
      }
    }
  }
}
