export type FeatureCapability =
  "usage" | "model_catalog" | "aiu" | "quota" | "hard_limit" | "reconciliation";

export type ConsoleCapability = FeatureCapability;

export interface CapabilityState {
  readonly capabilities?: readonly string[];
  readonly feature_flags?: Readonly<Partial<Record<FeatureCapability, boolean>>>;
}

export function hasCapability(
  state: CapabilityState | undefined,
  capability: ConsoleCapability,
): boolean {
  return state?.capabilities?.includes(capability) === true;
}

export function isCapabilityVisible(
  requiredCapability: ConsoleCapability | undefined,
  state: CapabilityState | undefined,
): boolean {
  return requiredCapability === undefined || hasCapability(state, requiredCapability);
}
