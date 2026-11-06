import assert from "node:assert/strict";
import test from "node:test";

import {
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
} from "@ckb-automata/molecule";
import { scriptToHash, serializeWitnessArgs } from "@nervosnetwork/ckb-sdk-utils";

import type { Hash32 } from "./chain-values.ts";
import type { UnsignedDeadlineTransaction } from "./deadline-creation.ts";
import {
  absentDaoHarvestV2Indices,
  buildDaoHarvestV2Transaction,
  verifyCompletedDaoHarvestV2Transaction,
  type DaoHarvestV2BuilderInput,
} from "./dao-harvest-v2-builders.ts";
import {
  DAO_HARVEST_V2_ABSENT_INDEX,
  DAO_HARVEST_V2_OPERATIONS,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  encodeDaoHarvestV2FallbackOperatorProof,
  type DaoHarvestV2Operation,
  type DaoHarvestV2WitnessIndices,
} from "./dao-harvest-v2.ts";
import type { ScriptIdentity } from "./job-inspection.ts";

const hash = (value: string): Hash32 => `0x${value.repeat(64)}` as Hash32;
const script = (value: string): ScriptIdentity => ({
  codeHash: hash(value),
  hashType: "data1",
  args: "0x",
});
const owner = script("a");
const fundingLockHash = scriptToHash(owner) as Hash32;
const relativeEpoch = ((1n << 63n) | (1n << 61n) | 1n).toString();
const absoluteEpoch = ((1n << 61n) | 100n).toString();
const fallbackOperators = [Uint8Array.from(Buffer.from(hash("1").slice(2), "hex"))];
const fallbackOperatorProof = encodeDaoHarvestV2FallbackOperatorProof(fallbackOperators);
const fallbackOperatorSetHash = deriveDaoHarvestV2FallbackOperatorSetHash(fallbackOperators);

const payload = DaoHarvestPayloadV2.pack({
  version: 2,
  owner_lock_hash: [...Buffer.from(hash("a").slice(2), "hex")],
  payout_lock_hash: [...Buffer.from(hash("b").slice(2), "hex")],
  vault_lock_code_hash: [...Buffer.from(hash("c").slice(2), "hex")],
  compensation_lock_code_hash: [...Buffer.from(hash("d").slice(2), "hex")],
  dao_type_hash: [...Buffer.from(hash("e").slice(2), "hex")],
  principal_capacity: "1000",
  preferred_prepare_operator_lock_hash: [...Buffer.from(hash("1").slice(2), "hex")],
  fallback_prepare_executor_set_hash: [...fallbackOperatorSetHash],
  prepare_service_fee: "10",
  claim_service_fee: "20",
  compensation_seed_capacity: "201",
  prepare_buffer_epochs: relativeEpoch,
  takeover_delay_epochs: relativeEpoch,
  confirmation_margin_epochs: relativeEpoch,
  total_cycles: 2,
  end_epoch_since: absoluteEpoch,
});
const progress = DaoHarvestProgressV2.pack({
  version: 2,
  state: 0,
  cycle_index: 0,
  prepare_credit_hash: Array(32).fill(0),
});
const credit = DaoHarvestPrepareCreditV2.pack({
  version: 2,
  job_id: Array(32).fill(3),
  cycle_index: 0,
  preparer_lock_hash: Array(32).fill(4),
  prepared_vault_output_index: 1,
  job_output_index: 0,
});

function indicesFor(operation: DaoHarvestV2Operation): DaoHarvestV2WitnessIndices {
  const absent = absentDaoHarvestV2Indices();
  const present = (names: readonly (keyof DaoHarvestV2WitnessIndices)[]) =>
    Object.freeze({ ...absent, ...Object.fromEntries(names.map((name, index) => [name, index])) });
  switch (operation) {
    case DAO_HARVEST_V2_OPERATIONS.SETUP:
      return present([
        "identityInputIndex",
        "jobOutputIndex",
        "vaultOutputIndex",
        "compensationOutputIndex",
      ]);
    case DAO_HARVEST_V2_OPERATIONS.PREFERRED_PREPARE:
    case DAO_HARVEST_V2_OPERATIONS.FALLBACK_PREPARE:
      return present([
        "jobInputIndex",
        "vaultInputIndex",
        "identityInputIndex",
        "prepareAccumulatorInputIndex",
        "jobOutputIndex",
        "vaultOutputIndex",
        "prepareAccumulatorOutputIndex",
      ]);
    case DAO_HARVEST_V2_OPERATIONS.PREFERRED_CLAIM:
    case DAO_HARVEST_V2_OPERATIONS.OWNER_COMPLETE:
      return present([
        "jobInputIndex",
        "vaultInputIndex",
        "compensationInputIndex",
        "identityInputIndex",
        "prepareAccumulatorInputIndex",
        "jobOutputIndex",
        "vaultOutputIndex",
        "compensationOutputIndex",
        "prepareAccumulatorOutputIndex",
      ]);
    case DAO_HARVEST_V2_OPERATIONS.FALLBACK_CLAIM:
      return present([
        "jobInputIndex",
        "vaultInputIndex",
        "compensationInputIndex",
        "identityInputIndex",
        "prepareAccumulatorInputIndex",
        "claimAccumulatorInputIndex",
        "jobOutputIndex",
        "vaultOutputIndex",
        "compensationOutputIndex",
        "prepareAccumulatorOutputIndex",
        "claimAccumulatorOutputIndex",
      ]);
    case DAO_HARVEST_V2_OPERATIONS.SWEEP:
    case DAO_HARVEST_V2_OPERATIONS.ROTATE:
      return present([
        "jobInputIndex",
        "compensationInputIndex",
        "identityInputIndex",
        "jobOutputIndex",
        "compensationOutputIndex",
      ]);
    case DAO_HARVEST_V2_OPERATIONS.CLOSE:
      return present(["compensationInputIndex", "identityInputIndex"]);
    case DAO_HARVEST_V2_OPERATIONS.RECOVER:
      return present([
        "jobInputIndex",
        "vaultInputIndex",
        "compensationInputIndex",
        "identityInputIndex",
      ]);
  }
}

function builderInput(
  operation: DaoHarvestV2Operation = DAO_HARVEST_V2_OPERATIONS.SETUP,
): DaoHarvestV2BuilderInput {
  const indices = indicesFor(operation);
  const requiredInputs = Math.max(
    0,
    ...Object.entries(indices)
      .filter(
        ([name, value]) => name.endsWith("InputIndex") && value !== DAO_HARVEST_V2_ABSENT_INDEX,
      )
      .map(([, value]) => value + 1),
  );
  const requiredOutputs = Math.max(
    0,
    ...Object.entries(indices)
      .filter(
        ([name, value]) => name.endsWith("OutputIndex") && value !== DAO_HARVEST_V2_ABSENT_INDEX,
      )
      .map(([, value]) => value + 1),
  );
  const creditRequired = [1, 2, 3, 4, 5].includes(operation);
  const proofRequired = [0, 2, 8].includes(operation);
  const outputCapacities =
    operation === DAO_HARVEST_V2_OPERATIONS.SETUP
      ? [300n, 300n, 300n, 401n]
      : Array<bigint>(requiredOutputs).fill(1n);
  const optionalEnvelopes = {
    ...(creditRequired ? { prepareCredit: credit } : {}),
    ...(proofRequired ? { operatorProof: fallbackOperatorProof } : {}),
    ...(operation === DAO_HARVEST_V2_OPERATIONS.ROTATE ? { successorPayload: payload } : {}),
  };
  return {
    operation,
    policyScriptHash: hash("f"),
    payload,
    progress,
    ...optionalEnvelopes,
    indices,
    cellDeps: [{ outPoint: { txHash: hash("1"), index: "0x0" }, depType: "code" }],
    headerDeps: [hash("2")],
    inputs: Array.from({ length: requiredInputs }, (_, index) => ({
      since: "0x0",
      previousOutput: { txHash: hash(((index + 3) % 10).toString()), index: "0x0" },
    })),
    inputCapacities:
      operation === DAO_HARVEST_V2_OPERATIONS.SETUP
        ? [1_301n]
        : Array<bigint>(requiredInputs).fill(100n),
    outputs: Array.from({ length: requiredOutputs }, (_, index) => ({
      capacity: `0x${outputCapacities[index]!.toString(16)}` as `0x${string}`,
      lock: owner,
      type: null,
    })),
    outputsData: Array(requiredOutputs).fill("0x"),
    allowedFundingLockHashes: [fundingLockHash],
    economics: {
      originalAmount: 1_000n,
      expectedCompensation: 50n,
      prepareServiceCharge: 10n,
      claimServiceCharge: 20n,
      maximumNetworkFee: 10n,
      recoverableReserve: 201n,
      accumulatedCompensation: 30n,
      totalLockedAmount: outputCapacities.reduce((total, value) => total + value, 0n),
    },
  };
}

test("every V2 operation builds deterministically with a closed witness layout", () => {
  for (const operation of Object.values(DAO_HARVEST_V2_OPERATIONS) as DaoHarvestV2Operation[]) {
    const first = buildDaoHarvestV2Transaction(builderInput(operation));
    const second = buildDaoHarvestV2Transaction(builderInput(operation));
    assert.deepEqual(first, second);
    assert.equal(first.operation, operation);
    assert.match(first.intentHash, /^0x[0-9a-f]{64}$/);
  }
});

test("review separates protected value, charges, fee, reserve, and accumulation", () => {
  const review = buildDaoHarvestV2Transaction(builderInput()).review;
  assert.equal(review.originalAmount, 1_000n);
  assert.equal(review.expectedCompensation, 50n);
  assert.deepEqual(review.completedWorkCharges, { prepare: 10n, claim: 20n, maximumTotal: 30n });
  assert.equal(review.maximumNetworkFee, 10n);
  assert.equal(review.recoverableReserve, 201n);
  assert.equal(review.accumulatedCompensation, 30n);
  assert.equal(review.totalLockedAmount, 1_301n);
});

function completedTransaction(): {
  build: ReturnType<typeof buildDaoHarvestV2Transaction>;
  completed: UnsignedDeadlineTransaction;
} {
  const build = buildDaoHarvestV2Transaction(builderInput());
  const fundingInput = {
    since: "0x0" as const,
    previousOutput: { txHash: hash("9"), index: "0x0" as const },
  };
  const completed = {
    ...build.transaction,
    inputs: [...build.transaction.inputs, fundingInput],
    outputs: [...build.transaction.outputs, { capacity: "0x28" as const, lock: owner, type: null }],
    outputsData: [...build.transaction.outputsData, "0x" as const],
    witnesses: [...build.transaction.witnesses, "0x" as const],
  };
  return { build, completed };
}

function replaceWitnessLock(witness: string, lock: string): `0x${string}` {
  const bytes = Uint8Array.from(Buffer.from(witness.slice(2), "hex"));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const second = view.getUint32(8, true);
  const third = view.getUint32(12, true);
  const field = (start: number, end: number) =>
    end === start ? "0x" : `0x${Buffer.from(bytes.slice(start + 4, end)).toString("hex")}`;
  return serializeWitnessArgs({
    lock,
    inputType: field(second, third),
    outputType: field(third, bytes.length),
  }) as `0x${string}`;
}

test("wallet completion may add only the signature field to a reviewed policy witness", () => {
  const { build, completed } = completedTransaction();
  const funding = [
    { outPoint: completed.inputs.at(-1)!.previousOutput, capacity: 50n, lockHash: fundingLockHash },
  ];
  const signed = {
    ...completed,
    witnesses: [
      replaceWitnessLock(completed.witnesses[0]!, `0x${"00".repeat(65)}`),
      ...completed.witnesses.slice(1),
    ],
  };
  assert.doesNotThrow(() => verifyCompletedDaoHarvestV2Transaction(build, signed, funding));
  assert.throws(() =>
    verifyCompletedDaoHarvestV2Transaction(
      build,
      {
        ...signed,
        witnesses: [
          serializeWitnessArgs({ lock: "", inputType: "0x01", outputType: "0x" }) as `0x${string}`,
          ...signed.witnesses.slice(1),
        ],
      },
      funding,
    ),
  );
});

test("wallet completion allows only reviewed funding, plain change, and the fee ceiling", () => {
  const { build, completed } = completedTransaction();
  const result = verifyCompletedDaoHarvestV2Transaction(build, completed, [
    { outPoint: completed.inputs.at(-1)!.previousOutput, capacity: 50n, lockHash: fundingLockHash },
  ]);
  assert.equal(result.addedInputCapacity, 50n);
  assert.equal(result.fee, 10n);

  const wrongFunding = [
    { outPoint: completed.inputs.at(-1)!.previousOutput, capacity: 50n, lockHash: hash("8") },
  ];
  assert.throws(() => verifyCompletedDaoHarvestV2Transaction(build, completed, wrongFunding));
  assert.throws(() =>
    verifyCompletedDaoHarvestV2Transaction(
      build,
      {
        ...completed,
        outputs: [
          ...completed.outputs.slice(0, -1),
          { ...completed.outputs.at(-1)!, capacity: "0x27" },
        ],
      },
      [
        {
          outPoint: completed.inputs.at(-1)!.previousOutput,
          capacity: 50n,
          lockHash: fundingLockHash,
        },
      ],
    ),
  );
  assert.throws(() =>
    verifyCompletedDaoHarvestV2Transaction(
      build,
      {
        ...completed,
        outputs: [
          ...completed.outputs.slice(0, -1),
          { ...completed.outputs.at(-1)!, lock: script("8") },
        ],
      },
      [
        {
          outPoint: completed.inputs.at(-1)!.previousOutput,
          capacity: 50n,
          lockHash: fundingLockHash,
        },
      ],
    ),
  );
});

test("wallet completion may reorder dependencies and add its funding lock dependency", () => {
  const input = builderInput();
  const build = buildDaoHarvestV2Transaction({
    ...input,
    cellDeps: [
      ...input.cellDeps,
      { outPoint: { txHash: hash("2"), index: "0x1" }, depType: "depGroup" },
    ],
  });
  const { completed: baseCompleted } = completedTransaction();
  const completed = {
    ...baseCompleted,
    cellDeps: build.transaction.cellDeps.toReversed(),
  };
  const funding = [
    { outPoint: completed.inputs.at(-1)!.previousOutput, capacity: 50n, lockHash: fundingLockHash },
  ];

  assert.doesNotThrow(() => verifyCompletedDaoHarvestV2Transaction(build, completed, funding));
  assert.doesNotThrow(() =>
    verifyCompletedDaoHarvestV2Transaction(
      build,
      {
        ...completed,
        cellDeps: [
          ...completed.cellDeps,
          { outPoint: { txHash: hash("3"), index: "0x0" }, depType: "code" },
        ],
      },
      funding,
    ),
  );
  assert.throws(() =>
    verifyCompletedDaoHarvestV2Transaction(
      build,
      { ...completed, cellDeps: completed.cellDeps.slice(1) },
      funding,
    ),
  );
  assert.throws(() =>
    verifyCompletedDaoHarvestV2Transaction(
      build,
      {
        ...completed,
        cellDeps: [{ ...completed.cellDeps[0]!, depType: "code" }, ...completed.cellDeps.slice(1)],
      },
      funding,
    ),
  );
});

test("wallet completion rejects every reviewed transaction surface mutation", () => {
  const { build, completed } = completedTransaction();
  const funding = [
    { outPoint: completed.inputs.at(-1)!.previousOutput, capacity: 50n, lockHash: fundingLockHash },
  ];
  const mutations: UnsignedDeadlineTransaction[] = [
    { ...completed, version: "0x1" as "0x0" },
    { ...completed, headerDeps: [hash("8")] },
    { ...completed, cellDeps: [{ ...completed.cellDeps[0]!, depType: "depGroup" }] },
    {
      ...completed,
      inputs: [{ ...completed.inputs[0]!, since: "0x1" }, ...completed.inputs.slice(1)],
    },
    {
      ...completed,
      outputs: [{ ...completed.outputs[0]!, capacity: "0x2" }, ...completed.outputs.slice(1)],
    },
    { ...completed, outputsData: ["0x01", ...completed.outputsData.slice(1)] },
    { ...completed, witnesses: ["0x", ...completed.witnesses.slice(1)] },
  ];
  for (const mutation of mutations) {
    assert.throws(() => verifyCompletedDaoHarvestV2Transaction(build, mutation, funding));
  }
});

test("intent changes when any reviewed policy or economic input changes", () => {
  const canonical = buildDaoHarvestV2Transaction(builderInput());
  const changedPayload = Uint8Array.from(payload);
  changedPayload[changedPayload.length - 1]! ^= 1;
  const changedPayloadBuild = buildDaoHarvestV2Transaction({
    ...builderInput(),
    payload: changedPayload,
  });
  assert.notEqual(changedPayloadBuild.intentHash, canonical.intentHash);
  const changed = buildDaoHarvestV2Transaction({
    ...builderInput(),
    economics: { ...builderInput().economics, maximumNetworkFee: 9n },
  });
  assert.notEqual(changed.intentHash, canonical.intentHash);
});

test("builder rejects review economics or operator proofs that differ from commitments", () => {
  assert.throws(
    () =>
      buildDaoHarvestV2Transaction({
        ...builderInput(),
        economics: { ...builderInput().economics, originalAmount: 999n },
      }),
    /original amount/,
  );
  assert.throws(
    () =>
      buildDaoHarvestV2Transaction({
        ...builderInput(),
        economics: { ...builderInput().economics, totalLockedAmount: 1_300n },
      }),
    /total locked amount/,
  );
  assert.throws(
    () => buildDaoHarvestV2Transaction({ ...builderInput(), operatorProof: new Uint8Array(32) }),
    /committed set/,
  );
});

test("wallet completion rejects duplicate input outpoints and duplicate resolutions", () => {
  const { build, completed } = completedTransaction();
  const fundingInput = completed.inputs.at(-1)!;
  const funding = {
    outPoint: fundingInput.previousOutput,
    capacity: 50n,
    lockHash: fundingLockHash,
  };
  assert.throws(() =>
    verifyCompletedDaoHarvestV2Transaction(
      build,
      { ...completed, inputs: [...completed.inputs, fundingInput] },
      [funding],
    ),
  );
  assert.throws(() => verifyCompletedDaoHarvestV2Transaction(build, completed, [funding, funding]));
});
