export interface PublishedRuntimeConfigurationMetricRow {
  readonly applicationId: string;
  readonly applicationSlug: string;
  readonly version: number;
}

export type RuntimeConfigurationAcknowledgementState = "APPLIED" | "RECEIVED" | "REJECTED";

export interface RuntimeConfigurationAcknowledgementMetricRow {
  readonly applicationId: string;
  readonly connectorInstanceId: string;
  readonly connectorName: string;
  readonly configurationVersion: number;
  readonly state: RuntimeConfigurationAcknowledgementState;
}

export interface RuntimeConfigurationAcknowledgementMetricState {
  readonly applicationStates: ReadonlyArray<{
    readonly applicationId: string;
    readonly applicationSlug: string;
    readonly acknowledgementsAbsent: 0 | 1;
  }>;
  readonly connectorLags: ReadonlyArray<{
    readonly applicationId: string;
    readonly applicationSlug: string;
    readonly connectorInstanceId: string;
    readonly connectorName: string;
    readonly lag: number;
  }>;
}

/** Acknowledgements must be ordered newest-first, as they are in the metrics query. */
export function calculateRuntimeConfigurationAcknowledgementMetrics(
  publishedConfigurations: readonly PublishedRuntimeConfigurationMetricRow[],
  acknowledgements: readonly RuntimeConfigurationAcknowledgementMetricRow[],
): RuntimeConfigurationAcknowledgementMetricState {
  const currentByApplication = new Map<string, PublishedRuntimeConfigurationMetricRow>();
  for (const configuration of publishedConfigurations) {
    const current = currentByApplication.get(configuration.applicationId);
    if (current === undefined || current.version < configuration.version) {
      currentByApplication.set(configuration.applicationId, configuration);
    }
  }

  const connectorStates = new Map<
    string,
    {
      readonly applicationId: string;
      readonly connectorInstanceId: string;
      readonly connectorName: string;
      readonly latestState: RuntimeConfigurationAcknowledgementState;
      appliedVersion: number | undefined;
    }
  >();
  for (const acknowledgement of acknowledgements) {
    if (!currentByApplication.has(acknowledgement.applicationId)) continue;
    const key = `${acknowledgement.applicationId}\u0000${acknowledgement.connectorInstanceId}`;
    const existing = connectorStates.get(key);
    if (existing === undefined) {
      connectorStates.set(key, {
        applicationId: acknowledgement.applicationId,
        connectorInstanceId: acknowledgement.connectorInstanceId,
        connectorName: acknowledgement.connectorName,
        latestState: acknowledgement.state,
        appliedVersion:
          acknowledgement.state === "APPLIED" ? acknowledgement.configurationVersion : undefined,
      });
    } else if (acknowledgement.state === "APPLIED") {
      existing.appliedVersion = Math.max(
        existing.appliedVersion ?? 0,
        acknowledgement.configurationVersion,
      );
    }
  }

  return {
    applicationStates: [...currentByApplication.values()].map((configuration) => ({
      applicationId: configuration.applicationId,
      applicationSlug: configuration.applicationSlug,
      acknowledgementsAbsent: acknowledgements.some(
        (acknowledgement) => acknowledgement.applicationId === configuration.applicationId,
      )
        ? 0
        : 1,
    })),
    connectorLags: [...connectorStates.values()].flatMap((state) => {
      const configuration = currentByApplication.get(state.applicationId);
      if (configuration === undefined) return [];
      const versionLag = Math.max(0, configuration.version - (state.appliedVersion ?? 0));
      const unhealthyLatestAcknowledgement = state.latestState === "APPLIED" ? 0 : 1;
      return [
        {
          applicationId: state.applicationId,
          applicationSlug: configuration.applicationSlug,
          connectorInstanceId: state.connectorInstanceId,
          connectorName: state.connectorName,
          lag: Math.max(versionLag, unhealthyLatestAcknowledgement),
        },
      ];
    }),
  };
}
