import { Inject, Injectable } from "@nestjs/common";

import type { ClickHouseClient } from "@tokenpilot/clickhouse";
import type { DatabaseClient } from "@tokenpilot/db";
import { ClickHouseUserGroupCandidateLoader } from "@tokenpilot/user-segmentation";

import { CLICKHOUSE_CLIENT, DATABASE_CLIENT } from "../tokens.js";
import type { UserGroupCandidate } from "./user-group-evaluator.js";

@Injectable()
export class UserGroupCandidateRepository {
  constructor(
    @Inject(DATABASE_CLIENT) private readonly database: DatabaseClient,
    @Inject(CLICKHOUSE_CLIENT) private readonly clickhouse: ClickHouseClient,
  ) {}

  async load(applicationId: string): Promise<readonly UserGroupCandidate[]> {
    return new ClickHouseUserGroupCandidateLoader(this.database, this.clickhouse).load(
      applicationId,
    );
  }
}

export function presentGroupCandidate(candidate: UserGroupCandidate) {
  const quota = candidate.quota;
  const remaining =
    quota === null ? 0n : quota.limitAiuMicros - quota.consumedAiuMicros - quota.reservedAiuMicros;
  return {
    id: candidate.id,
    user_id: candidate.externalId,
    display_user: candidate.name,
    tags: candidate.tags,
    properties: candidate.propertiesJson,
    status: candidate.status.toLowerCase(),
    last_seen_at: candidate.lastSeenAt.toISOString(),
    calls: candidate.metrics.calls,
    tokens: candidate.metrics.tokens.toString(),
    aiu_micros: candidate.metrics.aiuMicros.toString(),
    cost: candidate.metrics.cost.toString(),
    remaining_aiu_micros: remaining.toString(),
  };
}
