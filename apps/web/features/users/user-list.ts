import type { ApplicationUser } from "./types";

export interface ApplicationUserListFilters {
  readonly page: number;
  readonly search: string;
  readonly status: string;
  readonly tag: string;
  readonly groupId: string;
  readonly minCalls: string;
  readonly minTokens: string;
  readonly minAiu: string;
  readonly propertyKey: string;
  readonly propertyValue: string;
  readonly propertyDataType: string;
}

export function applicationUserDisplayName(user: ApplicationUser): string {
  return user.display_user?.trim() || user.user_id;
}

export function applicationUserListParameters(
  filters: ApplicationUserListFilters,
): URLSearchParams {
  const parameters = new URLSearchParams({ page: String(filters.page), limit: "25" });
  if (filters.search) parameters.set("search", filters.search);
  if (filters.status !== "all") parameters.set("status", filters.status);
  if (filters.tag) parameters.set("tag", filters.tag);
  if (filters.groupId !== "all") parameters.set("group_id", filters.groupId);
  if (filters.minCalls) parameters.set("min_calls", filters.minCalls);
  if (filters.minTokens) parameters.set("min_tokens", filters.minTokens);
  if (filters.minAiu) parameters.set("min_aiu", filters.minAiu);
  if (filters.propertyKey && filters.propertyValue) {
    parameters.set("property_key", filters.propertyKey);
    parameters.set(
      "property_value",
      filters.propertyDataType === "DATETIME"
        ? new Date(filters.propertyValue).toISOString()
        : filters.propertyValue,
    );
  }
  return parameters;
}
