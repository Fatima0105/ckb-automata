import { WORKSPACE_NAME } from "@ckb-automata/core";

export const EXECUTOR_APP_ID = `${WORKSPACE_NAME}:executor` as const;

export {
  DAO_HARVEST_EXECUTOR_ADAPTER,
  DAO_HARVEST_EXECUTOR_REGISTRATION,
  DaoHarvestAdapterError,
} from "./policies/dao-harvest.ts";

export {
  daoHarvestOperationalSignal,
  inspectDaoHarvestDeadLetter,
  type DaoHarvestDeadLetterInspection,
  type DaoHarvestOperationalEvent,
  type DaoHarvestOperationalSignal,
} from "./dao-harvest-operations.ts";

export {
  DAO_HARVEST_MAX_WAKE_DELAY_MS,
  DAO_HARVEST_MIN_WAKE_DELAY_MS,
  DaoHarvestScheduler,
  assertDaoHarvestSubmissionWindow,
  evaluateDaoHarvestSchedule,
  reconcileDaoHarvestAttempt,
  type DaoHarvestAttemptObservation,
  type DaoHarvestScheduleDecision,
  type DaoHarvestScheduleRecord,
} from "./dao-harvest-scheduler.ts";

export {
  DAO_HARVEST_V1_ADAPTER_ID,
  DAO_HARVEST_V2_ADAPTER_ID,
  DaoHarvestV2SafetyError,
  assertSingleCanonicalDaoHarvestV2Successor,
  createDaoHarvestV2ExecutionPlan,
  daoHarvestAdapterId,
  evaluateDaoHarvestV2Schedule,
  reconcileDaoHarvestV2Attempt,
  validateDaoHarvestV2Reload,
  type DaoHarvestAdapterId,
  type DaoHarvestV2AttemptObservation,
  type DaoHarvestV2DryRunEvidence,
  type DaoHarvestV2ExecutionEconomics,
  type DaoHarvestV2ExecutionPlan,
  type DaoHarvestV2Operation,
  type DaoHarvestV2ScheduleDecision,
  type DaoHarvestV2ScheduleRecord,
} from "./dao-harvest-v2-safety.ts";

export { ChainBuildSnapshotSource, chainScriptIdentity } from "./build-snapshot.ts";
export { PostgresBuildAttemptStore } from "./build-store.ts";
export { BuildCoordinator } from "./build-worker.ts";
export { PostgresConfirmationStore, MAX_CONFIRMATION_ATTEMPTS } from "./confirmation-store.ts";
export { CONFIRMATION_POLL_MS, ConfirmationCoordinator } from "./confirmation-worker.ts";
export { PostgresDeadLetterStore } from "./dead-letter-store.ts";
export { DeadLetterCoordinator } from "./dead-letter-worker.ts";
export {
  DeadLetterOperations,
  parseDeadLetterId,
  parseDeadLetterOperator,
  parseDeadLetterPayload,
  parseDeadLetterReason,
  type DeadLetterAction,
  type DeadLetterActionKind,
  type DeadLetterCloseDecision,
  type DeadLetterRecord,
  type DeadLetterReplayDecision,
  type DeadLetterSourceQueue,
  type DeadLetterStore,
} from "./dead-letter.ts";
export {
  CONFIRMATION_DROP_AFTER_MS,
  ConfirmationService,
  deriveConfirmationTransition,
  type ConfirmationAttempt,
  type ConfirmationChain,
  type ConfirmationEvidence,
  type ConfirmationInclusion,
  type ConfirmationQueuePayload,
  type ConfirmationRecovery,
  type ConfirmationResult,
  type ConfirmationState,
  type ConfirmationStore,
  type ConfirmationTransition,
  type RpcTransactionObservation,
} from "./confirmation.ts";
export {
  BUILD_CLAIM_LEASE_MS,
  TransactionBuildService,
  createBuildAttemptId,
  type BuildAttemptClaim,
  type BuildAttemptStore,
  type BuildClaimResult,
  type BuildSnapshotSource,
  type TransactionBuildResult,
} from "./build.ts";
export {
  DISCOVERY_INTERVAL_MS,
  MAX_DISCOVERY_JOBS,
  EligibilityCoordinator,
  PostgresEligibilityJobSource,
  type EligibilityJobSource,
} from "./eligibility-worker.ts";
export {
  EXECUTOR_ADAPTERS,
  EXECUTOR_ENVIRONMENT,
  EXECUTOR_LOGGER,
  EXECUTOR_QUEUES,
  ExecutorModule,
  createExecutorModule,
  type ExecutorModuleDependencies,
} from "./app.module.ts";
export {
  ExecutorLogger,
  createExecutorApplication,
  startExecutor,
  type ExecutorBootstrapDependencies,
  type ExecutorBootstrapResult,
} from "./bootstrap.ts";
export {
  MAX_EVALUATION_DELAY_MS,
  MIN_EVALUATION_DELAY_MS,
  TARGET_BLOCK_INTERVAL_MS,
  EligibilityEvaluator,
  nextEvaluationDelay,
  type BuildQueuePayload,
  type EligibilityEvaluationResult,
  type EligibilityJobRecord,
  type EligibilityQueuePayload,
} from "./eligibility.ts";
export {
  DEFAULT_QUEUE_PREFIX,
  MAX_QUEUE_DELAY_MS,
  QUEUE_READINESS_TIMEOUT_MS,
  QUEUE_POLICIES,
  DurableQueueRegistry,
  forwardTerminalFailures,
  parseRedisConnection,
  queueRegistrationOptions,
  queueRootOptions,
  stableQueueJobId,
  type DeadLetterPayload,
  type QueueJobEnvelope,
  type QueuePolicy,
} from "./queues.ts";
export {
  EXECUTOR_RETRY_POLICIES,
  executeWithRetryPolicy,
  executorFailureCode,
  normalizeExecutorFailureCode,
  retryPolicyFor,
  type ExecutorFailureCode,
  type ExecutorRetryPolicy,
  type RetryCategory,
} from "./retry.ts";
export {
  ExecutorRuntime,
  type ExecutorChainClient,
  type ExecutorEventLogger,
  type ExecutorQueueReadiness,
  type ExecutorReadinessReport,
  type ExecutorRuntimeState,
} from "./runtime.ts";
export { operatorLockArgs, signOperatorFeeInput } from "./signing.ts";
export {
  EXECUTOR_RECEIPT_AUTHORITY,
  EXECUTOR_RECEIPT_SCHEMA,
  ExecutorReceiptSigner,
  executorReceiptDigest,
  verifyExecutorReceipt,
  type ConfirmationReceiptIssuer,
  type ExecutorReceipt,
  type ExecutorReceiptOutcome,
  type ExecutorReceiptPayload,
} from "./receipt.ts";
export {
  SimulationGateService,
  parseStoredTransaction,
  type SimulationAttempt,
  type SimulationChain,
  type SimulationQueuePayload,
  type SimulationRecord,
  type SimulationResult,
  type SimulationStore,
} from "./simulation.ts";
export { PostgresSimulationStore } from "./simulation-store.ts";
export { SimulationCoordinator } from "./simulation-worker.ts";
export { PostgresSubmissionStore } from "./submission-store.ts";
export {
  SubmissionError,
  SubmissionService,
  type SubmissionAcceptance,
  type SubmissionAttempt,
  type SubmissionChain,
  type SubmissionResult,
  type SubmissionStore,
} from "./submission.ts";

export {
  ExecutorAdapterError,
  ExecutorAdapterRegistry,
  defineExecutorAdapter,
  evaluateExecutorEligibility,
  runExecutorAdapter,
  type BuiltVerification,
  type EligibilityDecision,
  type ExecutorAdapterRegistration,
  type ExecutorBuild,
  type ExecutorCellSnapshot,
  type ExecutorContext,
  type ExecutorEligibilityContext,
  type ExecutorEligibilityResult,
  type ExecutorHeaderSnapshot,
  type ExecutorIdentity,
  type ExecutorPolicyAdapter,
  type ExecutorRunResult,
  type ExecutorSnapshot,
  type RegisteredExecutorAdapter,
} from "./adapter.ts";

export {
  DEADLINE_EXECUTOR_ADAPTER,
  DEADLINE_EXECUTOR_REGISTRATION,
  DeadlineAdapterError,
  type DeadlineAdapterErrorCode,
  type DeadlineEvidence,
  type DeadlineInspection,
  type DeadlineRefundRecord,
} from "./policies/deadline.ts";
export {
  RECURRING_EXECUTOR_ADAPTER,
  RECURRING_EXECUTOR_REGISTRATION,
  RecurringAdapterError,
  type RecurringAdapterErrorCode,
  type RecurringEvidence,
  type RecurringInspection,
} from "./policies/recurring.ts";
