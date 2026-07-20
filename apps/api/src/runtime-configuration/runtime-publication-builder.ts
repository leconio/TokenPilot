import { BadRequestException } from "@nestjs/common";

import {
  modelCapabilitiesSchema,
  runtimeCallConnectionSchema,
  virtualModelRouteMatchSchema,
  type RuntimeCallConnection,
  type RuntimeRoute,
  type RuntimeRouteTarget,
  type RuntimeRoutingRule,
  type RuntimeSnapshot,
} from "@tokenpilot/contracts";
import type { Prisma } from "@tokenpilot/db";

import { resolveRuntimeMatch, type RouteAudience } from "../virtual-models/route-matches.js";
import {
  runtimeFingerprint,
  signRuntimeSnapshot,
  type UnsignedRuntimeSnapshot,
} from "./runtime-snapshot-integrity.js";

export const runtimeVirtualModelInclude = {
  application: { select: { timezone: true } },
  defaultModel: { include: { connection: true } },
  targets: {
    where: { enabled: true },
    include: { model: { include: { connection: true } } },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
  },
  rules: {
    where: { enabled: true },
    include: { targetModel: { include: { connection: true } } },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  },
} satisfies Prisma.VirtualModelInclude;

type VirtualModelRow = Prisma.VirtualModelGetPayload<{
  include: typeof runtimeVirtualModelInclude;
}>;
type TargetRow = VirtualModelRow["targets"][number];

interface PublicationIssue {
  readonly code: string;
  readonly message: string;
  readonly object_type: "connection" | "virtual_model";
  readonly object_id: string;
  readonly object_name: string;
}

interface ConnectionRow {
  readonly id: string;
  readonly name: string;
  readonly driver: string;
  readonly baseUrl: string | null;
  readonly credentialRef: string | null;
  readonly publicConfigJson: unknown;
}

function publicationFailure(issues: readonly PublicationIssue[]): BadRequestException {
  return new BadRequestException({
    code: "PUBLICATION_VALIDATION_FAILED",
    message: "The routing configuration has problems that must be fixed before publishing.",
    issues,
  });
}

function routeTarget(target: TargetRow, routeTag: string, order: number): RuntimeRouteTarget {
  const capabilities = modelCapabilitiesSchema.safeParse(target.model.capabilitiesJson);
  if (!capabilities.success) {
    throw new BadRequestException(`Model ${target.model.requestModel} has invalid capabilities`);
  }
  return {
    model_id: target.model.id,
    connection_id: target.model.connection.id,
    request_model: target.model.requestModel,
    provider: target.model.provider,
    task_type: target.model.taskType.toLowerCase() as RuntimeRouteTarget["task_type"],
    capabilities: capabilities.data,
    route_tag: routeTag,
    fallback_order: order,
    weight: target.weight.toNumber(),
  };
}

function activeTargets(targets: readonly TargetRow[]): readonly TargetRow[] {
  return targets.filter((target) => target.model.enabled && target.model.connection.enabled);
}

function runtimeConnection(row: ConnectionRow): RuntimeCallConnection {
  const config =
    typeof row.publicConfigJson === "object" &&
    row.publicConfigJson !== null &&
    !Array.isArray(row.publicConfigJson)
      ? (row.publicConfigJson as Record<string, unknown>)
      : {};
  const driver = row.driver.toLowerCase();
  const parsed = runtimeCallConnectionSchema.safeParse({
    id: row.id,
    name: row.name,
    driver,
    base_url: row.baseUrl,
    credential_ref: row.credentialRef,
    timeout_ms: typeof config.timeout_ms === "number" ? config.timeout_ms : 60_000,
    max_retries: typeof config.max_retries === "number" ? config.max_retries : 2,
    ...(driver === "anthropic"
      ? { api_version: typeof config.api_version === "string" ? config.api_version : null }
      : {}),
  });
  if (!parsed.success) throw new BadRequestException(`Connection ${row.name} cannot be published`);
  return parsed.data;
}

function pushVirtualModelIssues(
  issues: PublicationIssue[],
  virtualModel: VirtualModelRow,
  targets: readonly TargetRow[],
): number {
  const start = issues.length;
  const issue = (code: string, message: string) =>
    issues.push({
      code,
      message,
      object_type: "virtual_model",
      object_id: virtualModel.id,
      object_name: virtualModel.displayName,
    });
  if (targets.length === 0)
    issue("VIRTUAL_MODEL_HAS_NO_ROUTE", `${virtualModel.displayName} has no available real model.`);
  if (!targets.some((target) => target.model.id === virtualModel.defaultModelId)) {
    issue(
      "VIRTUAL_MODEL_DEFAULT_UNAVAILABLE",
      `${virtualModel.displayName} has no available preferred real model.`,
    );
  }
  if (targets.some((target) => target.model.taskType !== virtualModel.taskType)) {
    issue(
      "VIRTUAL_MODEL_TASK_MISMATCH",
      `${virtualModel.displayName} contains real models with a different task type.`,
    );
  }
  if (
    targets.some(
      (target) => !modelCapabilitiesSchema.safeParse(target.model.capabilitiesJson).success,
    )
  ) {
    issue(
      "MODEL_CAPABILITIES_INVALID",
      `${virtualModel.displayName} contains real models with invalid capabilities.`,
    );
  }
  return start;
}

function buildRules(
  virtualModel: VirtualModelRow,
  targets: readonly TargetRow[],
  audience: RouteAudience,
  issues: PublicationIssue[],
): RuntimeRoutingRule[] {
  const rules: RuntimeRoutingRule[] = [];
  const priorities = new Set<number>();
  const issue = (code: string, message: string) =>
    issues.push({
      code,
      message,
      object_type: "virtual_model",
      object_id: virtualModel.id,
      object_name: virtualModel.displayName,
    });
  for (const [index, rule] of virtualModel.rules.entries()) {
    if (priorities.has(rule.priority)) {
      issue(
        "ROUTE_PRIORITY_DUPLICATE",
        `${virtualModel.displayName} contains route conditions with the same priority.`,
      );
      continue;
    }
    priorities.add(rule.priority);
    const match = virtualModelRouteMatchSchema.safeParse(rule.matchJson);
    if (!match.success) {
      issue(
        "ROUTE_CONDITION_INVALID",
        `${virtualModel.displayName} contains a route condition that cannot be published.`,
      );
      continue;
    }
    let runtimeMatch: RuntimeRoutingRule["match"];
    try {
      runtimeMatch = resolveRuntimeMatch(match.data, audience);
    } catch {
      issue(
        "USER_GROUP_SNAPSHOT_MISSING",
        `${virtualModel.displayName} contains a user-group condition without a current member list.`,
      );
      continue;
    }
    const selected = targets.find((target) => target.model.id === rule.targetModelId);
    if (selected === undefined || !rule.targetModel.enabled) {
      issue(
        "ROUTE_TARGET_UNAVAILABLE",
        `${virtualModel.displayName} contains a condition for an unavailable real model.`,
      );
      continue;
    }
    const routeTag = `cp:virtual:${virtualModel.name}:rule${index + 1}`;
    rules.push({
      id: rule.id,
      priority: rule.priority,
      match: runtimeMatch,
      route: {
        route_tag: routeTag,
        selection_mode: "ordered",
        targets: [selected, ...targets.filter((candidate) => candidate.id !== selected.id)].map(
          (candidate, order) => routeTarget(candidate, routeTag, order),
        ),
      },
      ...(rule.expiresAt === null ? {} : { expires_at: rule.expiresAt.toISOString() }),
    });
  }
  return rules;
}

export function buildRuntimePublication(input: {
  readonly application: { readonly id: string; readonly slug: string; readonly enabled: boolean };
  readonly settings: { readonly featureAiu: boolean; readonly featureHardLimit: boolean } | null;
  readonly properties: readonly { readonly key: string }[];
  readonly connections: readonly ConnectionRow[];
  readonly virtualModels: readonly VirtualModelRow[];
  readonly audience: RouteAudience;
  readonly version: number;
  readonly now: Date;
}): { readonly snapshot: RuntimeSnapshot; readonly routing: RuntimeSnapshot["routing"] } {
  const { application, audience, version, now } = input;
  const issues: PublicationIssue[] = [];
  if (input.virtualModels.length === 0) {
    issues.push({
      code: "NO_ENABLED_VIRTUAL_MODEL",
      message: "Enable at least one virtual model before publishing.",
      object_type: "virtual_model",
      object_id: application.id,
      object_name: application.slug,
    });
  }
  const connections: Record<string, RuntimeCallConnection> = {};
  for (const connection of input.connections) {
    try {
      connections[connection.id] = runtimeConnection(connection);
    } catch {
      issues.push({
        code: "CONNECTION_CONFIGURATION_INVALID",
        message: `${connection.name} has an invalid public connection configuration.`,
        object_type: "connection",
        object_id: connection.id,
        object_name: connection.name,
      });
    }
  }
  const publishedAt = now.toISOString();
  const routing: RuntimeSnapshot["routing"] = {};
  for (const virtualModel of input.virtualModels) {
    const targets = activeTargets(virtualModel.targets);
    const issueStart = pushVirtualModelIssues(issues, virtualModel, targets);
    if (issues.length > issueStart) continue;
    const defaultIndex = targets.findIndex(
      (target) => target.model.id === virtualModel.defaultModelId,
    );
    const ordered = [
      targets[defaultIndex]!,
      ...targets.filter((_, index) => index !== defaultIndex),
    ];
    const routeTag = `cp:virtual:${virtualModel.name}:default`;
    const route: RuntimeRoute = {
      route_tag: routeTag,
      selection_mode: ordered.some((target) => target.weight.toNumber() !== 1)
        ? "weighted"
        : "ordered",
      targets: ordered.map((target, index) => routeTarget(target, routeTag, index)),
    };
    const rules = buildRules(virtualModel, targets, audience, issues);
    routing[virtualModel.name] = {
      virtual_model_id: virtualModel.id,
      configuration_version: version,
      configuration_etag: runtimeFingerprint({
        application_id: application.id,
        version,
        virtual_model_id: virtualModel.id,
        default: route,
        rules,
      }),
      published_at: publishedAt,
      timezone: virtualModel.application.timezone,
      default: route,
      rules,
    };
  }
  if (issues.length > 0) throw publicationFailure(issues);
  const base: UnsignedRuntimeSnapshot = {
    schema_version: "2.0",
    application_id: application.id,
    version: `runtime-${application.slug}-${version}`,
    expires_at: new Date(now.getTime() + 10 * 365 * 86_400_000).toISOString(),
    connections,
    routing,
    aiu: {
      enabled: input.settings?.featureAiu ?? false,
      mode: input.settings?.featureAiu
        ? input.settings.featureHardLimit
          ? "hard_limit"
          : "observe"
        : "disabled",
      unrated_model_policy: "allow_unrated",
    },
    access: {
      application_enabled: application.enabled,
      blocked_user_ids: audience.users
        .filter((user) => user.status === "BLOCKED")
        .map((user) => user.externalId),
    },
    dimensions: { analytics_allowed_keys: input.properties.map((property) => property.key) },
  };
  return { snapshot: signRuntimeSnapshot(base), routing };
}
