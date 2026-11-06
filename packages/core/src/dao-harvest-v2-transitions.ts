import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  JobDataV1,
} from "@ckb-automata/molecule";

import {
  hash32FromBytes,
  parseHash32,
  parseShannons,
  type Hash32,
  type IntegerInput,
  type Shannons,
} from "./chain-values.ts";
import { calculateDaoMaximumWithdraw } from "./dao-harvest-math.ts";
import {
  absentDaoHarvestV2Indices,
  buildDaoHarvestV2Transaction,
  type DaoHarvestV2Build,
} from "./dao-harvest-v2-builders.ts";
import {
  DAO_HARVEST_V2_OPERATIONS,
  decodeDaoHarvestV2VaultLockArgs,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  encodeDaoHarvestV2CompensationLockArgs,
  encodeDaoHarvestV2VaultLockArgs,
} from "./dao-harvest-v2.ts";
import type { UnsignedCellInput, UnsignedCellOutput } from "./deadline-creation.ts";
import type { CellDepIdentity, ScriptIdentity } from "./job-inspection.ts";

type Hex = `0x${string}`;

export interface DaoHarvestV2TransitionCell {
  readonly outPoint: { readonly txHash: Hash32; readonly index: IntegerInput };
  readonly capacity: IntegerInput;
  readonly lock: ScriptIdentity;
  readonly type: ScriptIdentity | null;
  readonly data: Hex;
}

export interface DaoHarvestV2TransitionDeployment {
  readonly secp256k1Blake160: { readonly cellDep: CellDepIdentity };
  readonly nervosDao: { readonly cellDep: CellDepIdentity };
  readonly contracts: {
    readonly jobLock: { readonly cellDep: CellDepIdentity };
    readonly policy: { readonly cellDep: CellDepIdentity };
    readonly vaultLock: { readonly cellDep: CellDepIdentity };
    readonly compensationLock: { readonly cellDep: CellDepIdentity };
  };
}

interface CommonInput {
  readonly deployment: DaoHarvestV2TransitionDeployment;
  readonly policyScriptHash: Hash32;
  readonly payload: Uint8Array;
  readonly progress: Uint8Array;
  readonly job: DaoHarvestV2TransitionCell;
  readonly vault: DaoHarvestV2TransitionCell;
  readonly accumulator: DaoHarvestV2TransitionCell;
  readonly feeCell: DaoHarvestV2TransitionCell;
  readonly operatorOwnerLock: ScriptIdentity;
  readonly transactionFee: IntegerInput;
}

export interface DaoHarvestV2PrepareTransitionInput extends CommonInput {
  readonly operation: "preferred_prepare" | "fallback_prepare";
  readonly operatorProof?: Uint8Array;
  readonly depositHeaderHash: Hash32;
  readonly depositBlockNumber: IntegerInput;
  readonly executionSince: IntegerInput;
  readonly claimSince: IntegerInput;
}

export interface DaoHarvestV2ClaimTransitionInput extends CommonInput {
  readonly operation: "preferred_claim" | "fallback_claim";
  readonly prepareCredit: Uint8Array;
  readonly compensation: DaoHarvestV2TransitionCell;
  readonly prepareAccumulator: DaoHarvestV2TransitionCell;
  readonly claimAccumulator?: DaoHarvestV2TransitionCell;
  readonly depositHeaderHash: Hash32;
  readonly prepareHeaderHash: Hash32;
  readonly depositAccumulatedRate: IntegerInput;
  readonly prepareAccumulatedRate: IntegerInput;
  readonly vaultOccupiedCapacity: IntegerInput;
  readonly executionSince: IntegerInput;
  readonly nextPrepareSince?: IntegerInput;
}

const ABSENT = 0xffff_ffff;

function txInput(cell: DaoHarvestV2TransitionCell, since: IntegerInput = 0n): UnsignedCellInput {
  return Object.freeze({
    since: `0x${BigInt(since).toString(16)}` as Hex,
    previousOutput: Object.freeze({
      txHash: parseHash32(cell.outPoint.txHash),
      index: `0x${BigInt(cell.outPoint.index).toString(16)}` as Hex,
    }),
  });
}

function txOutput(
  capacity: IntegerInput,
  lock: ScriptIdentity,
  type: ScriptIdentity | null,
): UnsignedCellOutput {
  return Object.freeze({
    capacity: `0x${parseShannons(capacity).toString(16)}` as Hex,
    lock,
    type,
  });
}

function u64(value: IntegerInput): Uint8Array {
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > 0xffff_ffff_ffff_ffffn) throw new RangeError("uint64 overflow");
  const encoded = new Uint8Array(8);
  new DataView(encoded.buffer).setBigUint64(0, parsed, true);
  return encoded;
}

function deps(value: DaoHarvestV2TransitionDeployment): readonly CellDepIdentity[] {
  return Object.freeze([
    value.secp256k1Blake160.cellDep,
    value.contracts.jobLock.cellDep,
    value.contracts.policy.cellDep,
    value.contracts.vaultLock.cellDep,
    value.contracts.compensationLock.cellDep,
    value.nervosDao.cellDep,
  ]);
}

function sameLock(left: ScriptIdentity, right: ScriptIdentity): boolean {
  return scriptToHash(left) === scriptToHash(right);
}

function assertPlain(cell: DaoHarvestV2TransitionCell, name: string): void {
  if (cell.type !== null || cell.data !== "0x") throw new Error(`${name} must be a plain cell`);
}

function feeChange(value: CommonInput): Shannons {
  assertPlain(value.feeCell, "executor fee cell");
  if (!sameLock(value.feeCell.lock, value.operatorOwnerLock)) {
    throw new Error("executor fee cell is controlled by another lock");
  }
  const capacity = parseShannons(value.feeCell.capacity);
  const fee = parseShannons(value.transactionFee);
  if (capacity <= fee) throw new RangeError("executor fee cell cannot fund the network fee");
  return parseShannons(capacity - fee);
}

function state(value: CommonInput) {
  const payload = DaoHarvestPayloadV2.unpack(value.payload);
  const progress = DaoHarvestProgressV2.unpack(value.progress);
  const job = JobDataV1.unpack(hexToBytes(value.job.data));
  if (Number(payload.version) !== 2 || Number(progress.version) !== 2) {
    throw new Error("DAO Harvest V2 transition contains another payload version");
  }
  if (
    hash32FromBytes(
      deriveDaoHarvestV2PayloadHash(hexToBytes(value.policyScriptHash), value.payload),
    ) !== hash32FromBytes(Uint8Array.from(job.payload_hash))
  ) {
    throw new Error("live Job Cell does not commit to the supplied V2 payload");
  }
  if (
    hash32FromBytes(deriveDaoHarvestV2ProgressHash(value.progress)) !==
    hash32FromBytes(Uint8Array.from(job.trigger_params_hash))
  ) {
    throw new Error("live Job Cell does not commit to the supplied V2 progress");
  }
  assertPlain(value.accumulator, "operator accumulator");
  return { payload, progress, job };
}

function nextJob(
  current: ReturnType<typeof JobDataV1.unpack>,
  progress: Uint8Array,
  notBefore: IntegerInput,
  remainingRuns: number,
) {
  return JobDataV1.pack({
    ...current,
    sequence: (BigInt(current.sequence.toString()) + 1n).toString(),
    trigger_params_hash: [...deriveDaoHarvestV2ProgressHash(progress)],
    not_before: BigInt(notBefore).toString(),
    remaining_runs: remainingRuns,
  });
}

function total(outputs: readonly UnsignedCellOutput[]): bigint {
  return outputs.reduce((sum, candidate) => sum + BigInt(candidate.capacity), 0n);
}

export function buildDaoHarvestV2PrepareTransition(
  value: DaoHarvestV2PrepareTransitionInput,
): DaoHarvestV2Build {
  const current = state(value);
  if (Number(current.progress.state) !== 0 || current.progress.prepare_credit_hash.some(Boolean)) {
    throw new Error("prepare requires deposited V2 progress");
  }
  if (value.vault.data !== "0x0000000000000000")
    throw new Error("prepare requires a deposited DAO vault");
  const credit = DaoHarvestPrepareCreditV2.pack({
    version: 2,
    job_id: [...current.job.job_id],
    cycle_index: current.progress.cycle_index,
    preparer_lock_hash: [...hexToBytes(parseHash32(scriptToHash(value.accumulator.lock)))],
    prepared_vault_output_index: 1,
    job_output_index: 0,
  });
  const withdrawing = DaoHarvestProgressV2.pack({
    version: 2,
    state: 1,
    cycle_index: current.progress.cycle_index,
    prepare_credit_hash: [...deriveDaoHarvestV2PrepareCreditHash(credit)],
  });
  const jobData = nextJob(
    current.job,
    withdrawing,
    value.claimSince,
    Number(current.job.remaining_runs),
  );
  const cells = [value.job, value.vault, value.accumulator, value.feeCell] as const;
  const inputs = cells.map((cell, index) => txInput(cell, index === 0 ? value.executionSince : 0n));
  const outputs = [
    txOutput(value.job.capacity, value.job.lock, value.job.type),
    txOutput(value.vault.capacity, value.vault.lock, value.vault.type),
    txOutput(value.accumulator.capacity, value.accumulator.lock, null),
    txOutput(feeChange(value), value.operatorOwnerLock, null),
  ];
  const operation =
    value.operation === "preferred_prepare"
      ? DAO_HARVEST_V2_OPERATIONS.PREFERRED_PREPARE
      : DAO_HARVEST_V2_OPERATIONS.FALLBACK_PREPARE;
  if (
    operation === DAO_HARVEST_V2_OPERATIONS.FALLBACK_PREPARE &&
    value.operatorProof === undefined
  ) {
    throw new Error("fallback preparation requires the committed operator proof");
  }
  return buildDaoHarvestV2Transaction({
    operation,
    policyScriptHash: value.policyScriptHash,
    payload: value.payload,
    progress: value.progress,
    prepareCredit: credit,
    ...(operation === DAO_HARVEST_V2_OPERATIONS.FALLBACK_PREPARE
      ? { operatorProof: value.operatorProof }
      : {}),
    indices: {
      ...absentDaoHarvestV2Indices(),
      jobInputIndex: 0,
      vaultInputIndex: 1,
      identityInputIndex: 2,
      prepareAccumulatorInputIndex: 2,
      jobOutputIndex: 0,
      vaultOutputIndex: 1,
      prepareAccumulatorOutputIndex: 2,
    },
    cellDeps: deps(value.deployment),
    headerDeps: [value.depositHeaderHash],
    inputs,
    additionalWitnesses: ["0x", "0x", "0x"],
    inputCapacities: cells.map((cell) => cell.capacity),
    outputs,
    outputsData: [
      bytesToHex(jobData) as Hex,
      bytesToHex(u64(value.depositBlockNumber)) as Hex,
      "0x",
      "0x",
    ],
    allowedFundingLockHashes: [parseHash32(scriptToHash(value.operatorOwnerLock))],
    economics: {
      originalAmount: current.payload.principal_capacity.toString(),
      expectedCompensation: 0n,
      prepareServiceCharge: current.payload.prepare_service_fee.toString(),
      claimServiceCharge: current.payload.claim_service_fee.toString(),
      maximumNetworkFee: value.transactionFee,
      recoverableReserve: current.payload.compensation_seed_capacity.toString(),
      accumulatedCompensation: 0n,
      totalLockedAmount: total(outputs),
    },
  });
}

function terminalVault(lock: ScriptIdentity): ScriptIdentity {
  const args = decodeDaoHarvestV2VaultLockArgs(hexToBytes(lock.args));
  return Object.freeze({
    ...lock,
    args: bytesToHex(
      encodeDaoHarvestV2VaultLockArgs({ ...args, jobLockHash: new Uint8Array(32) }),
    ) as Hex,
  });
}

function terminalCompensation(lock: ScriptIdentity): ScriptIdentity {
  const args = hexToBytes(lock.args);
  if (args.length !== 160) throw new Error("compensation lock arguments are invalid");
  return Object.freeze({
    ...lock,
    args: bytesToHex(
      encodeDaoHarvestV2CompensationLockArgs({
        jobId: new Uint8Array(32),
        ownerLockHash: args.slice(32, 64),
        payoutLockHash: args.slice(64, 96),
        policyScriptHash: args.slice(96, 128),
        payloadHash: args.slice(128, 160),
      }),
    ) as Hex,
  });
}

export function buildDaoHarvestV2ClaimTransition(
  value: DaoHarvestV2ClaimTransitionInput,
): DaoHarvestV2Build {
  const current = state(value);
  if (Number(current.progress.state) !== 1)
    throw new Error("claim requires withdrawing V2 progress");
  if (
    hash32FromBytes(deriveDaoHarvestV2PrepareCreditHash(value.prepareCredit)) !==
    hash32FromBytes(Uint8Array.from(current.progress.prepare_credit_hash))
  )
    throw new Error("claim prepare credit does not match live progress");
  const credit = DaoHarvestPrepareCreditV2.unpack(value.prepareCredit);
  if (
    hash32FromBytes(Uint8Array.from(credit.job_id)) !==
    hash32FromBytes(Uint8Array.from(current.job.job_id))
  ) {
    throw new Error("claim prepare credit belongs to another job");
  }
  assertPlain(value.compensation, "compensation cell");
  assertPlain(value.prepareAccumulator, "prepare accumulator");
  const claimant = value.claimAccumulator ?? value.accumulator;
  assertPlain(claimant, "claim accumulator");
  const principal = parseShannons(current.payload.principal_capacity.toString());
  const maximum = calculateDaoMaximumWithdraw({
    principal,
    occupiedCapacity: value.vaultOccupiedCapacity,
    depositAccumulatedRate: value.depositAccumulatedRate,
    withdrawingAccumulatedRate: value.prepareAccumulatedRate,
  });
  const gross = maximum - principal;
  const preparePayment =
    gross < BigInt(current.payload.prepare_service_fee.toString())
      ? gross
      : BigInt(current.payload.prepare_service_fee.toString());
  const afterPrepare = gross - preparePayment;
  const claimPayment =
    afterPrepare < BigInt(current.payload.claim_service_fee.toString())
      ? afterPrepare
      : BigInt(current.payload.claim_service_fee.toString());
  const ownerPayment = afterPrepare - claimPayment;
  const terminal = Number(current.job.remaining_runs) === 1;
  if (!terminal && value.nextPrepareSince === undefined)
    throw new Error("a non-terminal claim requires the next preparation time");

  const cells: DaoHarvestV2TransitionCell[] = [
    value.job,
    value.vault,
    value.compensation,
    value.prepareAccumulator,
  ];
  const sameOperator = sameLock(value.prepareAccumulator.lock, claimant.lock);
  let claimInput = ABSENT;
  if (!sameOperator) {
    claimInput = cells.length;
    cells.push(claimant);
  }
  const identityInput = sameOperator ? 3 : claimInput;
  cells.push(value.feeCell);
  const inputs = cells.map((cell, index) => txInput(cell, index === 1 ? value.executionSince : 0n));
  const outputs: UnsignedCellOutput[] = [];
  const outputsData: Hex[] = [];
  let jobOutput = ABSENT;
  if (!terminal) {
    const deposited = DaoHarvestProgressV2.pack({
      version: 2,
      state: 0,
      cycle_index: Number(current.progress.cycle_index) + 1,
      prepare_credit_hash: Array(32).fill(0),
    });
    jobOutput = outputs.length;
    outputs.push(txOutput(value.job.capacity, value.job.lock, value.job.type));
    outputsData.push(
      bytesToHex(
        nextJob(
          current.job,
          deposited,
          value.nextPrepareSince!,
          Number(current.job.remaining_runs) - 1,
        ),
      ) as Hex,
    );
  }
  const vaultOutput = outputs.length;
  outputs.push(
    txOutput(
      principal,
      terminal ? terminalVault(value.vault.lock) : value.vault.lock,
      value.vault.type,
    ),
  );
  outputsData.push("0x0000000000000000");
  const compensationOutput = outputs.length;
  outputs.push(
    txOutput(
      BigInt(value.compensation.capacity) + ownerPayment,
      terminal ? terminalCompensation(value.compensation.lock) : value.compensation.lock,
      null,
    ),
  );
  outputsData.push("0x");
  const prepareOutput = outputs.length;
  outputs.push(
    txOutput(
      BigInt(value.prepareAccumulator.capacity) +
        preparePayment +
        (sameOperator ? claimPayment : 0n),
      value.prepareAccumulator.lock,
      null,
    ),
  );
  outputsData.push("0x");
  let claimOutput = ABSENT;
  if (!sameOperator) {
    claimOutput = outputs.length;
    outputs.push(txOutput(BigInt(claimant.capacity) + claimPayment, claimant.lock, null));
    outputsData.push("0x");
  }
  outputs.push(txOutput(feeChange(value), value.operatorOwnerLock, null));
  outputsData.push("0x");
  const extra: Hex[] = Array.from({ length: inputs.length - 1 }, () => "0x" as Hex);
  extra[0] = serializeWitnessArgs({
    lock: "",
    inputType: bytesToHex(u64(0n)),
    outputType: "",
  }) as Hex;
  const operation =
    value.operation === "preferred_claim"
      ? DAO_HARVEST_V2_OPERATIONS.PREFERRED_CLAIM
      : DAO_HARVEST_V2_OPERATIONS.FALLBACK_CLAIM;
  return buildDaoHarvestV2Transaction({
    operation,
    policyScriptHash: value.policyScriptHash,
    payload: value.payload,
    progress: value.progress,
    prepareCredit: value.prepareCredit,
    indices: {
      ...absentDaoHarvestV2Indices(),
      jobInputIndex: 0,
      vaultInputIndex: 1,
      compensationInputIndex: 2,
      identityInputIndex: identityInput,
      prepareAccumulatorInputIndex: 3,
      claimAccumulatorInputIndex: claimInput,
      jobOutputIndex: jobOutput,
      vaultOutputIndex: vaultOutput,
      compensationOutputIndex: compensationOutput,
      prepareAccumulatorOutputIndex: prepareOutput,
      claimAccumulatorOutputIndex: claimOutput,
    },
    cellDeps: deps(value.deployment),
    headerDeps: [value.depositHeaderHash, value.prepareHeaderHash],
    inputs,
    additionalWitnesses: extra,
    inputCapacities: cells.map((cell, index) => (index === 1 ? maximum : cell.capacity)),
    outputs,
    outputsData,
    allowedFundingLockHashes: [parseHash32(scriptToHash(value.operatorOwnerLock))],
    economics: {
      originalAmount: principal,
      expectedCompensation: gross,
      prepareServiceCharge: current.payload.prepare_service_fee.toString(),
      claimServiceCharge: current.payload.claim_service_fee.toString(),
      maximumNetworkFee: value.transactionFee,
      recoverableReserve: current.payload.compensation_seed_capacity.toString(),
      accumulatedCompensation:
        BigInt(value.compensation.capacity) -
        BigInt(current.payload.compensation_seed_capacity.toString()),
      totalLockedAmount: total(outputs),
    },
  });
}
