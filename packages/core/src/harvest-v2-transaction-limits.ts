import { serializeTransaction } from "@nervosnetwork/ckb-sdk-utils";

import type { IntegerInput } from "./chain-values.ts";
import type { UnsignedDeadlineTransaction } from "./deadline-creation.ts";

export const HARVEST_V2_TRANSACTION_OPERATIONS = [
  "setup",
  "prepare",
  "claim",
  "sweep",
  "rotation",
  "recovery",
] as const;

export type HarvestV2TransactionOperation = (typeof HARVEST_V2_TRANSACTION_OPERATIONS)[number];

export interface HarvestV2TransactionLimit {
  readonly maximumBytes: bigint;
  readonly maximumCycles: bigint;
  readonly maximumFeeRatePerKilobyte: bigint;
  readonly maximumFee: bigint;
  readonly maximumInputs: number;
  readonly maximumOutputs: number;
  readonly maximumHeaderDeps: number;
  readonly maximumCellDeps: number;
  readonly requiredJobInputs: 0 | 1;
  readonly permittedJobOutputs: readonly (0 | 1)[];
}

const MAXIMUM_FEE_RATE = 100_000n;

function limit(
  maximumBytes: bigint,
  maximumCycles: bigint,
  maximumInputs: number,
  maximumOutputs: number,
  maximumHeaderDeps: number,
  maximumCellDeps: number,
  requiredJobInputs: 0 | 1,
  permittedJobOutputs: readonly (0 | 1)[],
): HarvestV2TransactionLimit {
  return Object.freeze({
    maximumBytes,
    maximumCycles,
    maximumFeeRatePerKilobyte: MAXIMUM_FEE_RATE,
    maximumFee: (maximumBytes * MAXIMUM_FEE_RATE + 999n) / 1_000n,
    maximumInputs,
    maximumOutputs,
    maximumHeaderDeps,
    maximumCellDeps,
    requiredJobInputs,
    permittedJobOutputs: Object.freeze([...permittedJobOutputs]),
  });
}

export const HARVEST_V2_TRANSACTION_LIMITS = Object.freeze({
  setup: limit(4_096n, 3_000_000n, 16, 8, 0, 8, 0, [1]),
  prepare: limit(3_072n, 1_200_000n, 4, 4, 1, 8, 1, [1]),
  claim: limit(4_096n, 4_000_000n, 8, 8, 2, 8, 1, [0, 1]),
  sweep: limit(2_048n, 2_500_000n, 3, 3, 0, 6, 1, [1]),
  rotation: limit(3_072n, 3_000_000n, 3, 3, 0, 8, 1, [1]),
  recovery: limit(4_096n, 4_000_000n, 6, 6, 2, 8, 1, [0]),
} satisfies Readonly<Record<HarvestV2TransactionOperation, HarvestV2TransactionLimit>>);

export type HarvestV2TransactionLimitErrorCode =
  | "HARVEST_V2_BYTES_EXCEEDED"
  | "HARVEST_V2_CYCLES_EXCEEDED"
  | "HARVEST_V2_FEE_RATE_EXCEEDED"
  | "HARVEST_V2_FEE_EXCEEDED"
  | "HARVEST_V2_INPUTS_EXCEEDED"
  | "HARVEST_V2_OUTPUTS_EXCEEDED"
  | "HARVEST_V2_HEADER_DEPS_EXCEEDED"
  | "HARVEST_V2_CELL_DEPS_EXCEEDED"
  | "HARVEST_V2_JOB_INPUT_COUNT_INVALID"
  | "HARVEST_V2_JOB_OUTPUT_COUNT_INVALID";

export class HarvestV2TransactionLimitError extends Error {
  readonly code: HarvestV2TransactionLimitErrorCode;

  constructor(code: HarvestV2TransactionLimitErrorCode, message: string) {
    super(message);
    this.name = "HarvestV2TransactionLimitError";
    this.code = code;
  }
}

function parseNonNegativeInteger(value: IntegerInput, name: string): bigint {
  let parsed: bigint;
  if (typeof value === "bigint") {
    parsed = value;
  } else if (/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || /^(?:0|[1-9][0-9]*)$/.test(value)) {
    parsed = BigInt(value);
  } else {
    throw new TypeError(`${name} must be a canonical decimal or lowercase hexadecimal integer`);
  }
  if (parsed < 0n) throw new RangeError(`${name} must be non-negative`);
  return parsed;
}

export function serializedTransactionBytes(transaction: UnsignedDeadlineTransaction): bigint {
  const encoded = serializeTransaction(transaction as unknown as CKBComponents.RawTransaction);
  return BigInt((encoded.length - 2) / 2);
}

export interface HarvestV2TransactionBoundaryInput {
  readonly operation: HarvestV2TransactionOperation;
  readonly transaction: UnsignedDeadlineTransaction;
  readonly dryRunCycles: IntegerInput;
  readonly feeRatePerKilobyte: IntegerInput;
  readonly networkFee: IntegerInput;
  readonly jobInputCount: number;
  readonly jobOutputCount: number;
}

export interface HarvestV2TransactionBoundaryEvidence {
  readonly operation: HarvestV2TransactionOperation;
  readonly serializedBytes: bigint;
  readonly dryRunCycles: bigint;
  readonly feeRatePerKilobyte: bigint;
  readonly networkFee: bigint;
}

export function assertHarvestV2TransactionWithinLimits(
  input: HarvestV2TransactionBoundaryInput,
): HarvestV2TransactionBoundaryEvidence {
  const limits = HARVEST_V2_TRANSACTION_LIMITS[input.operation];
  const serializedBytes = serializedTransactionBytes(input.transaction);
  const dryRunCycles = parseNonNegativeInteger(input.dryRunCycles, "dry-run cycles");
  const feeRate = parseNonNegativeInteger(input.feeRatePerKilobyte, "fee rate");
  const networkFee = parseNonNegativeInteger(input.networkFee, "network fee");
  const transactionFeeAtRate = (serializedBytes * feeRate + 999n) / 1_000n;

  const checks: readonly [boolean, HarvestV2TransactionLimitError][] = [
    [
      serializedBytes <= limits.maximumBytes,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_BYTES_EXCEEDED",
        `${input.operation} transaction is ${serializedBytes} bytes; maximum is ${limits.maximumBytes}`,
      ),
    ],
    [
      dryRunCycles <= limits.maximumCycles,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_CYCLES_EXCEEDED",
        `${input.operation} dry-run used ${dryRunCycles} cycles; maximum is ${limits.maximumCycles}`,
      ),
    ],
    [
      feeRate <= limits.maximumFeeRatePerKilobyte,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_FEE_RATE_EXCEEDED",
        `${input.operation} fee rate is ${feeRate}; maximum is ${limits.maximumFeeRatePerKilobyte}`,
      ),
    ],
    [
      networkFee <= limits.maximumFee && networkFee <= transactionFeeAtRate,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_FEE_EXCEEDED",
        `${input.operation} fee is ${networkFee}; maximum is ${transactionFeeAtRate} at the declared rate and ${limits.maximumFee} overall`,
      ),
    ],
    [
      input.transaction.inputs.length <= limits.maximumInputs,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_INPUTS_EXCEEDED",
        `${input.operation} has too many inputs`,
      ),
    ],
    [
      input.transaction.outputs.length <= limits.maximumOutputs,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_OUTPUTS_EXCEEDED",
        `${input.operation} has too many outputs`,
      ),
    ],
    [
      input.transaction.headerDeps.length <= limits.maximumHeaderDeps,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_HEADER_DEPS_EXCEEDED",
        `${input.operation} has too many header dependencies`,
      ),
    ],
    [
      input.transaction.cellDeps.length <= limits.maximumCellDeps,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_CELL_DEPS_EXCEEDED",
        `${input.operation} has too many cell dependencies`,
      ),
    ],
    [
      input.jobInputCount === limits.requiredJobInputs,
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_JOB_INPUT_COUNT_INVALID",
        `${input.operation} must consume exactly ${limits.requiredJobInputs} Job Cell(s)`,
      ),
    ],
    [
      limits.permittedJobOutputs.includes(input.jobOutputCount as 0 | 1),
      new HarvestV2TransactionLimitError(
        "HARVEST_V2_JOB_OUTPUT_COUNT_INVALID",
        `${input.operation} has an invalid Job Cell successor count`,
      ),
    ],
  ];

  for (const [valid, error] of checks) {
    if (!valid) throw error;
  }

  return Object.freeze({
    operation: input.operation,
    serializedBytes,
    dryRunCycles,
    feeRatePerKilobyte: feeRate,
    networkFee,
  });
}
