import { parseShannons, type IntegerInput, type Shannons } from "./chain-values.ts";

const SHANNONS_PER_CKB = 100_000_000n;

export const HARVEST_V2_COMPENSATION_LOCK_ARGS_BYTES = 160;
export const HARVEST_V2_OPERATOR_ACCUMULATOR_LOCK_ARGS_BYTES = 64;

export function prototypePlainCellOccupiedCapacity(lockArgsBytes: number): Shannons {
  if (!Number.isSafeInteger(lockArgsBytes) || lockArgsBytes < 0) {
    throw new RangeError("lock args byte length must be a non-negative safe integer");
  }
  return parseShannons(BigInt(8 + 32 + 1 + lockArgsBytes) * SHANNONS_PER_CKB);
}

export const HARVEST_V2_COMPENSATION_CELL_OCCUPIED_CAPACITY = prototypePlainCellOccupiedCapacity(
  HARVEST_V2_COMPENSATION_LOCK_ARGS_BYTES,
);

export function prototypeCompensationSeed(payoutLockArgsBytes: number): Shannons {
  const payoutOccupied = prototypePlainCellOccupiedCapacity(payoutLockArgsBytes);
  return payoutOccupied > HARVEST_V2_COMPENSATION_CELL_OCCUPIED_CAPACITY
    ? payoutOccupied
    : HARVEST_V2_COMPENSATION_CELL_OCCUPIED_CAPACITY;
}

function checked(value: bigint, name: string): Shannons {
  try {
    return parseShannons(value);
  } catch (error) {
    if (error instanceof RangeError) throw new RangeError(`${name} exceeds uint64 capacity`);
    throw error;
  }
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export interface HarvestV2SettlementPrototypeInput {
  readonly principalCapacity: IntegerInput;
  readonly grossCompensation: IntegerInput;
  readonly prepareServiceFee: IntegerInput;
  readonly claimServiceFee: IntegerInput;
  readonly compensationCellCapacity: IntegerInput;
  readonly compensationSeedCapacity: IntegerInput;
  readonly ownerCompletesClaim: boolean;
}

export interface HarvestV2SettlementPrototype {
  readonly principalRedeployed: Shannons;
  readonly preparePayment: Shannons;
  readonly claimPayment: Shannons;
  readonly ownerCompensation: Shannons;
  readonly compensationCellBefore: Shannons;
  readonly compensationCellAfter: Shannons;
  readonly grossCompensation: Shannons;
}

export function prototypeHarvestV2Settlement(
  input: HarvestV2SettlementPrototypeInput,
): HarvestV2SettlementPrototype {
  const principal = parseShannons(input.principalCapacity);
  const compensation = parseShannons(input.grossCompensation);
  const prepareCap = parseShannons(input.prepareServiceFee);
  const claimCap = input.ownerCompletesClaim ? 0n : parseShannons(input.claimServiceFee);
  const cellBefore = parseShannons(input.compensationCellCapacity);
  const seed = parseShannons(input.compensationSeedCapacity);
  if (cellBefore < seed) throw new RangeError("Compensation Cell is below its recoverable reserve");

  const preparePayment = minimum(compensation, prepareCap);
  const afterPrepare = compensation - preparePayment;
  const claimPayment = minimum(afterPrepare, claimCap);
  const ownerCompensation = afterPrepare - claimPayment;
  const cellAfter = checked(cellBefore + ownerCompensation, "Compensation Cell successor");

  return Object.freeze({
    principalRedeployed: principal,
    preparePayment: checked(preparePayment, "prepare payment"),
    claimPayment: checked(claimPayment, "claim payment"),
    ownerCompensation: checked(ownerCompensation, "owner compensation"),
    compensationCellBefore: cellBefore,
    compensationCellAfter: cellAfter,
    grossCompensation: compensation,
  });
}

export interface OperatorAccumulatorPrototype {
  readonly occupiedCapacity: Shannons;
  readonly inputCapacity: Shannons;
  readonly payment: Shannons;
  readonly outputCapacity: Shannons;
  readonly directPayoutIsDust: boolean;
}

export function prototypeOperatorAccumulator(
  inputCapacity: IntegerInput,
  payment: IntegerInput,
  operatorLockArgsBytes = HARVEST_V2_OPERATOR_ACCUMULATOR_LOCK_ARGS_BYTES,
): OperatorAccumulatorPrototype {
  const occupied = prototypePlainCellOccupiedCapacity(operatorLockArgsBytes);
  const before = parseShannons(inputCapacity);
  const delta = parseShannons(payment);
  if (before < occupied) throw new RangeError("operator identity input is below occupied capacity");
  return Object.freeze({
    occupiedCapacity: occupied,
    inputCapacity: before,
    payment: delta,
    outputCapacity: checked(before + delta, "operator accumulator output"),
    directPayoutIsDust: delta > 0n && delta < occupied,
  });
}

export interface CompensationSweepPrototype {
  readonly compensationCellInput: Shannons;
  readonly compensationCellOutput: Shannons;
  readonly payout: Shannons;
}

export function prototypeCompensationSweep(
  compensationCellCapacity: IntegerInput,
  compensationSeedCapacity: IntegerInput,
  payoutLockArgsBytes: number,
): CompensationSweepPrototype {
  const input = parseShannons(compensationCellCapacity);
  const seed = parseShannons(compensationSeedCapacity);
  if (input < seed) throw new RangeError("Compensation Cell is below its recoverable reserve");
  const payout = checked(input - seed, "compensation sweep payout");
  if (payout === 0n) throw new RangeError("Compensation Cell has no accumulated value to sweep");
  if (payout < prototypePlainCellOccupiedCapacity(payoutLockArgsBytes)) {
    throw new RangeError("accumulated compensation cannot create a valid payout Cell");
  }
  return Object.freeze({
    compensationCellInput: input,
    compensationCellOutput: seed,
    payout,
  });
}

export interface CompensationClosePrototype {
  readonly compensationCellInput: Shannons;
  readonly payout: Shannons;
  readonly recoveredSeed: Shannons;
  readonly accumulatedCompensation: Shannons;
}

export function prototypeCompensationClose(
  compensationCellCapacity: IntegerInput,
  compensationSeedCapacity: IntegerInput,
  payoutLockArgsBytes: number,
): CompensationClosePrototype {
  const input = parseShannons(compensationCellCapacity);
  const seed = parseShannons(compensationSeedCapacity);
  if (input < seed) throw new RangeError("Compensation Cell is below its recoverable reserve");
  if (input < prototypePlainCellOccupiedCapacity(payoutLockArgsBytes)) {
    throw new RangeError("terminal payout would be below occupied capacity");
  }
  return Object.freeze({
    compensationCellInput: input,
    payout: input,
    recoveredSeed: seed,
    accumulatedCompensation: checked(input - seed, "accumulated compensation"),
  });
}
