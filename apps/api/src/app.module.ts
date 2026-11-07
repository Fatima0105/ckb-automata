import { Module, type DynamicModule } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";

import type { AutomataEnvironment } from "@ckb-automata/config";
import { deploymentRegistry, type OperatorAutomationDeployment } from "@ckb-automata/core";

import { CkbClient, createCkbClient } from "./ckb-client.ts";
import { AuthController, AuthService } from "./auth.ts";
import { DatabaseClient, createDatabaseClient } from "./database/client.ts";
import {
  DaoHarvestController,
  DaoHarvestMutationService,
  DaoHarvestPendingService,
  DaoHarvestReadService,
  DaoHarvestTransactionAdapter,
} from "./dao-harvest.ts";
import {
  DaoHarvestV2Controller,
  DaoHarvestV2MutationService,
  DaoHarvestV2PendingService,
  DaoHarvestV2ReadService,
  PostgresDaoHarvestV2PendingSource,
} from "./dao-harvest-v2.ts";
import { DaoHarvestV2TransactionAdapter } from "./dao-harvest-v2-adapter.ts";
import {
  loadVerifiedDaoHarvestV2Deployments,
  type VerifiedDaoHarvestV2Deployment,
} from "./dao-harvest-v2-manifest.ts";
import {
  ActivityController,
  JobEventStreamController,
  JobEventStreamService,
  JobEventsController,
  JobEventsService,
} from "./events.ts";
import { HealthController, HealthService, createDefaultHealthProbes } from "./health.ts";
import { CanonicalCheckpointStore } from "./indexer/checkpoints.ts";
import { JobCellDiscovery } from "./indexer/job-discovery.ts";
import { JobTransitionIndexer } from "./indexer/job-transitions.ts";
import { CanonicalBlockProjector, JobProjectionRollback } from "./indexer/reorg.ts";
import { DaoHarvestProjectionStore } from "./indexer/dao-harvest-projection.ts";
import { DaoHarvestV2RevisionIndexer } from "./indexer/dao-harvest-v2-indexer.ts";
import { DaoHarvestV2ProjectionStore } from "./indexer/dao-harvest-v2-store.ts";
import { LiveJobReconciler } from "./indexer/reconciliation.ts";
import { LiveIndexerRuntime } from "./indexer/runtime.ts";
import {
  AccountJobsController,
  JobReadService,
  JobsController,
  TemplatesController,
} from "./jobs.ts";
import { NetworkMetadataController, NetworkMetadataService } from "./network-metadata.ts";
import {
  OperatorRegistryController,
  OperatorRegistryMonitor,
  OperatorRegistryService,
  PostgresOperatorRegistryRepository,
} from "./operators.ts";
import { PendingCreationController, PendingCreationService } from "./pending-creations.ts";
import {
  NotificationPreferencesController,
  NotificationPreferencesService,
} from "./preferences.ts";
import { JobQuoteController, JobQuoteService } from "./quotes.ts";
import { PostgresLockResolutionRecorder } from "./lock-resolutions.ts";
import { TransactionBuildService, TransactionController } from "./transactions.ts";
import { loadOperatorAutomationDeployment } from "./operator-automation-manifest.ts";
import {
  TransactionProgressController,
  TransactionProgressService,
  TransactionProgressStreamService,
} from "./transaction-progress.ts";
import { ApiTelemetryInterceptor, BackendTelemetry, MetricsController } from "./telemetry.ts";
import { WebhookController, WebhookService } from "./webhooks.ts";

const DAO_HARVEST_V2_DEPLOYMENT = Symbol("DAO_HARVEST_V2_DEPLOYMENT");
const DAO_HARVEST_V2_INDEXER = Symbol("DAO_HARVEST_V2_INDEXER");
const OPERATOR_AUTOMATION_DEPLOYMENT = Symbol("OPERATOR_AUTOMATION_DEPLOYMENT");

// Nest uses the class identity as the root dependency-injection module token.
// oxlint-disable-next-line typescript/no-extraneous-class
export class AppModule {}

Module({
  controllers: [
    HealthController,
    AuthController,
    NotificationPreferencesController,
    WebhookController,
    MetricsController,
    NetworkMetadataController,
    OperatorRegistryController,
    JobsController,
    AccountJobsController,
    TemplatesController,
    ActivityController,
    JobEventsController,
    JobEventStreamController,
    JobQuoteController,
    TransactionController,
    PendingCreationController,
    TransactionProgressController,
    DaoHarvestController,
    DaoHarvestV2Controller,
  ],
})(AppModule);

export function createAppModule(environment: AutomataEnvironment): DynamicModule {
  return {
    module: AppModule,
    providers: [
      {
        provide: BackendTelemetry,
        useFactory: () => new BackendTelemetry(environment),
      },
      {
        provide: APP_INTERCEPTOR,
        inject: [BackendTelemetry],
        useFactory: (telemetry: BackendTelemetry) => new ApiTelemetryInterceptor(telemetry),
      },
      {
        provide: CkbClient,
        inject: [BackendTelemetry],
        useFactory: (telemetry: BackendTelemetry) =>
          createCkbClient({
            rpcEndpoints: [environment.CKB_RPC_URL],
            indexerEndpoints: [environment.CKB_INDEXER_URL],
            metrics: telemetry.metrics,
            telemetry: telemetry.runtime,
          }),
      },
      {
        provide: DatabaseClient,
        useFactory: () => createDatabaseClient(environment.DATABASE_URL),
      },
      {
        provide: DAO_HARVEST_V2_DEPLOYMENT,
        inject: [CkbClient],
        useFactory: async (
          ckbClient: CkbClient,
        ): Promise<readonly VerifiedDaoHarvestV2Deployment[] | undefined> => {
          const path = environment.DAO_HARVEST_V2_MANIFEST_PATH;
          return path === undefined
            ? undefined
            : loadVerifiedDaoHarvestV2Deployments(path, ckbClient, environment.CKB_GENESIS_HASH);
        },
      },
      {
        provide: OPERATOR_AUTOMATION_DEPLOYMENT,
        inject: [CkbClient],
        useFactory: async (
          ckbClient: CkbClient,
        ): Promise<OperatorAutomationDeployment | undefined> => {
          const path = environment.OPERATOR_AUTOMATION_MANIFEST_PATH;
          return path === undefined
            ? undefined
            : loadOperatorAutomationDeployment(path, ckbClient, environment.CKB_GENESIS_HASH);
        },
      },
      {
        provide: AuthService,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new AuthService(databaseClient.database, environment),
      },
      {
        provide: OperatorRegistryService,
        inject: [
          DatabaseClient,
          AuthService,
          DAO_HARVEST_V2_DEPLOYMENT,
          OPERATOR_AUTOMATION_DEPLOYMENT,
        ],
        useFactory: (
          databaseClient: DatabaseClient,
          auth: AuthService,
          harvestDeployments: readonly VerifiedDaoHarvestV2Deployment[] | undefined,
          paymentDeployment: OperatorAutomationDeployment | undefined,
        ) =>
          new OperatorRegistryService(
            new PostgresOperatorRegistryRepository(databaseClient.database),
            auth,
            environment,
            {
              harvestManifestHashes: new Set(
                (harvestDeployments ?? []).map(({ manifestSha256 }) => manifestSha256),
              ),
              ...(paymentDeployment === undefined
                ? {}
                : { paymentManifestSha256: paymentDeployment.manifestSha256 }),
            },
          ),
      },
      {
        provide: OperatorRegistryMonitor,
        inject: [OperatorRegistryService],
        useFactory: (operators: OperatorRegistryService) =>
          new OperatorRegistryMonitor(operators, environment.AUTOMATA_PROFILE === "testnet-public"),
      },
      {
        provide: NotificationPreferencesService,
        inject: [DatabaseClient, AuthService],
        useFactory: (databaseClient: DatabaseClient, auth: AuthService) =>
          new NotificationPreferencesService(databaseClient.database, auth, environment),
      },
      {
        provide: WebhookService,
        inject: [DatabaseClient, AuthService, BackendTelemetry],
        useFactory: (
          databaseClient: DatabaseClient,
          auth: AuthService,
          telemetry: BackendTelemetry,
        ) =>
          new WebhookService(databaseClient.database, auth, environment, {
            metrics: telemetry.metrics,
          }),
      },
      {
        provide: CanonicalCheckpointStore,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new CanonicalCheckpointStore(databaseClient.database),
      },
      {
        provide: JobCellDiscovery,
        inject: [DatabaseClient, CkbClient, OPERATOR_AUTOMATION_DEPLOYMENT],
        useFactory: (
          databaseClient: DatabaseClient,
          ckbClient: CkbClient,
          operatorDeployment: OperatorAutomationDeployment | undefined,
        ) => new JobCellDiscovery(databaseClient.database, ckbClient, operatorDeployment),
      },
      {
        provide: JobTransitionIndexer,
        inject: [DatabaseClient, CkbClient],
        useFactory: (databaseClient: DatabaseClient, ckbClient: CkbClient) =>
          new JobTransitionIndexer(databaseClient.database, ckbClient),
      },
      {
        provide: JobProjectionRollback,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new JobProjectionRollback(databaseClient.database),
      },
      {
        provide: DaoHarvestProjectionStore,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new DaoHarvestProjectionStore(databaseClient.database),
      },
      {
        provide: DaoHarvestV2ProjectionStore,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new DaoHarvestV2ProjectionStore(databaseClient.database),
      },
      {
        provide: DAO_HARVEST_V2_INDEXER,
        inject: [CkbClient, DaoHarvestV2ProjectionStore, DAO_HARVEST_V2_DEPLOYMENT],
        useFactory: (
          ckbClient: CkbClient,
          store: DaoHarvestV2ProjectionStore,
          loaded: readonly VerifiedDaoHarvestV2Deployment[] | undefined,
        ) =>
          loaded === undefined
            ? undefined
            : new DaoHarvestV2RevisionIndexer(
                ckbClient,
                store,
                environment.CKB_NETWORK,
                loaded.map(({ deployment }) => deployment),
              ),
      },
      {
        provide: DaoHarvestV2ReadService,
        inject: [DatabaseClient, CkbClient],
        useFactory: (databaseClient: DatabaseClient, ckbClient: CkbClient) =>
          new DaoHarvestV2ReadService(
            databaseClient.database,
            environment.CKB_NETWORK,
            new DaoHarvestV2PendingService(
              new PostgresDaoHarvestV2PendingSource(
                databaseClient.database,
                environment.CKB_NETWORK,
                ckbClient,
              ),
            ),
          ),
      },
      {
        provide: DaoHarvestV2MutationService,
        inject: [CkbClient, DatabaseClient, DAO_HARVEST_V2_DEPLOYMENT],
        useFactory: (
          ckbClient: CkbClient,
          databaseClient: DatabaseClient,
          loaded: readonly VerifiedDaoHarvestV2Deployment[] | undefined,
        ) =>
          new DaoHarvestV2MutationService(
            loaded === undefined
              ? undefined
              : new DaoHarvestV2TransactionAdapter(
                  ckbClient,
                  loaded.map(({ deployment }) => deployment),
                  databaseClient.database,
                  environment.CKB_NETWORK,
                ),
          ),
      },
      {
        provide: CanonicalBlockProjector,
        inject: [
          CkbClient,
          CanonicalCheckpointStore,
          JobProjectionRollback,
          JobCellDiscovery,
          JobTransitionIndexer,
          DaoHarvestProjectionStore,
          DAO_HARVEST_V2_INDEXER,
          BackendTelemetry,
        ],
        useFactory: (
          ckbClient: CkbClient,
          checkpoints: CanonicalCheckpointStore,
          rollback: JobProjectionRollback,
          discovery: JobCellDiscovery,
          transitions: JobTransitionIndexer,
          daoHarvest: DaoHarvestProjectionStore,
          daoHarvestV2: DaoHarvestV2RevisionIndexer | undefined,
          telemetry: BackendTelemetry,
        ) =>
          new CanonicalBlockProjector(ckbClient, checkpoints, rollback, discovery, transitions, {
            metrics: telemetry.metrics,
            telemetry: telemetry.runtime,
            daoHarvest,
            ...(daoHarvestV2 === undefined ? {} : { daoHarvestV2 }),
          }),
      },
      {
        provide: LiveIndexerRuntime,
        inject: [CkbClient, CanonicalCheckpointStore, CanonicalBlockProjector, BackendTelemetry],
        useFactory: (
          ckbClient: CkbClient,
          checkpoints: CanonicalCheckpointStore,
          projector: CanonicalBlockProjector,
          telemetry: BackendTelemetry,
        ) =>
          new LiveIndexerRuntime(ckbClient, checkpoints, projector, telemetry.logger, {
            enabled: environment.AUTOMATA_PROFILE === "testnet-public",
            loadDeployment: async () => {
              const result = await deploymentRegistry.load(environment.CKB_GENESIS_HASH);
              if (result.status !== "ok") throw new Error("indexer deployment is unavailable");
              return result.deployment;
            },
          }),
      },
      {
        provide: LiveJobReconciler,
        inject: [
          CkbClient,
          CanonicalCheckpointStore,
          JobCellDiscovery,
          JobTransitionIndexer,
          DAO_HARVEST_V2_INDEXER,
          DAO_HARVEST_V2_DEPLOYMENT,
          OPERATOR_AUTOMATION_DEPLOYMENT,
          BackendTelemetry,
        ],
        useFactory: (
          ckbClient: CkbClient,
          checkpoints: CanonicalCheckpointStore,
          discovery: JobCellDiscovery,
          transitions: JobTransitionIndexer,
          daoHarvestV2: DaoHarvestV2RevisionIndexer | undefined,
          daoHarvestV2Deployment: readonly VerifiedDaoHarvestV2Deployment[] | undefined,
          operatorDeployment: OperatorAutomationDeployment | undefined,
          telemetry: BackendTelemetry,
        ) =>
          new LiveJobReconciler(ckbClient, checkpoints, discovery, transitions, telemetry.logger, {
            enabled: environment.AUTOMATA_PROFILE === "testnet-public",
            loadDeployment: async () => {
              const result = await deploymentRegistry.load(environment.CKB_GENESIS_HASH);
              if (result.status !== "ok") {
                throw new Error("reconciliation deployment is unavailable");
              }
              return result.deployment;
            },
            ...(operatorDeployment === undefined ? {} : { operatorDeployment }),
            ...(daoHarvestV2 === undefined || daoHarvestV2Deployment === undefined
              ? {}
              : {
                  daoHarvestV2: {
                    deployments: daoHarvestV2Deployment.map(({ deployment }) => deployment),
                    indexer: daoHarvestV2,
                  },
                }),
          }),
      },
      {
        provide: HealthService,
        inject: [CkbClient, CanonicalCheckpointStore],
        useFactory: (ckbClient: CkbClient, checkpoints: CanonicalCheckpointStore) =>
          new HealthService(createDefaultHealthProbes(environment, ckbClient, checkpoints)),
      },
      {
        provide: NetworkMetadataService,
        inject: [CkbClient],
        useFactory: (ckbClient: CkbClient) => new NetworkMetadataService(environment, ckbClient),
      },
      {
        provide: JobReadService,
        inject: [DatabaseClient, JobQuoteService, PendingCreationService],
        useFactory: (
          databaseClient: DatabaseClient,
          quotes: JobQuoteService,
          pending: PendingCreationService,
        ) =>
          new JobReadService(databaseClient.database, environment.CKB_NETWORK, { pending, quotes }),
      },
      {
        provide: JobEventsService,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new JobEventsService(databaseClient.database, environment.CKB_NETWORK),
      },
      {
        provide: JobEventStreamService,
        inject: [JobEventsService],
        useFactory: (events: JobEventsService) => new JobEventStreamService(events),
      },
      {
        provide: JobQuoteService,
        inject: [DatabaseClient, CkbClient],
        useFactory: (databaseClient: DatabaseClient, ckbClient: CkbClient) =>
          new JobQuoteService(databaseClient.database, environment.CKB_NETWORK, ckbClient),
      },
      {
        provide: PostgresLockResolutionRecorder,
        inject: [DatabaseClient],
        useFactory: (databaseClient: DatabaseClient) =>
          new PostgresLockResolutionRecorder(databaseClient.database, environment.CKB_NETWORK),
      },
      {
        provide: TransactionBuildService,
        inject: [
          JobQuoteService,
          CkbClient,
          PostgresLockResolutionRecorder,
          OPERATOR_AUTOMATION_DEPLOYMENT,
        ],
        useFactory: (
          quotes: JobQuoteService,
          ckbClient: CkbClient,
          resolutions: PostgresLockResolutionRecorder,
          operatorDeployment: OperatorAutomationDeployment | undefined,
        ) =>
          new TransactionBuildService(
            quotes,
            ckbClient,
            environment.CKB_GENESIS_HASH,
            resolutions,
            operatorDeployment,
          ),
      },
      {
        provide: TransactionProgressService,
        inject: [CkbClient],
        useFactory: (ckbClient: CkbClient) =>
          new TransactionProgressService(environment, ckbClient),
      },
      {
        provide: DaoHarvestPendingService,
        inject: [DatabaseClient, CkbClient, TransactionProgressService],
        useFactory: (
          databaseClient: DatabaseClient,
          ckbClient: CkbClient,
          progress: TransactionProgressService,
        ) =>
          new DaoHarvestPendingService(
            databaseClient.database,
            environment.CKB_NETWORK,
            environment.CKB_GENESIS_HASH,
            ckbClient,
            progress,
          ),
      },
      {
        provide: DaoHarvestReadService,
        inject: [DatabaseClient, DaoHarvestPendingService],
        useFactory: (databaseClient: DatabaseClient, pending: DaoHarvestPendingService) =>
          new DaoHarvestReadService(databaseClient.database, environment.CKB_NETWORK, pending),
      },
      {
        provide: DaoHarvestMutationService,
        inject: [CkbClient, PostgresLockResolutionRecorder, DatabaseClient],
        useFactory: (
          ckbClient: CkbClient,
          resolutions: PostgresLockResolutionRecorder,
          databaseClient: DatabaseClient,
        ) =>
          new DaoHarvestMutationService(
            new DaoHarvestTransactionAdapter(
              ckbClient,
              environment.CKB_GENESIS_HASH,
              resolutions,
              deploymentRegistry,
              databaseClient.database,
              environment.CKB_NETWORK,
            ),
          ),
      },
      {
        provide: PendingCreationService,
        inject: [DatabaseClient, TransactionBuildService, TransactionProgressService],
        useFactory: (
          databaseClient: DatabaseClient,
          transactions: TransactionBuildService,
          progress: TransactionProgressService,
        ) =>
          new PendingCreationService(
            databaseClient.database,
            environment.CKB_NETWORK,
            transactions,
            progress,
          ),
      },
      {
        provide: TransactionProgressStreamService,
        inject: [TransactionProgressService],
        useFactory: (progress: TransactionProgressService) =>
          new TransactionProgressStreamService(progress),
      },
    ],
  };
}
