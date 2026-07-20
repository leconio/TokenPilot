import { Registry } from "prom-client";

export function createOpenMetricsRegistry(): Registry<typeof Registry.OPENMETRICS_CONTENT_TYPE> {
  const registry = new Registry<typeof Registry.OPENMETRICS_CONTENT_TYPE>();
  registry.setContentType(Registry.OPENMETRICS_CONTENT_TYPE);
  return registry;
}
