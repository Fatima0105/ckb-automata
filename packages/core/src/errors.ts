export type ErrorDomain = "script" | "sdk" | "api" | "executor";

export interface ErrorDefinition {
  code: number;
  domain: ErrorDomain;
  copy: string;
  rustVariant?: string;
}

export const ERROR_CATALOG = {
  SCRIPT_INVALID_DATA: {
    code: 10,
    domain: "script",
    copy: "The job data is malformed.",
    rustVariant: "InvalidData",
  },
  SCRIPT_UNSUPPORTED_VERSION: {
    code: 11,
    domain: "script",
    copy: "This job version is not supported.",
    rustVariant: "UnsupportedVersion",
  },
  SCRIPT_RESERVED_FLAGS: {
    code: 12,
    domain: "script",
    copy: "The job uses reserved flags.",
    rustVariant: "ReservedFlags",
  },
  SCRIPT_INVALID_STATE: {
    code: 13,
    domain: "script",
    copy: "The job has an invalid on-chain state.",
    rustVariant: "InvalidState",
  },
  SCRIPT_UNSUPPORTED_TRIGGER: {
    code: 14,
    domain: "script",
    copy: "This trigger type is not supported.",
    rustVariant: "UnsupportedTrigger",
  },
  SCRIPT_INVALID_WITNESS_MODE: {
    code: 15,
    domain: "script",
    copy: "The transaction requests an invalid job operation.",
    rustVariant: "InvalidWitnessMode",
  },
  SCRIPT_MISSING_OWNER_AUTHORIZATION: {
    code: 16,
    domain: "script",
    copy: "The owner authorization input is missing or incorrect.",
    rustVariant: "MissingOwnerAuthorization",
  },
  SCRIPT_POLICY_HASH_MISMATCH: {
    code: 17,
    domain: "script",
    copy: "The transaction changed the committed policy.",
    rustVariant: "PolicyHashMismatch",
  },
  SCRIPT_TRIGGER_HASH_MISMATCH: {
    code: 18,
    domain: "script",
    copy: "The transaction changed the committed trigger parameters.",
    rustVariant: "TriggerHashMismatch",
  },
  SCRIPT_PAYLOAD_HASH_MISMATCH: {
    code: 19,
    domain: "script",
    copy: "The transaction changed the committed policy payload.",
    rustVariant: "PayloadHashMismatch",
  },
  SCRIPT_JOB_ID_MISMATCH: {
    code: 20,
    domain: "script",
    copy: "The successor changed the job identity.",
    rustVariant: "JobIdMismatch",
  },
  SCRIPT_SEQUENCE_MISMATCH: {
    code: 21,
    domain: "script",
    copy: "The successor sequence is not the next value.",
    rustVariant: "SequenceMismatch",
  },
  SCRIPT_NOT_YET_ELIGIBLE: {
    code: 22,
    domain: "script",
    copy: "The job is not yet eligible for this action.",
    rustVariant: "NotYetEligible",
  },
  SCRIPT_INVALID_SINCE: {
    code: 23,
    domain: "script",
    copy: "The transaction uses an invalid since value.",
    rustVariant: "InvalidSince",
  },
  SCRIPT_SUCCESSOR_COUNT_MISMATCH: {
    code: 24,
    domain: "script",
    copy: "The transaction creates the wrong number of successors.",
    rustVariant: "SuccessorCountMismatch",
  },
  SCRIPT_SUCCESSOR_INVARIANT_MISMATCH: {
    code: 25,
    domain: "script",
    copy: "The successor changed a protected job field.",
    rustVariant: "SuccessorInvariantMismatch",
  },
  SCRIPT_BUDGET_INCREASE: {
    code: 26,
    domain: "script",
    copy: "The successor budget increased without owner authorization.",
    rustVariant: "BudgetIncrease",
  },
  SCRIPT_RUNS_INCREASE: {
    code: 27,
    domain: "script",
    copy: "The successor run count increased.",
    rustVariant: "RunsIncrease",
  },
  SCRIPT_CAPACITY_NOT_CONSERVED: {
    code: 28,
    domain: "script",
    copy: "The transaction does not preserve job-controlled capacity.",
    rustVariant: "CapacityNotConserved",
  },
  SCRIPT_REWARD_AMOUNT_MISMATCH: {
    code: 29,
    domain: "script",
    copy: "The executor reward amount does not match the job.",
    rustVariant: "RewardAmountMismatch",
  },
  SCRIPT_REWARD_RECIPIENT_MISMATCH: {
    code: 30,
    domain: "script",
    copy: "The executor reward is assigned to the wrong recipient.",
    rustVariant: "RewardRecipientMismatch",
  },
  SCRIPT_REWARD_FORBIDDEN: {
    code: 31,
    domain: "script",
    copy: "Cancellation and recovery cannot pay an executor reward.",
    rustVariant: "RewardForbidden",
  },
  SCRIPT_INVALID_APPLICATION_STATE: {
    code: 32,
    domain: "script",
    copy: "The application state does not permit this action.",
    rustVariant: "InvalidApplicationState",
  },
  SCRIPT_MISSING_HEADER: {
    code: 33,
    domain: "script",
    copy: "A required block header is missing.",
    rustVariant: "MissingHeader",
  },
  SCRIPT_ARITHMETIC_OVERFLOW: {
    code: 34,
    domain: "script",
    copy: "A protected amount or counter overflowed.",
    rustVariant: "ArithmeticOverflow",
  },
  SCRIPT_UNSUPPORTED_RECOVERY: {
    code: 35,
    domain: "script",
    copy: "This recovery operation is not supported for the job.",
    rustVariant: "UnsupportedRecovery",
  },
  SCRIPT_INVALID_DAO_CELL: {
    code: 36,
    domain: "script",
    copy: "The transaction uses an invalid or unrelated Nervos DAO cell.",
    rustVariant: "InvalidDaoCell",
  },
  SCRIPT_PRINCIPAL_MISMATCH: {
    code: 37,
    domain: "script",
    copy: "The transaction changed the protected original amount.",
    rustVariant: "PrincipalMismatch",
  },
  SCRIPT_PAYOUT_MISMATCH: {
    code: 38,
    domain: "script",
    copy: "The compensation payout does not match the approved address or amount.",
    rustVariant: "PayoutMismatch",
  },
  SCRIPT_UNAUTHORIZED_EXECUTOR: {
    code: 39,
    domain: "script",
    copy: "This executor is not approved to prepare the DAO withdrawal.",
    rustVariant: "UnauthorizedExecutor",
  },
  SCRIPT_COMPENSATION_BELOW_MINIMUM: {
    code: 40,
    domain: "script",
    copy: "The available compensation is below the approved minimum.",
    rustVariant: "CompensationBelowMinimum",
  },
  SCRIPT_CYCLE_LIMIT_REACHED: {
    code: 41,
    domain: "script",
    copy: "The automation has reached its approved cycle or end-epoch limit.",
    rustVariant: "CycleLimitReached",
  },
  SCRIPT_INVALID_EXECUTOR_SET: {
    code: 42,
    domain: "script",
    copy: "The preparation executor proof does not match the approved set.",
    rustVariant: "InvalidExecutorSet",
  },
  SCRIPT_MISSING_BOUND_JOB: {
    code: 43,
    domain: "script",
    copy: "The protected DAO cell is not being spent with its matching automation.",
    rustVariant: "MissingBoundJob",
  },
  SCRIPT_INVALID_COMPENSATION_CELL: {
    code: 44,
    domain: "script",
    copy: "The transaction uses an invalid or unrelated compensation balance.",
    rustVariant: "InvalidCompensationCell",
  },
  SCRIPT_COMPENSATION_BINDING_MISMATCH: {
    code: 45,
    domain: "script",
    copy: "The compensation balance does not match the approved job and policy.",
    rustVariant: "CompensationBindingMismatch",
  },
  SCRIPT_COMPENSATION_DELTA_MISMATCH: {
    code: 46,
    domain: "script",
    copy: "The compensation balance changed by an unapproved amount.",
    rustVariant: "CompensationDeltaMismatch",
  },
  SCRIPT_INVALID_PREPARE_CREDIT: {
    code: 47,
    domain: "script",
    copy: "The preparation record is malformed.",
    rustVariant: "InvalidPrepareCredit",
  },
  SCRIPT_PREPARE_CREDIT_MISMATCH: {
    code: 48,
    domain: "script",
    copy: "The preparation record does not match this job cycle.",
    rustVariant: "PrepareCreditMismatch",
  },
  SCRIPT_UNAUTHORIZED_PREFERRED_OPERATOR: {
    code: 49,
    domain: "script",
    copy: "The preferred preparation window belongs to another operator.",
    rustVariant: "UnauthorizedPreferredOperator",
  },
  SCRIPT_TAKEOVER_NOT_REACHED: {
    code: 50,
    domain: "script",
    copy: "The backup operator waiting period has not ended.",
    rustVariant: "TakeoverNotReached",
  },
  SCRIPT_INVALID_OPERATOR_ACCUMULATOR: {
    code: 51,
    domain: "script",
    copy: "An operator payment does not preserve the operator lock and exact increase.",
    rustVariant: "InvalidOperatorAccumulator",
  },
  SCRIPT_SERVICE_FEE_MISMATCH: {
    code: 52,
    domain: "script",
    copy: "A completed-work charge exceeds its approved amount.",
    rustVariant: "ServiceFeeMismatch",
  },
  SCRIPT_COMPENSATION_SEED_MISMATCH: {
    code: 53,
    domain: "script",
    copy: "The recoverable compensation reserve was changed.",
    rustVariant: "CompensationSeedMismatch",
  },
  SCRIPT_OPERATION_LAYOUT_MISMATCH: {
    code: 54,
    domain: "script",
    copy: "The transaction layout does not match the requested harvest operation.",
    rustVariant: "OperationLayoutMismatch",
  },
  SCRIPT_DUPLICATE_JOB: {
    code: 55,
    domain: "script",
    copy: "The transaction contains more than one harvest job or successor.",
    rustVariant: "DuplicateJob",
  },
  SCRIPT_POLICY_VERSION_MISMATCH: {
    code: 56,
    domain: "script",
    copy: "The job and harvest policy versions do not match.",
    rustVariant: "PolicyVersionMismatch",
  },
  SDK_MALFORMED_DATA: {
    code: 1000,
    domain: "sdk",
    copy: "The received job data is malformed.",
  },
  SDK_UNSUPPORTED_VERSION: {
    code: 1001,
    domain: "sdk",
    copy: "The received protocol version is not supported.",
  },
  SDK_UNSAFE_INTEGER: {
    code: 1002,
    domain: "sdk",
    copy: "An integer cannot be represented without losing precision.",
  },
  SDK_WRONG_NETWORK: {
    code: 1003,
    domain: "sdk",
    copy: "The data belongs to a different CKB network.",
  },
  SDK_MANIFEST_MISMATCH: {
    code: 1004,
    domain: "sdk",
    copy: "The deployment manifest does not match the expected scripts.",
  },
  SDK_STALE_CELL: {
    code: 1005,
    domain: "sdk",
    copy: "The selected job cell is no longer live.",
  },
  SDK_STALE_QUOTE: {
    code: 1006,
    domain: "sdk",
    copy: "The transaction quote has expired.",
  },
  SDK_INTENT_MISMATCH: {
    code: 1007,
    domain: "sdk",
    copy: "The transaction does not match the reviewed intent.",
  },
  SDK_WALLET_REJECTED: {
    code: 1008,
    domain: "sdk",
    copy: "The wallet did not approve the transaction.",
  },
  SDK_RPC_FAILURE: {
    code: 1009,
    domain: "sdk",
    copy: "The CKB node request failed.",
  },
  API_VALIDATION_FAILED: {
    code: 2000,
    domain: "api",
    copy: "The request contains invalid values.",
  },
  API_WRONG_NETWORK: {
    code: 2001,
    domain: "api",
    copy: "The request targets a different CKB network.",
  },
  API_JOB_NOT_FOUND: {
    code: 2002,
    domain: "api",
    copy: "The requested job was not found.",
  },
  API_JOB_NOT_LIVE: {
    code: 2003,
    domain: "api",
    copy: "The requested job is no longer live.",
  },
  API_QUOTE_EXPIRED: {
    code: 2004,
    domain: "api",
    copy: "The transaction quote has expired.",
  },
  API_POLICY_UNSUPPORTED: {
    code: 2005,
    domain: "api",
    copy: "The requested policy is not supported.",
  },
  API_OWNER_MISMATCH: {
    code: 2006,
    domain: "api",
    copy: "The connected wallet is not the job owner.",
  },
  API_RATE_LIMITED: {
    code: 2007,
    domain: "api",
    copy: "Too many requests were received; retry later.",
  },
  API_RPC_UNAVAILABLE: {
    code: 2008,
    domain: "api",
    copy: "The CKB node is temporarily unavailable.",
  },
  API_INTERNAL_FAILURE: {
    code: 2099,
    domain: "api",
    copy: "The service could not complete the request.",
  },
  EXECUTOR_NOT_YET_ELIGIBLE: {
    code: 3000,
    domain: "executor",
    copy: "The job has not reached its eligibility bound.",
  },
  EXECUTOR_PREPARE_WINDOW_MISSED: {
    code: 3001,
    domain: "executor",
    copy: "The safe preparation window was missed.",
  },
  EXECUTOR_ALREADY_CONSUMED: {
    code: 3002,
    domain: "executor",
    copy: "Another transaction already consumed the job.",
  },
  EXECUTOR_INPUT_CONFLICT: {
    code: 3003,
    domain: "executor",
    copy: "A transaction input conflicts with another transaction.",
  },
  EXECUTOR_INSUFFICIENT_JOB_BUDGET: {
    code: 3004,
    domain: "executor",
    copy: "The job budget cannot fund the requested action.",
  },
  EXECUTOR_REWARD_BELOW_MINIMUM: {
    code: 3005,
    domain: "executor",
    copy: "The reward is below the operator minimum.",
  },
  EXECUTOR_POLICY_VERSION_UNSUPPORTED: {
    code: 3006,
    domain: "executor",
    copy: "The executor does not support this policy version.",
  },
  EXECUTOR_PAYLOAD_HASH_MISMATCH: {
    code: 3007,
    domain: "executor",
    copy: "The policy payload does not match its commitment.",
  },
  EXECUTOR_INVALID_APPLICATION_STATE: {
    code: 3008,
    domain: "executor",
    copy: "The application state does not permit execution.",
  },
  EXECUTOR_MISSING_HEADER: {
    code: 3009,
    domain: "executor",
    copy: "A required block header is unavailable.",
  },
  EXECUTOR_IMMATURE_SINCE: {
    code: 3010,
    domain: "executor",
    copy: "The transaction since condition has not matured.",
  },
  EXECUTOR_SIMULATION_REJECTED: {
    code: 3011,
    domain: "executor",
    copy: "CKB dry-run rejected the transaction.",
  },
  EXECUTOR_NODE_REJECTED: {
    code: 3012,
    domain: "executor",
    copy: "The CKB node rejected the submitted transaction.",
  },
  EXECUTOR_FEE_INPUT_UNAVAILABLE: {
    code: 3013,
    domain: "executor",
    copy: "No eligible fee input is currently available.",
  },
  EXECUTOR_TX_DROPPED: {
    code: 3014,
    domain: "executor",
    copy: "The submitted transaction was dropped.",
  },
  EXECUTOR_TX_REORGED: {
    code: 3015,
    domain: "executor",
    copy: "The committed transaction was removed by a reorganization.",
  },
  EXECUTOR_JOB_EXPIRED: {
    code: 3016,
    domain: "executor",
    copy: "The policy proves that the job has expired.",
  },
  EXECUTOR_JOB_CANCELLED: {
    code: 3017,
    domain: "executor",
    copy: "The owner cancelled the job.",
  },
  EXECUTOR_RECOVERY_REQUIRED: {
    code: 3018,
    domain: "executor",
    copy: "The job requires an owner recovery action.",
  },
  EXECUTOR_BUILD_FAILED: {
    code: 3019,
    domain: "executor",
    copy: "The executor could not build the transaction.",
  },
  EXECUTOR_ADAPTER_MISMATCH: {
    code: 3020,
    domain: "executor",
    copy: "Eligibility and transaction building selected different policy adapters.",
  },
  EXECUTOR_BUILD_CLAIM_LOST: {
    code: 3021,
    domain: "executor",
    copy: "The transaction build lease expired before completion.",
  },
  EXECUTOR_CHAIN_SNAPSHOT_MOVED: {
    code: 3022,
    domain: "executor",
    copy: "The canonical chain changed while the transaction snapshot was assembled.",
  },
  EXECUTOR_STALE_OUTPOINT: {
    code: 3023,
    domain: "executor",
    copy: "The selected job outpoint is no longer live.",
  },
  EXECUTOR_BUILD_RECORD_INVALID: {
    code: 3024,
    domain: "executor",
    copy: "The stored transaction build record is invalid.",
  },
  EXECUTOR_FEE_MISMATCH: {
    code: 3025,
    domain: "executor",
    copy: "The built transaction fee differs from the configured fee.",
  },
  EXECUTOR_REWARD_INVALID: {
    code: 3026,
    domain: "executor",
    copy: "The built transaction does not preserve the committed reward.",
  },
  EXECUTOR_CYCLE_LIMIT_EXCEEDED: {
    code: 3027,
    domain: "executor",
    copy: "The transaction exceeds the configured cycle limit.",
  },
  EXECUTOR_UNPROFITABLE: {
    code: 3028,
    domain: "executor",
    copy: "The transaction does not meet the configured profit margin.",
  },
  EXECUTOR_SUBMISSION_RECORD_INVALID: {
    code: 3029,
    domain: "executor",
    copy: "The approved transaction submission record is invalid.",
  },
  EXECUTOR_SUBMISSION_HASH_MISMATCH: {
    code: 3030,
    domain: "executor",
    copy: "The submitted transaction hash differs from the approved intent.",
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorKey = keyof typeof ERROR_CATALOG;
export type ScriptErrorKey = {
  [Key in ErrorKey]: (typeof ERROR_CATALOG)[Key]["domain"] extends "script" ? Key : never;
}[ErrorKey];

export const INVALID_TRANSITION_DIAGNOSTICS = {
  malformed_job_data: "SCRIPT_INVALID_DATA",
  unsupported_job_version: "SCRIPT_UNSUPPORTED_VERSION",
  reserved_flags_set: "SCRIPT_RESERVED_FLAGS",
  non_live_job_state: "SCRIPT_INVALID_STATE",
  unsupported_trigger: "SCRIPT_UNSUPPORTED_TRIGGER",
  invalid_witness_mode: "SCRIPT_INVALID_WITNESS_MODE",
  missing_owner_authorization: "SCRIPT_MISSING_OWNER_AUTHORIZATION",
  changed_policy: "SCRIPT_POLICY_HASH_MISMATCH",
  changed_trigger_parameters: "SCRIPT_TRIGGER_HASH_MISMATCH",
  changed_policy_payload: "SCRIPT_PAYLOAD_HASH_MISMATCH",
  changed_job_identity: "SCRIPT_JOB_ID_MISMATCH",
  invalid_successor_sequence: "SCRIPT_SEQUENCE_MISMATCH",
  early_execution: "SCRIPT_NOT_YET_ELIGIBLE",
  invalid_since_value: "SCRIPT_INVALID_SINCE",
  invalid_successor_count: "SCRIPT_SUCCESSOR_COUNT_MISMATCH",
  changed_successor_invariant: "SCRIPT_SUCCESSOR_INVARIANT_MISMATCH",
  unauthorized_budget_increase: "SCRIPT_BUDGET_INCREASE",
  increased_remaining_runs: "SCRIPT_RUNS_INCREASE",
  lost_job_capacity: "SCRIPT_CAPACITY_NOT_CONSERVED",
  changed_reward_amount: "SCRIPT_REWARD_AMOUNT_MISMATCH",
  redirected_reward: "SCRIPT_REWARD_RECIPIENT_MISMATCH",
  reward_on_owner_exit: "SCRIPT_REWARD_FORBIDDEN",
  invalid_application_transition: "SCRIPT_INVALID_APPLICATION_STATE",
  missing_required_header: "SCRIPT_MISSING_HEADER",
  arithmetic_overflow: "SCRIPT_ARITHMETIC_OVERFLOW",
  unsupported_recovery: "SCRIPT_UNSUPPORTED_RECOVERY",
  invalid_dao_cell: "SCRIPT_INVALID_DAO_CELL",
  changed_principal: "SCRIPT_PRINCIPAL_MISMATCH",
  redirected_compensation: "SCRIPT_PAYOUT_MISMATCH",
  unauthorized_prepare_executor: "SCRIPT_UNAUTHORIZED_EXECUTOR",
  compensation_below_minimum: "SCRIPT_COMPENSATION_BELOW_MINIMUM",
  cycle_limit_reached: "SCRIPT_CYCLE_LIMIT_REACHED",
  invalid_prepare_executor_set: "SCRIPT_INVALID_EXECUTOR_SET",
  missing_bound_dao_harvest_job: "SCRIPT_MISSING_BOUND_JOB",
  invalid_compensation_cell: "SCRIPT_INVALID_COMPENSATION_CELL",
  changed_compensation_binding: "SCRIPT_COMPENSATION_BINDING_MISMATCH",
  changed_compensation_delta: "SCRIPT_COMPENSATION_DELTA_MISMATCH",
  malformed_prepare_credit: "SCRIPT_INVALID_PREPARE_CREDIT",
  changed_prepare_credit: "SCRIPT_PREPARE_CREDIT_MISMATCH",
  wrong_preferred_operator: "SCRIPT_UNAUTHORIZED_PREFERRED_OPERATOR",
  early_operator_takeover: "SCRIPT_TAKEOVER_NOT_REACHED",
  invalid_operator_accumulator: "SCRIPT_INVALID_OPERATOR_ACCUMULATOR",
  changed_service_fee: "SCRIPT_SERVICE_FEE_MISMATCH",
  changed_compensation_seed: "SCRIPT_COMPENSATION_SEED_MISMATCH",
  invalid_harvest_operation_layout: "SCRIPT_OPERATION_LAYOUT_MISMATCH",
  duplicate_harvest_job: "SCRIPT_DUPLICATE_JOB",
  mixed_harvest_policy_version: "SCRIPT_POLICY_VERSION_MISMATCH",
} as const satisfies Record<string, ScriptErrorKey>;

export function getErrorDefinition(key: ErrorKey): ErrorDefinition {
  return ERROR_CATALOG[key];
}
