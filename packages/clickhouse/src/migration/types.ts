export interface ClickHouseMigration {
  readonly version: number;
  readonly name: string;
  readonly fileName: string;
  readonly absolutePath: string;
  readonly checksum: string;
  readonly sql: string;
}

export interface ClickHouseBaselineObject {
  readonly name: string;
  readonly engine: string;
}

export type ClickHouseMigrationState =
  "pending" | "applied" | "checksum_mismatch" | "duplicate_record" | "orphaned";

export interface ClickHouseMigrationStatus {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedChecksum: string | null;
  readonly appliedAt: string | null;
  readonly applicationCount: number;
  readonly state: ClickHouseMigrationState;
}

export type ClickHouseBaselineInstallationState = "empty" | "installed" | "partial_or_conflicting";

export interface ClickHouseBaselineObjectConflict {
  readonly name: string;
  readonly expectedEngine: string;
  readonly actualEngine: string;
}

export interface ClickHouseMigrationStatusReport {
  readonly migrationTableExists: boolean;
  readonly migrationTableReadable: boolean;
  readonly installationState: ClickHouseBaselineInstallationState;
  readonly missingObjects: readonly string[];
  readonly unexpectedObjects: readonly string[];
  readonly conflictingObjects: readonly ClickHouseBaselineObjectConflict[];
  readonly migrations: readonly ClickHouseMigrationStatus[];
}

export interface ClickHouseMigrationUpResult {
  readonly appliedVersions: readonly number[];
  readonly status: ClickHouseMigrationStatusReport;
}
