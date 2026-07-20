import { type DynamicModule, Module } from "@nestjs/common";

import type { ApiConfiguration } from "./api-config.js";
import { ApiKeyScopeGuard } from "./auth.js";
import { AuditContextService } from "./audit-context.js";
import { MachineConfigurationBootstrap } from "./bootstrap.service.js";
import { AuditService } from "./audit.service.js";
import { ApplicationController } from "./applications/application.controller.js";
import { ApplicationMembersService } from "./applications/application-members.service.js";
import { ApplicationService } from "./applications/application.service.js";
import { ConnectionController } from "./connections/connection.controller.js";
import { ConnectionService } from "./connections/connection.service.js";
import { ModelController } from "./models/model.controller.js";
import { ModelService } from "./models/model.service.js";
import { ModelPricingController } from "./models/model-pricing.controller.js";
import { ModelPricingService } from "./models/model-pricing.service.js";
import { PropertyController } from "./properties/property.controller.js";
import { PropertyService } from "./properties/property.service.js";
import { RuntimeConfigurationController } from "./runtime-configuration/runtime-configuration.controller.js";
import { RuntimeConfigurationRestoreService } from "./runtime-configuration/runtime-configuration-restore.service.js";
import { RuntimeConfigurationService } from "./runtime-configuration/runtime-configuration.service.js";
import { RuntimeAccessSnapshotService } from "./runtime-configuration/runtime-access-snapshot.service.js";
import { RuntimeConfigurationAcknowledgementController } from "./runtime-configuration/runtime-acknowledgement.controller.js";
import { RuntimeConfigurationAcknowledgementService } from "./runtime-configuration/runtime-acknowledgement.service.js";
import { VirtualModelController } from "./virtual-models/virtual-model.controller.js";
import { VirtualModelService } from "./virtual-models/virtual-model.service.js";
import { ApplicationUserController } from "./users/user.controller.js";
import { ApplicationUserService } from "./users/user.service.js";
import { ApplicationUserMetricsRepository } from "./users/user-metrics.repository.js";
import { ApplicationUserQuotaService } from "./users/user-quota.service.js";
import {
  ApplicationUserGroupActionsService,
  ApplicationUserGroupController,
  ApplicationUserGroupService,
  UserGroupCandidateRepository,
} from "./user-groups/index.js";
import { HealthController, HealthService } from "./health.controller.js";
import { HeartbeatController } from "./heartbeat.controller.js";
import { HeartbeatService } from "./heartbeat.service.js";
import { DlqController } from "./dlq.controller.js";
import { DlqService } from "./dlq.service.js";
import type { ApiInfrastructure } from "./infrastructure.js";
import { InfrastructureShutdown } from "./infrastructure.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";
import { ConnectorMetricsService, MetricsController } from "./metrics.controller.js";
import { RequestDetailsController } from "./request-details.controller.js";
import { RequestDetailsService } from "./request-details.service.js";
import { ServiceKeysController } from "./service-keys.controller.js";
import { ServiceKeysService } from "./service-keys.service.js";
import {
  API_CONFIGURATION,
  CLICKHOUSE_CLIENT,
  DATABASE_CLIENT,
  EXPORT_QUEUE,
  MAINTENANCE_QUEUE,
  REDIS_CLIENT,
  RECONCILIATION_QUEUE,
} from "./tokens.js";
import { UsageIngestionService, USAGE_INGESTION_OPTIONS } from "./usage-ingestion.service.js";
import { UsageController } from "./usage.controller.js";
import { WebAuthController } from "./web-auth.controller.js";
import { WebAuthService } from "./web-auth.service.js";
import { WebDataController } from "./web-data.controller.js";
import { WebDataService } from "./web-data.service.js";
import { BackgroundJobRecoveryService } from "./background-job-recovery.service.js";
import {
  RuntimeSnapshotController,
  RuntimeSnapshotService,
  RuntimeUserReservationService,
  RuntimeUserReservationsController,
} from "./runtime/index.js";
import {
  CurrentReportsController,
  AnalyticsReportRepository,
  ReportsService,
} from "./reports/index.js";
import { SavedReportController } from "./reports/saved-report.controller.js";
import { SavedReportService } from "./reports/saved-report.service.js";
import { ReconciliationController, ReconciliationService } from "./reconciliation/index.js";
import { AiuQuotaPolicyController } from "./quota-policies/quota-policy.controller.js";
import { AiuQuotaPolicyService } from "./quota-policies/quota-policy.service.js";

@Module({})
export class ApiModule {
  static forRoot(
    configuration: ApiConfiguration,
    infrastructure: ApiInfrastructure,
  ): DynamicModule {
    return {
      module: ApiModule,
      controllers: [
        ApplicationController,
        ConnectionController,
        ModelController,
        ModelPricingController,
        PropertyController,
        RuntimeConfigurationController,
        RuntimeConfigurationAcknowledgementController,
        VirtualModelController,
        ApplicationUserController,
        ApplicationUserGroupController,
        HealthController,
        HeartbeatController,
        MetricsController,
        UsageController,
        RequestDetailsController,
        ServiceKeysController,
        DlqController,
        JobsController,
        WebAuthController,
        WebDataController,
        RuntimeSnapshotController,
        RuntimeUserReservationsController,
        CurrentReportsController,
        SavedReportController,
        ReconciliationController,
        AiuQuotaPolicyController,
      ],
      providers: [
        { provide: API_CONFIGURATION, useValue: configuration },
        { provide: DATABASE_CLIENT, useValue: infrastructure.database },
        { provide: REDIS_CLIENT, useValue: infrastructure.redis },
        { provide: EXPORT_QUEUE, useValue: infrastructure.exportQueue },
        { provide: MAINTENANCE_QUEUE, useValue: infrastructure.maintenanceQueue },
        { provide: RECONCILIATION_QUEUE, useValue: infrastructure.reconciliationQueue },
        { provide: CLICKHOUSE_CLIENT, useValue: infrastructure.clickhouse },
        ApiKeyScopeGuard,
        AuditContextService,
        ConnectorMetricsService,
        HealthService,
        HeartbeatService,
        InfrastructureShutdown,
        MachineConfigurationBootstrap,
        BackgroundJobRecoveryService,
        RequestDetailsService,
        AuditService,
        ApplicationService,
        ConnectionService,
        ApplicationMembersService,
        ModelService,
        ModelPricingService,
        PropertyService,
        RuntimeConfigurationService,
        RuntimeAccessSnapshotService,
        RuntimeConfigurationRestoreService,
        RuntimeConfigurationAcknowledgementService,
        VirtualModelService,
        ApplicationUserService,
        ApplicationUserMetricsRepository,
        ApplicationUserQuotaService,
        ApplicationUserGroupService,
        ApplicationUserGroupActionsService,
        UserGroupCandidateRepository,
        ServiceKeysService,
        {
          provide: USAGE_INGESTION_OPTIONS,
          useValue: {
            maxBatchSize: configuration.maxBatchSize,
            maxBatchBytes: configuration.maxDecompressedBytes,
          },
        },
        UsageIngestionService,
        DlqService,
        JobsService,
        WebAuthService,
        WebDataService,
        RuntimeSnapshotService,
        RuntimeUserReservationService,
        AnalyticsReportRepository,
        ReportsService,
        SavedReportService,
        ReconciliationService,
        AiuQuotaPolicyService,
      ],
    };
  }
}
