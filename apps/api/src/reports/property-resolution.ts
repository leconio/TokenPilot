import { BadRequestException } from "@nestjs/common";

import { compareUtcDateTimes, isRealUtcDateTime } from "@tokenpilot/contracts";
import { PropertyStatus, type DatabaseClient, type PropertyDataType } from "@tokenpilot/db";

import type { ReportQuery, ResolvedReportFilterCondition } from "./query.js";

const operatorsByType: Readonly<Record<PropertyDataType, ReadonlySet<string>>> = {
  TEXT: new Set(["equals", "not_equals", "contains", "starts_with", "is_set", "is_not_set"]),
  NUMBER: new Set([
    "equals",
    "not_equals",
    "greater_than",
    "greater_or_equal",
    "less_than",
    "less_or_equal",
    "between",
    "is_set",
    "is_not_set",
  ]),
  BOOLEAN: new Set(["equals", "is_set", "is_not_set"]),
  DATETIME: new Set([
    "equals",
    "not_equals",
    "greater_than",
    "greater_or_equal",
    "less_than",
    "less_or_equal",
    "between",
    "is_set",
    "is_not_set",
  ]),
  ENUM: new Set(["equals", "not_equals", "one_of", "is_set", "is_not_set"]),
  TEXT_LIST: new Set(["contains_any", "contains_all", "is_set", "is_not_set"]),
};

function valuesMatch(type: PropertyDataType, values: readonly unknown[]): boolean {
  if (type === "NUMBER") return values.every((value) => typeof value === "number");
  if (type === "BOOLEAN") return values.every((value) => typeof value === "boolean");
  if (type === "DATETIME") {
    return values.every((value) => typeof value === "string" && isRealUtcDateTime(value));
  }
  return values.every((value) => typeof value === "string");
}

export async function resolveReportProperties(
  database: DatabaseClient,
  query: ReportQuery,
): Promise<ReportQuery> {
  const requested = query.filters.filter((condition) => condition.kind === "property");
  const requestedGroups = query.filters.filter(
    (condition) => condition.kind === "builtin" && condition.field === "user_group",
  );
  if (requested.length === 0 && requestedGroups.length === 0 && query.groupProperty === undefined) {
    return query;
  }
  const keys = [
    ...requested.map(({ key }) => key),
    ...(query.groupProperty === undefined ? [] : [query.groupProperty.key]),
  ];
  const definitions = await database.propertyDefinition.findMany({
    where: {
      applicationId: query.applicationId,
      status: PropertyStatus.ACTIVE,
      key: { in: [...new Set(keys)] },
    },
    select: {
      key: true,
      scope: true,
      dataType: true,
      searchable: true,
      groupable: true,
      sensitive: true,
    },
  });
  const indexed = new Map(definitions.map((definition) => [definition.key, definition]));
  const groupIds = requestedGroups.flatMap((condition) =>
    condition.values.filter((value): value is string => typeof value === "string"),
  );
  const groups =
    groupIds.length === 0
      ? []
      : await database.applicationUserGroup.findMany({
          where: {
            applicationId: query.applicationId,
            id: { in: [...new Set(groupIds)] },
            enabled: true,
          },
          select: {
            id: true,
            definitionVersion: true,
            evaluations: {
              orderBy: { evaluatedAt: "desc" },
              take: 1,
              select: {
                definitionVersion: true,
                members: { select: { user: { select: { externalId: true } } } },
              },
            },
          },
        });
  const groupsById = new Map(groups.map((group) => [group.id, group]));
  const filters: ResolvedReportFilterCondition[] = query.filters.map((condition) => {
    if (condition.kind === "builtin" && condition.field === "user_group") {
      if (!["equals", "not_equals", "one_of"].includes(condition.operator)) {
        throw new BadRequestException("User groups only support selection comparisons");
      }
      const selected = condition.values.map((value) =>
        typeof value === "string" ? groupsById.get(value) : undefined,
      );
      if (selected.some((group) => group === undefined)) {
        throw new BadRequestException("A selected user group is not available");
      }
      const userIds = selected.flatMap((group) => {
        const evaluation = group!.evaluations[0];
        if (evaluation === undefined || evaluation.definitionVersion !== group!.definitionVersion) {
          throw new BadRequestException("Refresh the selected user group before using it");
        }
        return evaluation.members.map((member) => member.user.externalId);
      });
      return { ...condition, userIds: [...new Set(userIds)] };
    }
    if (condition.kind === "builtin") return condition;
    const definition = indexed.get(condition.key);
    if (
      definition === undefined ||
      definition.scope.toLowerCase() !== condition.scope ||
      !definition.searchable ||
      definition.sensitive
    ) {
      throw new BadRequestException(`Field ${condition.key} is not available for search`);
    }
    if (!operatorsByType[definition.dataType].has(condition.operator)) {
      throw new BadRequestException(`The selected comparison is not valid for ${condition.key}`);
    }
    if (!valuesMatch(definition.dataType, condition.values)) {
      throw new BadRequestException(`The filter value does not match ${condition.key}`);
    }
    const [start, end] = condition.values;
    const reversedRange =
      condition.operator === "between" &&
      ((definition.dataType === "NUMBER" &&
        typeof start === "number" &&
        typeof end === "number" &&
        start > end) ||
        (definition.dataType === "DATETIME" &&
          typeof start === "string" &&
          typeof end === "string" &&
          compareUtcDateTimes(start, end) > 0));
    if (reversedRange) {
      throw new BadRequestException(`字段 ${condition.key} 的范围起点不能晚于终点`);
    }
    return { ...condition, dataType: definition.dataType };
  });
  if (query.groupProperty === undefined) return { ...query, filters };
  const groupDefinition = indexed.get(query.groupProperty.key);
  if (
    groupDefinition === undefined ||
    groupDefinition.scope.toLowerCase() !== query.groupProperty.scope ||
    !groupDefinition.groupable ||
    groupDefinition.dataType === "TEXT_LIST" ||
    groupDefinition.sensitive
  ) {
    throw new BadRequestException(`Field ${query.groupProperty.key} is not available for grouping`);
  }
  return {
    ...query,
    filters,
    groupProperty: { ...query.groupProperty, dataType: groupDefinition.dataType },
  };
}
