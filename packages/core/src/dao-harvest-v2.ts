import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

export const DAO_HARVEST_V2_VERSION = 2 as const;
export const DAO_HARVEST_V2_ABSENT_INDEX = 0xffff_ffff as const;
export const DAO_HARVEST_V2_COMPENSATION_ARGS_BYTES = 160 as const;
export const MAX_DAO_HARVEST_V2_FALLBACK_OPERATORS = 8 as const;

export const DAO_HARVEST_V2_DOMAINS = Object.freeze({
  payload: "ckb-automata/dao-harvest-payload/v2",
  progress: "ckb-automata/dao-harvest-progress/v2",
  prepareCredit: "ckb-automata/dao-harvest-prepare-credit/v2",
  fallbackSet: "ckb-automata/dao-harvest-fallback-set/v2",
  intent: "ckb-automata/dao-harvest-intent/v2",
} as const);

export const DAO_HARVEST_V2_OPERATIONS = Object.freeze({
  SETUP: 0,
  PREFERRED_PREPARE: 1,
  FALLBACK_PREPARE: 2,
  PREFERRED_CLAIM: 3,
  FALLBACK_CLAIM: 4,
  OWNER_COMPLETE: 5,
  SWEEP: 6,
  CLOSE: 7,
  ROTATE: 8,
  RECOVER: 9,
} as const);

export const DAO_HARVEST_V2_STATES = Object.freeze({
  DEPOSITED: 0,
  WITHDRAWING: 1,
} as const);

export type DaoHarvestV2Operation =
  (typeof DAO_HARVEST_V2_OPERATIONS)[keyof typeof DAO_HARVEST_V2_OPERATIONS];

const BYTE32_LENGTH = 32;

function byte32(value: Uint8Array, name: string): Uint8Array {
  if (value.length !== BYTE32_LENGTH) throw new RangeError(`${name} must contain exactly 32 bytes`);
  return value;
}

function hashDomain(domain: string, parts: readonly Uint8Array[]): Uint8Array {
  const bodyLength = parts.reduce((total, part) => total + part.length, 0);
  if (!Number.isSafeInteger(bodyLength) || bodyLength > 0xffff_ffff) {
    throw new RangeError("hash body exceeds uint32 length");
  }
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bodyLength, true);
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(domain));
  hasher.update(Uint8Array.of(0));
  hasher.update(length);
  for (const part of parts) hasher.update(part);
  return hasher.digest("binary") as Uint8Array;
}

export function deriveDaoHarvestV2PayloadHash(
  policyScriptHash: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  return hashDomain(DAO_HARVEST_V2_DOMAINS.payload, [
    byte32(policyScriptHash, "policyScriptHash"),
    payload,
  ]);
}

export function deriveDaoHarvestV2ProgressHash(progress: Uint8Array): Uint8Array {
  return hashDomain(DAO_HARVEST_V2_DOMAINS.progress, [progress]);
}

export function deriveDaoHarvestV2PrepareCreditHash(credit: Uint8Array): Uint8Array {
  return hashDomain(DAO_HARVEST_V2_DOMAINS.prepareCredit, [credit]);
}

export function deriveDaoHarvestV2IntentHash(intent: Uint8Array): Uint8Array {
  return hashDomain(DAO_HARVEST_V2_DOMAINS.intent, [intent]);
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

export function normalizeDaoHarvestV2FallbackOperators(
  operatorLockHashes: readonly Uint8Array[],
): readonly Uint8Array[] {
  if (
    operatorLockHashes.length === 0 ||
    operatorLockHashes.length > MAX_DAO_HARVEST_V2_FALLBACK_OPERATORS
  ) {
    throw new RangeError("fallback operator set must contain 1 to 8 identities");
  }
  const normalized = operatorLockHashes
    .map((value, index) => Uint8Array.from(byte32(value, `operatorLockHashes[${index}]`)))
    .toSorted(compareBytes);
  for (let index = 1; index < normalized.length; index += 1) {
    if (compareBytes(normalized[index - 1]!, normalized[index]!) === 0) {
      throw new RangeError("fallback operator set contains a duplicate identity");
    }
  }
  return Object.freeze(normalized);
}

export function deriveDaoHarvestV2FallbackOperatorSetHash(
  operatorLockHashes: readonly Uint8Array[],
): Uint8Array {
  const normalized = normalizeDaoHarvestV2FallbackOperators(operatorLockHashes);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, normalized.length, true);
  return hashDomain(DAO_HARVEST_V2_DOMAINS.fallbackSet, [count, ...normalized]);
}

export function encodeDaoHarvestV2FallbackOperatorProof(
  operatorLockHashes: readonly Uint8Array[],
): Uint8Array {
  const normalized = normalizeDaoHarvestV2FallbackOperators(operatorLockHashes);
  const proof = new Uint8Array(normalized.length * BYTE32_LENGTH);
  normalized.forEach((operator, index) => proof.set(operator, index * BYTE32_LENGTH));
  return proof;
}

export function decodeDaoHarvestV2FallbackOperatorProof(
  proof: Uint8Array,
  expectedSetHash: Uint8Array,
): readonly Uint8Array[] {
  if (
    proof.length === 0 ||
    proof.length % BYTE32_LENGTH !== 0 ||
    proof.length > MAX_DAO_HARVEST_V2_FALLBACK_OPERATORS * BYTE32_LENGTH
  ) {
    throw new RangeError("fallback operator proof must contain 1 to 8 full lock hashes");
  }
  const operators = Array.from({ length: proof.length / BYTE32_LENGTH }, (_, index) =>
    proof.slice(index * BYTE32_LENGTH, (index + 1) * BYTE32_LENGTH),
  );
  for (let index = 1; index < operators.length; index += 1) {
    if (compareBytes(operators[index - 1]!, operators[index]!) >= 0) {
      throw new RangeError("fallback operator proof must be strictly sorted and unique");
    }
  }
  const actual = deriveDaoHarvestV2FallbackOperatorSetHash(operators);
  if (compareBytes(actual, byte32(expectedSetHash, "expectedSetHash")) !== 0) {
    throw new RangeError("fallback operator proof does not match the committed set");
  }
  return Object.freeze(operators);
}

export interface DaoHarvestV2CompensationLockArgs {
  readonly jobId: Uint8Array;
  readonly ownerLockHash: Uint8Array;
  readonly payoutLockHash: Uint8Array;
  readonly policyScriptHash: Uint8Array;
  readonly payloadHash: Uint8Array;
}

export function encodeDaoHarvestV2CompensationLockArgs(
  input: DaoHarvestV2CompensationLockArgs,
): Uint8Array {
  const parts = [
    byte32(input.jobId, "jobId"),
    byte32(input.ownerLockHash, "ownerLockHash"),
    byte32(input.payoutLockHash, "payoutLockHash"),
    byte32(input.policyScriptHash, "policyScriptHash"),
    byte32(input.payloadHash, "payloadHash"),
  ];
  const encoded = new Uint8Array(DAO_HARVEST_V2_COMPENSATION_ARGS_BYTES);
  parts.forEach((part, index) => encoded.set(part, index * BYTE32_LENGTH));
  return encoded;
}

export function decodeDaoHarvestV2CompensationLockArgs(
  encoded: Uint8Array,
): DaoHarvestV2CompensationLockArgs {
  if (encoded.length !== DAO_HARVEST_V2_COMPENSATION_ARGS_BYTES) {
    throw new RangeError("Compensation Lock args must contain exactly 160 bytes");
  }
  const part = (index: number) => encoded.slice(index * BYTE32_LENGTH, (index + 1) * BYTE32_LENGTH);
  return Object.freeze({
    jobId: part(0),
    ownerLockHash: part(1),
    payoutLockHash: part(2),
    policyScriptHash: part(3),
    payloadHash: part(4),
  });
}

export interface DaoHarvestV2WitnessIndices {
  readonly jobInputIndex: number;
  readonly vaultInputIndex: number;
  readonly compensationInputIndex: number;
  readonly identityInputIndex: number;
  readonly prepareAccumulatorInputIndex: number;
  readonly claimAccumulatorInputIndex: number;
  readonly jobOutputIndex: number;
  readonly vaultOutputIndex: number;
  readonly compensationOutputIndex: number;
  readonly prepareAccumulatorOutputIndex: number;
  readonly claimAccumulatorOutputIndex: number;
}

type WitnessIndexName = keyof DaoHarvestV2WitnessIndices;

const ALL_INDEX_NAMES: readonly WitnessIndexName[] = [
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
];

const LAYOUTS: Readonly<
  Record<
    DaoHarvestV2Operation,
    { required: readonly WitnessIndexName[]; optional: readonly WitnessIndexName[] }
  >
> = Object.freeze({
  [DAO_HARVEST_V2_OPERATIONS.SETUP]: {
    required: [
      "identityInputIndex",
      "jobOutputIndex",
      "vaultOutputIndex",
      "compensationOutputIndex",
    ],
    optional: [],
  },
  [DAO_HARVEST_V2_OPERATIONS.PREFERRED_PREPARE]: {
    required: [
      "jobInputIndex",
      "vaultInputIndex",
      "identityInputIndex",
      "jobOutputIndex",
      "vaultOutputIndex",
    ],
    optional: [],
  },
  [DAO_HARVEST_V2_OPERATIONS.FALLBACK_PREPARE]: {
    required: [
      "jobInputIndex",
      "vaultInputIndex",
      "identityInputIndex",
      "jobOutputIndex",
      "vaultOutputIndex",
    ],
    optional: [],
  },
  [DAO_HARVEST_V2_OPERATIONS.PREFERRED_CLAIM]: {
    required: [
      "jobInputIndex",
      "vaultInputIndex",
      "compensationInputIndex",
      "identityInputIndex",
      "prepareAccumulatorInputIndex",
      "vaultOutputIndex",
      "compensationOutputIndex",
      "prepareAccumulatorOutputIndex",
    ],
    optional: ["jobOutputIndex", "claimAccumulatorInputIndex", "claimAccumulatorOutputIndex"],
  },
  [DAO_HARVEST_V2_OPERATIONS.FALLBACK_CLAIM]: {
    required: [
      "jobInputIndex",
      "vaultInputIndex",
      "compensationInputIndex",
      "identityInputIndex",
      "prepareAccumulatorInputIndex",
      "claimAccumulatorInputIndex",
      "vaultOutputIndex",
      "compensationOutputIndex",
      "prepareAccumulatorOutputIndex",
      "claimAccumulatorOutputIndex",
    ],
    optional: ["jobOutputIndex"],
  },
  [DAO_HARVEST_V2_OPERATIONS.OWNER_COMPLETE]: {
    required: [
      "jobInputIndex",
      "vaultInputIndex",
      "compensationInputIndex",
      "identityInputIndex",
      "prepareAccumulatorInputIndex",
      "vaultOutputIndex",
      "compensationOutputIndex",
      "prepareAccumulatorOutputIndex",
    ],
    optional: ["jobOutputIndex"],
  },
  [DAO_HARVEST_V2_OPERATIONS.SWEEP]: {
    required: [
      "jobInputIndex",
      "compensationInputIndex",
      "identityInputIndex",
      "jobOutputIndex",
      "compensationOutputIndex",
    ],
    optional: [],
  },
  [DAO_HARVEST_V2_OPERATIONS.CLOSE]: {
    required: ["compensationInputIndex", "identityInputIndex"],
    optional: [],
  },
  [DAO_HARVEST_V2_OPERATIONS.ROTATE]: {
    required: [
      "jobInputIndex",
      "compensationInputIndex",
      "identityInputIndex",
      "jobOutputIndex",
      "compensationOutputIndex",
    ],
    optional: [],
  },
  [DAO_HARVEST_V2_OPERATIONS.RECOVER]: {
    required: ["jobInputIndex", "vaultInputIndex", "compensationInputIndex", "identityInputIndex"],
    optional: ["prepareAccumulatorInputIndex", "prepareAccumulatorOutputIndex"],
  },
});

function assertAccumulatorPair(
  indices: DaoHarvestV2WitnessIndices,
  prefix: "prepare" | "claim",
): void {
  const input = indices[`${prefix}AccumulatorInputIndex`];
  const output = indices[`${prefix}AccumulatorOutputIndex`];
  if ((input === DAO_HARVEST_V2_ABSENT_INDEX) !== (output === DAO_HARVEST_V2_ABSENT_INDEX)) {
    throw new RangeError(`${prefix} accumulator input and output must be present together`);
  }
}

export function assertDaoHarvestV2WitnessLayout(
  operation: DaoHarvestV2Operation,
  flags: number,
  indices: DaoHarvestV2WitnessIndices,
): void {
  if (flags !== 0) throw new RangeError("DAO Harvest V2 witness flags are reserved");
  const layout = LAYOUTS[operation];
  if (!layout) throw new RangeError("unsupported DAO Harvest V2 operation");
  for (const name of ALL_INDEX_NAMES) {
    const value = indices[name];
    if (!Number.isSafeInteger(value) || value < 0 || value > DAO_HARVEST_V2_ABSENT_INDEX) {
      throw new RangeError(`${name} must fit uint32`);
    }
    const isRequired = layout.required.includes(name);
    const isOptional = layout.optional.includes(name);
    if (isRequired && value === DAO_HARVEST_V2_ABSENT_INDEX) {
      throw new RangeError(`${name} is required for operation ${operation}`);
    }
    if (!isRequired && !isOptional && value !== DAO_HARVEST_V2_ABSENT_INDEX) {
      throw new RangeError(`${name} must be absent for operation ${operation}`);
    }
  }
  assertAccumulatorPair(indices, "prepare");
  assertAccumulatorPair(indices, "claim");
}
