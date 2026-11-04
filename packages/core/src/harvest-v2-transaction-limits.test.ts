import assert from "node:assert/strict";
import test from "node:test";

import {
  HARVEST_V2_TRANSACTION_LIMITS,
  HARVEST_V2_TRANSACTION_OPERATIONS,
  HarvestV2TransactionLimitError,
  assertHarvestV2TransactionWithinLimits,
  serializedTransactionBytes,
  type HarvestV2TransactionOperation,
} from "./harvest-v2-transaction-limits.ts";
import { parseHash32 } from "./chain-values.ts";
import type { UnsignedDeadlineTransaction } from "./deadline-creation.ts";

const HASH = parseHash32(`0x${"11".repeat(32)}`);

function transaction(): UnsignedDeadlineTransaction {
  return {
    version: "0x0",
    cellDeps: [],
    headerDeps: [],
    inputs: [{ since: "0x0", previousOutput: { txHash: HASH, index: "0x0" } }],
    outputs: [
      {
        capacity: "0x174876e800",
        lock: { codeHash: HASH, hashType: "type", args: "0x" },
        type: null,
      },
    ],
    outputsData: ["0x"],
    witnesses: ["0x"],
  };
}

function boundaryInput(
  operation: HarvestV2TransactionOperation,
  override: Partial<Parameters<typeof assertHarvestV2TransactionWithinLimits>[0]> = {},
) {
  const limits = HARVEST_V2_TRANSACTION_LIMITS[operation];
  const builtTransaction = override.transaction ?? transaction();
  const feeRate = override.feeRatePerKilobyte ?? limits.maximumFeeRatePerKilobyte;
  const measuredBytes = serializedTransactionBytes(builtTransaction);
  return {
    operation,
    transaction: builtTransaction,
    dryRunCycles: limits.maximumCycles,
    feeRatePerKilobyte: feeRate,
    networkFee: (measuredBytes * BigInt(feeRate) + 999n) / 1_000n,
    jobInputCount: limits.requiredJobInputs,
    jobOutputCount: limits.permittedJobOutputs[0]!,
    ...override,
  } as const;
}

function expectCode(code: HarvestV2TransactionLimitError["code"], run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert(error instanceof HarvestV2TransactionLimitError);
    assert.equal(error.code, code);
    return true;
  });
}

function transactionWithSerializedSize(target: bigint): UnsignedDeadlineTransaction {
  const base = transaction();
  const baseBytes = serializedTransactionBytes(base);
  assert(target >= baseBytes);
  const paddingBytes = Number(target - baseBytes);
  const padded = { ...base, witnesses: [`0x${"00".repeat(paddingBytes)}`] } as const;
  assert.equal(serializedTransactionBytes(padded), target);
  return padded;
}

test("every v2 operation accepts its documented exact boundaries", () => {
  for (const operation of HARVEST_V2_TRANSACTION_OPERATIONS) {
    const evidence = assertHarvestV2TransactionWithinLimits(boundaryInput(operation));
    assert.equal(evidence.operation, operation);
    assert.equal(evidence.dryRunCycles, HARVEST_V2_TRANSACTION_LIMITS[operation].maximumCycles);
  }
});

test("signed serialized size accepts the byte ceiling and rejects one byte over", () => {
  const limit = HARVEST_V2_TRANSACTION_LIMITS.sweep.maximumBytes;
  assertHarvestV2TransactionWithinLimits(
    boundaryInput("sweep", { transaction: transactionWithSerializedSize(limit) }),
  );
  expectCode("HARVEST_V2_BYTES_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(
      boundaryInput("sweep", { transaction: transactionWithSerializedSize(limit + 1n) }),
    ),
  );
});

test("RPC dry-run cycle evidence is mandatory and bounded", () => {
  const maximum = HARVEST_V2_TRANSACTION_LIMITS.claim.maximumCycles;
  expectCode("HARVEST_V2_CYCLES_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(boundaryInput("claim", { dryRunCycles: maximum + 1n })),
  );
  assert.throws(
    () =>
      assertHarvestV2TransactionWithinLimits(boundaryInput("claim", { dryRunCycles: "invalid" })),
    TypeError,
  );
});

test("fee rate and absolute network fee each fail closed", () => {
  const limits = HARVEST_V2_TRANSACTION_LIMITS.setup;
  expectCode("HARVEST_V2_FEE_RATE_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(
      boundaryInput("setup", { feeRatePerKilobyte: limits.maximumFeeRatePerKilobyte + 1n }),
    ),
  );
  expectCode("HARVEST_V2_FEE_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(
      boundaryInput("setup", { networkFee: limits.maximumFee + 1n }),
    ),
  );
  expectCode("HARVEST_V2_FEE_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(
      boundaryInput("setup", {
        feeRatePerKilobyte: 1_000n,
        networkFee: 1_000_000n,
      }),
    ),
  );
});

test("RPC evidence uses canonical integer strings", () => {
  assert.throws(
    () => assertHarvestV2TransactionWithinLimits(boundaryInput("prepare", { dryRunCycles: "01" })),
    TypeError,
  );
  assert.throws(
    () =>
      assertHarvestV2TransactionWithinLimits(
        boundaryInput("prepare", { feeRatePerKilobyte: "0x01" }),
      ),
    TypeError,
  );
});

test("operation shape limits reject one extra input, output, header, or dependency", () => {
  const limits = HARVEST_V2_TRANSACTION_LIMITS.claim;
  const base = transaction();
  const input = base.inputs[0]!;
  const output = base.outputs[0]!;
  const dep = { outPoint: { txHash: HASH, index: "0x0" as const }, depType: "code" as const };

  expectCode("HARVEST_V2_INPUTS_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(
      boundaryInput("claim", {
        transaction: {
          ...base,
          inputs: Array.from({ length: limits.maximumInputs + 1 }, () => ({ ...input })),
        },
      }),
    ),
  );
  expectCode("HARVEST_V2_OUTPUTS_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(
      boundaryInput("claim", {
        transaction: {
          ...base,
          outputs: Array.from({ length: limits.maximumOutputs + 1 }, () => ({ ...output })),
          outputsData: Array(limits.maximumOutputs + 1).fill("0x"),
        },
      }),
    ),
  );
  expectCode("HARVEST_V2_HEADER_DEPS_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(
      boundaryInput("claim", {
        transaction: { ...base, headerDeps: Array(limits.maximumHeaderDeps + 1).fill(HASH) },
      }),
    ),
  );
  expectCode("HARVEST_V2_CELL_DEPS_EXCEEDED", () =>
    assertHarvestV2TransactionWithinLimits(
      boundaryInput("claim", {
        transaction: {
          ...base,
          cellDeps: Array.from({ length: limits.maximumCellDeps + 1 }, () => ({ ...dep })),
        },
      }),
    ),
  );
});

test("setup creates the initial Job while transitions reject cross-job batching", () => {
  assertHarvestV2TransactionWithinLimits(
    boundaryInput("setup", { jobInputCount: 0, jobOutputCount: 1 }),
  );
  expectCode("HARVEST_V2_JOB_INPUT_COUNT_INVALID", () =>
    assertHarvestV2TransactionWithinLimits(boundaryInput("setup", { jobInputCount: 1 })),
  );
  for (const jobInputCount of [0, 2]) {
    expectCode("HARVEST_V2_JOB_INPUT_COUNT_INVALID", () =>
      assertHarvestV2TransactionWithinLimits(boundaryInput("recovery", { jobInputCount })),
    );
  }
  expectCode("HARVEST_V2_JOB_OUTPUT_COUNT_INVALID", () =>
    assertHarvestV2TransactionWithinLimits(boundaryInput("prepare", { jobOutputCount: 0 })),
  );
  assertHarvestV2TransactionWithinLimits(boundaryInput("claim", { jobOutputCount: 0 }));
  assertHarvestV2TransactionWithinLimits(boundaryInput("claim", { jobOutputCount: 1 }));
});

test("limits retain auditable margins over measured v1 policy paths", () => {
  assert(HARVEST_V2_TRANSACTION_LIMITS.prepare.maximumCycles >= 2n * 600_000n);
  assert(HARVEST_V2_TRANSACTION_LIMITS.claim.maximumCycles >= 8n * 500_000n);
});
