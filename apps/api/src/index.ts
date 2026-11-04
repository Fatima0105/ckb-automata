import { WORKSPACE_NAME } from "@ckb-automata/core";

export const API_APP_ID = `${WORKSPACE_NAME}:api` as const;

export {
  API_AUTH_HANDLER_TIMEOUT_MS,
  API_BODY_LIMIT_BYTES,
  API_DEFAULT_HANDLER_TIMEOUT_MS,
  API_RATE_BUCKET_CAPACITY,
  API_RATE_LIMITS,
  API_RATE_WINDOW_MS,
  API_REQUEST_RECEIVE_TIMEOUT_MS,
  API_TRANSACTION_HANDLER_TIMEOUT_MS,
  ApiTimeoutInterceptor,
  FixedWindowRateLimiter,
  endpointTimeoutMs,
  installFastifyAbuseControls,
  resolveClientAddress,
  type AbuseControlOptions,
  type ApiTimeoutInterceptorOptions,
  type RateLimitResult,
} from "./abuse-controls.ts";

export { AppModule, createAppModule } from "./app.module.ts";
export {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENT_TYPES,
  NotificationPreferencesController,
  NotificationPreferencesService,
  type NotificationChannel,
  type NotificationEventType,
  type NotificationPreferencesOptions,
  type NotificationPreferencesResponse,
} from "./preferences.ts";
export {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_CLAIM_LEASE_MS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
  WebhookController,
  WebhookService,
  signWebhookRequest,
  verifyWebhookSignature,
  type WebhookDeliveryResponse,
  type WebhookDeliveryRun,
  type WebhookRegistrationResponse,
  type WebhookServiceOptions,
  type WebhookSubscriptionResponse,
} from "./webhooks.ts";
export {
  ApiTelemetryInterceptor,
  BackendTelemetry,
  MetricsController,
  createBackendLogger,
} from "./telemetry.ts";
export {
  AUTH_CHALLENGE_TTL_MS,
  AUTH_SESSION_SCOPE,
  AUTH_SESSION_TTL_MS,
  AuthController,
  AuthService,
  formatAuthChallengeMessage,
  type AuthChallengeMessageInput,
  type AuthChallengeResponse,
  type AuthenticatedSession,
  type AuthServiceOptions,
  type AuthSessionResponse,
} from "./auth.ts";
export {
  CkbClient,
  CkbClientError,
  createCkbClient,
  type CkbClientErrorCode,
  type CkbClientOptions,
  type CkbIndexerTip,
  type CkbReadClient,
} from "./ckb-client.ts";
export { DatabaseClient, createDatabaseClient, type AutomataDatabase } from "./database/client.ts";
export {
  CanonicalCheckpointStore,
  CheckpointError,
  DEFAULT_CANONICAL_ROLLBACK_WINDOW,
  planCheckpointTransition,
  type CanonicalBlockInput,
  type CanonicalPosition,
  type CheckpointErrorCode,
  type CheckpointUpdate,
} from "./indexer/checkpoints.ts";
export {
  JobCellDiscovery,
  extractSupportedJobCells,
  type DiscoveredJobCell,
  type JobCellExtraction,
  type JobDiscoveryResult,
  type SupportedJobPolicyKind,
} from "./indexer/job-discovery.ts";
export {
  JobTransitionIndexer,
  classifyJobTransition,
  type JobTransitionKind,
  type JobTransitionResult,
} from "./indexer/job-transitions.ts";
export {
  CanonicalBlockProjector,
  JobProjectionRollback,
  type CanonicalBlockProjectionResult,
  type ReorgRollbackResult,
} from "./indexer/reorg.ts";
export {
  INDEXER_BATCH_BLOCKS,
  INDEXER_INITIAL_BACKFILL_BLOCKS,
  INDEXER_POLL_INTERVAL_MS,
  LiveIndexerRuntime,
  nextIndexerScanRange,
  type IndexerScanRange,
  type LiveIndexerRuntimeOptions,
} from "./indexer/runtime.ts";
export {
  API_GLOBAL_PREFIX,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  configureApiApplication,
  createApiApplication,
  parseApiBootstrapConfig,
  startApi,
  type ApiBootstrapConfig,
  type ApiBootstrapDependencies,
  type ApiBootstrapResult,
} from "./bootstrap.ts";
export {
  EVENT_CONFIDENCE,
  EVENT_SOURCES,
  EVENT_STREAM_BATCH_SIZE,
  EVENT_STREAM_HEARTBEAT_MS,
  EVENT_STREAM_POLL_MS,
  JobEventStreamController,
  JobEventStreamService,
  JobEventsController,
  JobEventsService,
  type EventConfidence,
  type EventSource,
  type EventStreamOptions,
  type JobEventReadModel,
  type JobEventTimeline,
} from "./events.ts";
export {
  HEALTH_DEPENDENCIES,
  HealthController,
  HealthService,
  createDefaultHealthProbes,
  type DependencyHealth,
  type HealthDependencyName,
  type HealthProbe,
  type LivenessReport,
  type ReadinessReport,
} from "./health.ts";
export {
  AccountJobsController,
  JOB_STATES,
  JOB_TEMPLATE_CATALOG,
  JOB_TEMPLATES,
  JobReadService,
  JobsController,
  TemplatesController,
  type JobListQuery,
  type JobListResponse,
  type JobReadModel,
  type JobSourceProvenance,
  type JobState,
  type JobTemplate,
  type JobTemplateId,
} from "./jobs.ts";
export {
  NetworkMetadataController,
  NetworkMetadataService,
  SUPPORTED_POLICY_VERSIONS,
  type NetworkMetadata,
  type NetworkMetadataChainClient,
} from "./network-metadata.ts";
export { createOpenApiDocument } from "./openapi.ts";
export {
  DAO_HARVEST_READ_STATES,
  DaoHarvestController,
  DaoHarvestMutationService,
  DaoHarvestReadService,
  DaoHarvestTransactionAdapter,
  type DaoHarvestListResponse,
  type DaoHarvestMutationAdapter,
  type DaoHarvestQuoteReadModel,
  type DaoHarvestReadModel,
  type DaoHarvestReadState,
  type DaoHarvestUnsignedBuild,
} from "./dao-harvest.ts";
export {
  DaoHarvestV2Controller,
  DaoHarvestV2MutationService,
  DaoHarvestV2PendingService,
  DaoHarvestV2ReadService,
  type DaoHarvestV2ListResponse,
  type DaoHarvestV2BuildOperation,
  type DaoHarvestV2MutationAdapter,
  type DaoHarvestV2PendingProvider,
  type DaoHarvestV2PendingReadModel,
  type DaoHarvestV2PendingSource,
  type DaoHarvestV2QuoteReadModel,
  type DaoHarvestV2ReadModel,
  type DaoHarvestV2UnsignedBuild,
  type StoredDaoHarvestV2Submission,
} from "./dao-harvest-v2.ts";
export {
  DAO_HARVEST_V2_OPERATION_NAMES,
  extractDaoHarvestV2ProjectionEvents,
  rebuildDaoHarvestV2Snapshot,
  type DaoHarvestV2ProjectedOperation,
  type DaoHarvestV2ProjectionDeployment,
  type DaoHarvestV2ProjectionEvent,
  type DaoHarvestV2ProjectionExtraction,
  type DaoHarvestV2ResolvedInput,
  type DaoHarvestV2Snapshot,
} from "./indexer/dao-harvest-v2-projection.ts";
export { DaoHarvestV2ProjectionStore } from "./indexer/dao-harvest-v2-store.ts";
export {
  extractDaoHarvestProjections,
  DaoHarvestProjectionStore,
  type DaoHarvestProjection,
  type DaoHarvestProjectionExtraction,
  type DaoHarvestProjectionResult,
} from "./indexer/dao-harvest-projection.ts";
export {
  JOB_QUOTE_ASSUMPTIONS,
  JobQuoteController,
  JobQuoteService,
  type JobQuote,
  type QuoteChainClient,
} from "./quotes.ts";
export {
  TRANSACTION_OPERATIONS,
  TransactionBuildService,
  TransactionController,
  type SignedTransactionValidation,
  type TransactionBuildResponse,
  type TransactionChainClient,
  type TransactionOperation,
} from "./transactions.ts";
export * as databaseSchema from "./database/schema.ts";
export {
  loadMigrations,
  migrateDatabase,
  rollbackDatabase,
  type AppliedMigration,
  type DatabaseMigration,
  type MigrationResult,
} from "./database/migrator.ts";
