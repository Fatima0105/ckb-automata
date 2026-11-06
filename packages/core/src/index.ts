export const WORKSPACE_NAME = "ckb-automata" as const;

export * from "./dao-harvest-v2-builders.ts";
export * from "./dao-harvest-v2-transitions.ts";

export {
  DEFAULT_OPERATOR_TAKEOVER_DELAY_BLOCKS,
  OPERATOR_PAYLOAD_DOMAIN,
  OPERATOR_PAYLOAD_VERSION,
  deriveOperatorPayloadHash,
  normalizeOperatorSelection,
  operatorTakeoverBlock,
  packOperatorPayload,
  unpackOperatorPayload,
  type OperatorSelection,
} from "./operator-selection.ts";

export type {
  OperatorAutomationDeployment,
  OperatorContractDeployment,
} from "./operator-deployment.ts";

export {
  parseOperatorAutomationManifest,
  type OperatorAutomationManifest,
} from "./operator-automation-manifest.ts";

export {
  validateSdkConformanceFixture,
  type SdkConformanceCaseResult,
  type SdkConformanceResult,
} from "./conformance.ts";

export {
  MAX_EPOCH_COMPONENT,
  MAX_EPOCH_NUMBER,
  MAX_EPOCH_VALUE,
  MAX_UINT32,
  MAX_UINT64,
  createEpoch,
  hash32FromBytes,
  hash32ToBytes,
  outPointToRpc,
  packEpoch,
  parseBlockNumber,
  parseEpoch,
  parseEpochIndex,
  parseEpochLength,
  parseEpochNumber,
  parseHash32,
  parseOutPoint,
  parseOutputIndex,
  parseRunCount,
  parseSequence,
  parseSince,
  parseShannons,
  toRpcHex,
  uint32ToLittleEndian,
  uint64ToLittleEndian,
  type BlockNumber,
  type Epoch,
  type EpochIndex,
  type EpochLength,
  type EpochNumber,
  type EpochValue,
  type Hash32,
  type IntegerInput,
  type OutPoint,
  type OutputIndex,
  type RpcOutPoint,
  type RunCount,
  type Sequence,
  type SinceValue,
  type Shannons,
  type Uint32Value,
  type Uint64Value,
} from "./chain-values.ts";

export {
  CONTRACT_CAPACITY,
  minimumCampaignCellCapacity,
  minimumJobCellCapacity,
  minimumPlainCellCapacity,
  type ContractCapacityId,
} from "./contract-costs.ts";

export {
  CAMPAIGN_ID_DOMAIN,
  CAMPAIGN_REFUNDS_DOMAIN,
  CAMPAIGN_STATES,
  DEADLINE_PAYLOAD_VERSION,
  deriveCampaignId,
  deriveDeadlinePayloadHash,
  deriveRefundCommitment,
  determineCampaignOutcome,
  encodeOutPoint,
  isAbsoluteBlockDeadline,
  type CampaignOutcome,
} from "./campaign.ts";

export {
  ABSOLUTE_BLOCK_TRIGGER_KIND,
  ABSOLUTE_EPOCH_TRIGGER_KIND,
  TRIGGER_PARAMS_DOMAIN,
  decodeAbsoluteEpochSince,
  decodeRelativeEpochSince,
  deriveAbsoluteBlockTriggerHash,
  deriveAbsoluteEpochTriggerHash,
  encodeAbsoluteEpochSince,
  encodeRelativeEpochSince,
} from "./triggers.ts";

export {
  JOB_ID_DOMAIN,
  deriveJobId,
  type CreationAnchor,
  type JobIdentityInput,
} from "./job-identity.ts";

export {
  POLICY_PAYLOAD_DOMAIN,
  deriveRecurringPayloadHash,
  isValidRecurringSchedule,
  type RecurringSchedule,
} from "./recurring.ts";

export {
  DAO_HARVEST_DAO_STATES,
  DAO_HARVEST_EXECUTOR_SET_DOMAIN,
  DAO_HARVEST_OPERATIONS,
  DAO_HARVEST_PAYLOAD_DOMAIN,
  DAO_HARVEST_PAYLOAD_VERSION,
  DAO_HARVEST_QUOTE_VALID_BLOCKS,
  DAO_HARVEST_VAULT_COMMITMENT_DOMAIN,
  MAX_DAO_HARVEST_PREPARE_EXECUTORS,
  classifyDaoHarvestCellData,
  deriveDaoHarvestPayloadHash,
  deriveDaoHarvestVaultCommitment,
  derivePrepareExecutorSetHash,
  normalizePrepareExecutorSet,
  type DaoHarvestDaoState,
  type DaoHarvestOperation,
  type DaoHarvestVaultCommitmentInput,
} from "./dao-harvest.ts";

export {
  DAO_CYCLE_EPOCHS,
  addEpochFractions,
  addEpochs,
  calculateDaoHarvestQuote,
  calculateDaoMaximumWithdraw,
  compareEpochFractions,
  nextDaoBoundary,
  selectDaoPrepareWindow,
  subtractEpochs,
  subtractEpochFractions,
  type DaoHarvestQuote,
  type DaoHarvestQuoteInput,
  type DaoPrepareWindow,
} from "./dao-harvest-math.ts";

export {
  DAO_HARVEST_JOB_OCCUPIED_CAPACITY,
  DAO_HARVEST_SETUP_INTENT_DOMAIN,
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  DaoHarvestBuilderError,
  buildDaoHarvestOwnerExit,
  buildDaoHarvestExecutorRotation,
  buildDaoHarvestPrepare,
  buildDaoHarvestRecovery,
  buildDaoHarvestRoll,
  buildDaoHarvestSetup,
  buildDaoHarvestStopRecurrence,
  registeredDaoHarvestDeployment,
  type DaoHarvestActionInput,
  type DaoHarvestBuilderErrorCode,
  type DaoHarvestContractDeployment,
  type DaoHarvestDeployment,
  type DaoHarvestOwnerBuildInput,
  type DaoHarvestOwnerExitInput,
  type DaoHarvestRotateExecutorsInput,
  type DaoHarvestPrepareInput,
  type DaoHarvestRollInput,
  type DaoHarvestSetupBuild,
  type DaoHarvestSetupInput,
  type DaoHarvestSigningEntry,
  type DaoHarvestTransitionBuild,
  type DaoHarvestMatureRecoveryInput,
  type DaoHarvestMatureRecoveryBuild,
  buildDaoHarvestMatureRecovery,
} from "./dao-harvest-builders.ts";

export {
  planDaoHarvestRecovery,
  type DaoHarvestOwnerAction,
  type DaoHarvestRecoveryCondition,
  type DaoHarvestRecoveryPlan,
  type DaoHarvestRecoveryStatus,
} from "./dao-harvest-recovery.ts";

export {
  ERROR_CATALOG,
  INVALID_TRANSITION_DIAGNOSTICS,
  getErrorDefinition,
  type ErrorDefinition,
  type ErrorDomain,
  type ErrorKey,
  type ScriptErrorKey,
} from "./errors.ts";

export {
  CANONICAL_TERMS,
  CANONICAL_TRANSACTION_STATES,
  GLOSSARY,
  type CanonicalTerm,
  type CanonicalTransactionState,
} from "./vocabulary.ts";

export {
  DEPLOYED_CONTRACT_NAMES,
  inspectJobData,
  scriptIdentityHash,
  validateDeploymentManifest,
  type CellDepIdentity,
  type DeployedContract,
  type DeployedContractName,
  type DeploymentManifest,
  type InspectedJobDataV1,
  type JobInspectionOptions,
  type JobInspectionResult,
  type JobSemanticIssue,
  type ManifestIssue,
  type ManifestValidationResult,
  type PolicyMetadata,
  type ScriptHashType,
  type ScriptIdentity,
} from "./job-inspection.ts";

export {
  LOCAL_DEPLOYMENT_MANIFEST_SHA256,
  TESTNET_DEPLOYMENT_MANIFEST_SHA256,
  TESTNET_GENESIS_HASH,
  createDeploymentRegistry,
  deploymentRegistry,
  hashDeploymentManifest,
  type DeploymentRegistry,
  type DeploymentRegistryLoadResult,
  type HashedManifestEntry,
  type RegisteredContract,
  type RegisteredDeployment,
} from "./deployment-registry.ts";

export {
  CREATION_REVIEW_EXPIRY_CONDITION,
  CREATION_REVIEW_WINDOW_BLOCKS,
  REVIEW_FEE_RATE_MAXIMUM,
  REVIEW_TRANSACTION_MAXIMUM_BYTES,
  calculateDeadlineQuote,
  calculateRecurringQuote,
  estimateTransactionFeeRange,
  type DeadlineQuote,
  type DeadlineQuoteInput,
  type EstimatedFeeRange,
  type FeeRangeInput,
  type QuoteAmounts,
  type RecurringQuote,
  type RecurringQuoteInput,
} from "./quotes.ts";

export {
  HARVEST_V2_TRANSACTION_LIMITS,
  HARVEST_V2_TRANSACTION_OPERATIONS,
  HarvestV2TransactionLimitError,
  assertHarvestV2TransactionWithinLimits,
  serializedTransactionBytes,
  type HarvestV2TransactionBoundaryEvidence,
  type HarvestV2TransactionBoundaryInput,
  type HarvestV2TransactionLimit,
  type HarvestV2TransactionLimitErrorCode,
  type HarvestV2TransactionOperation,
} from "./harvest-v2-transaction-limits.ts";

export {
  HARVEST_V2_COMPENSATION_CELL_OCCUPIED_CAPACITY,
  HARVEST_V2_COMPENSATION_LOCK_ARGS_BYTES,
  prototypeCompensationClose,
  prototypeCompensationSeed,
  prototypeCompensationSweep,
  prototypeHarvestV2Settlement,
  prototypeOperatorAccumulator,
  prototypePlainCellOccupiedCapacity,
  type CompensationClosePrototype,
  type CompensationSweepPrototype,
  type HarvestV2SettlementPrototype,
  type HarvestV2SettlementPrototypeInput,
  type OperatorAccumulatorPrototype,
} from "./dao-harvest-v2-prototype.ts";

export {
  DAO_HARVEST_V2_ABSENT_INDEX,
  DAO_HARVEST_V2_COMPENSATION_ARGS_BYTES,
  DAO_HARVEST_V2_VAULT_ARGS_BYTES,
  DAO_HARVEST_V2_DOMAINS,
  DAO_HARVEST_V2_OPERATIONS,
  decodeDaoHarvestV2VaultLockArgs,
  deriveDaoHarvestV2VaultTermsHash,
  encodeDaoHarvestV2VaultLockArgs,
  type DaoHarvestV2VaultLockArgs,
  DAO_HARVEST_V2_STATES,
  DAO_HARVEST_V2_VERSION,
  MAX_DAO_HARVEST_V2_FALLBACK_OPERATORS,
  assertDaoHarvestV2WitnessLayout,
  decodeDaoHarvestV2CompensationLockArgs,
  decodeDaoHarvestV2FallbackOperatorProof,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  encodeDaoHarvestV2CompensationLockArgs,
  encodeDaoHarvestV2FallbackOperatorProof,
  normalizeDaoHarvestV2FallbackOperators,
  type DaoHarvestV2CompensationLockArgs,
  type DaoHarvestV2Operation,
  type DaoHarvestV2WitnessIndices,
} from "./dao-harvest-v2.ts";

export {
  DEADLINE_CREATION_INTENT_DOMAIN,
  assertDeadlineCompletion,
  buildDeadlineCreation,
  type DeadlineCompletionContract,
  type DeadlineCreationBuild,
  type DeadlineCreationInput,
  type DeadlinePledgeInput,
  type NormalizedDeadlineIntent,
  type UnsignedCellInput,
  type UnsignedCellOutput,
  type UnsignedDeadlineTransaction,
} from "./deadline-creation.ts";

export {
  parseDeadlineCreationRequest,
  type DeadlineCreationRequest,
  type DeadlineRequestPledge,
} from "./deadline-request.ts";

export {
  RECURRING_CREATION_INTENT_DOMAIN,
  assertRecurringCompletion,
  buildRecurringCreation,
  reconstructRecurringDisplayIntent,
  type NormalizedRecurringIntent,
  type RecurringCreationBuild,
  type RecurringCreationInput,
  type RecurringDisplayIntent,
} from "./recurring-creation.ts";

export {
  parseRecurringCreationRequest,
  type RecurringCreationRequest,
} from "./recurring-request.ts";

export {
  CANCELLATION_OPERATION,
  CancellationBuildError,
  assertCancellationCompletion,
  buildCancellation,
  type CancellationBuild,
  type CancellationErrorCode,
  type CancellationInput,
  type LiveCellResolver,
  type ResolvedLiveCell,
} from "./cancellation.ts";

export {
  RECOVERY_OPERATION,
  RECOVERY_REASONS,
  RecoveryBuildError,
  assertRecoveryCompletion,
  buildRecovery,
  type RecoveryBuild,
  type RecoveryErrorCode,
  type RecoveryInput,
  type RecoveryOutputPreview,
  type RecoveryReason,
} from "./recovery.ts";

export {
  TOP_UP_OPERATION,
  TopUpBuildError,
  assertTopUpCompletion,
  buildTopUp,
  inspectTopUpDiff,
  type JobCellSnapshot,
  type TopUpBuild,
  type TopUpDiff,
  type TopUpErrorCode,
  type TopUpInput,
} from "./top-up.ts";
