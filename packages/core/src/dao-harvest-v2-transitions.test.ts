import assert from "node:assert/strict";
import test from "node:test";

import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  DaoHarvestEnvelopeV2,
  DaoHarvestPayloadV2,
  DaoHarvestProgressV2,
  JobDataV1,
} from "@ckb-automata/molecule";

import { parseHash32, type Hash32 } from "./chain-values.ts";
import {
  buildDaoHarvestV2ClaimTransition,
  buildDaoHarvestV2PrepareTransition,
  type DaoHarvestV2TransitionCell,
  type DaoHarvestV2TransitionDeployment,
} from "./dao-harvest-v2-transitions.ts";
import {
  deriveDaoHarvestV2FallbackOperatorSetHash,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  encodeDaoHarvestV2CompensationLockArgs,
  encodeDaoHarvestV2FallbackOperatorProof,
  encodeDaoHarvestV2VaultLockArgs,
} from "./dao-harvest-v2.ts";
import type { ScriptIdentity } from "./job-inspection.ts";

const CKB = 100_000_000n;
const hash = (digit: string): Hash32 => parseHash32(`0x${digit.repeat(64)}`);
const script = (digit: string, args: `0x${string}` = "0x"): ScriptIdentity =>
  Object.freeze({ codeHash: hash(digit), hashType: "data1" as const, args });
const point = (digit: string, index = 0n) => Object.freeze({ txHash: hash(digit), index });
const dep = (digit: string) =>
  Object.freeze({
    outPoint: Object.freeze({ txHash: hash(digit), index: "0x0" as const }),
    depType: "code" as const,
  });

const jobLock = script("1");
const policy = script("2", hash("1") as `0x${string}`);
const daoType = Object.freeze({
  codeHash: hash("3"),
  hashType: "type" as const,
  args: "0x" as const,
});
const ownerLock = Object.freeze({
  codeHash: hash("4"),
  hashType: "type" as const,
  args: "0x1234" as const,
});
const policyHash = parseHash32(scriptToHash(policy));
const ownerHash = parseHash32(scriptToHash(ownerLock));
const accumulatorLock = script(
  "6",
  bytesToHex(
    Uint8Array.from([...hexToBytes(ownerHash), ...hexToBytes(policyHash)]),
  ) as `0x${string}`,
);
const fallback = [hexToBytes(ownerHash)];
const proof = encodeDaoHarvestV2FallbackOperatorProof(fallback);
const deployment: DaoHarvestV2TransitionDeployment = Object.freeze({
  secp256k1Blake160: { cellDep: dep("a") },
  nervosDao: { cellDep: dep("b") },
  contracts: {
    jobLock: { cellDep: dep("1") },
    policy: { cellDep: dep("2") },
    vaultLock: { cellDep: dep("5") },
    compensationLock: { cellDep: dep("6") },
  },
});

const payload = DaoHarvestPayloadV2.pack({
  version: 2,
  owner_lock_hash: [...hexToBytes(ownerHash)],
  payout_lock_hash: [...hexToBytes(hash("7"))],
  vault_lock_code_hash: [...hexToBytes(hash("5"))],
  compensation_lock_code_hash: [...hexToBytes(hash("6"))],
  dao_type_hash: [...hexToBytes(parseHash32(scriptToHash(daoType)))],
  principal_capacity: (10_000n * CKB).toString(),
  preferred_prepare_operator_lock_hash: [...hexToBytes(ownerHash)],
  fallback_prepare_executor_set_hash: [...deriveDaoHarvestV2FallbackOperatorSetHash(fallback)],
  prepare_service_fee: (2n * CKB).toString(),
  claim_service_fee: (3n * CKB).toString(),
  compensation_seed_capacity: (201n * CKB).toString(),
  prepare_buffer_epochs: ((1n << 63n) | (1n << 61n) | 4n).toString(),
  takeover_delay_epochs: ((1n << 63n) | (1n << 61n) | 1n).toString(),
  confirmation_margin_epochs: ((1n << 63n) | (1n << 61n) | 1n).toString(),
  total_cycles: 2,
  end_epoch_since: "0",
});
const deposited = DaoHarvestProgressV2.pack({
  version: 2,
  state: 0,
  cycle_index: 0,
  prepare_credit_hash: Array(32).fill(0),
});
const jobId = hash("8");
const vaultLock = script(
  "5",
  bytesToHex(
    encodeDaoHarvestV2VaultLockArgs({
      jobId: hexToBytes(jobId),
      ownerLockHash: hexToBytes(ownerHash),
      jobLockHash: hexToBytes(parseHash32(scriptToHash(jobLock))),
      policyScriptHash: hexToBytes(policyHash),
      immutableTermsHash: hexToBytes(hash("9")),
    }),
  ) as `0x${string}`,
);
const compensationLock = script(
  "6",
  bytesToHex(
    encodeDaoHarvestV2CompensationLockArgs({
      jobId: hexToBytes(jobId),
      ownerLockHash: hexToBytes(ownerHash),
      payoutLockHash: hexToBytes(hash("7")),
      policyScriptHash: hexToBytes(policyHash),
      payloadHash: deriveDaoHarvestV2PayloadHash(hexToBytes(policyHash), payload),
    }),
  ) as `0x${string}`,
);

function cell(
  digit: string,
  capacity: bigint,
  lock: ScriptIdentity,
  type: ScriptIdentity | null,
  data: `0x${string}`,
): DaoHarvestV2TransitionCell {
  return Object.freeze({ outPoint: point(digit), capacity, lock, type, data });
}

const jobData = JobDataV1.pack({
  version: 1,
  flags: 0,
  job_id: [...hexToBytes(jobId)],
  sequence: "0",
  state: 0,
  trigger_kind: 2,
  trigger_params_hash: [...deriveDaoHarvestV2ProgressHash(deposited)],
  policy_script_hash: [...hexToBytes(policyHash)],
  payload_hash: [...deriveDaoHarvestV2PayloadHash(hexToBytes(policyHash), payload)],
  reward: "0",
  remaining_budget: "0",
  not_before: ((1n << 61n) | 100n).toString(),
  not_after: "0",
  remaining_runs: 2,
  cancel_lock_hash: [...hexToBytes(ownerHash)],
});

function prepareInput() {
  return {
    deployment,
    policyScriptHash: policyHash,
    payload,
    progress: deposited,
    job: cell("a", 400n * CKB, jobLock, policy, bytesToHex(jobData) as `0x${string}`),
    vault: cell("b", 10_000n * CKB, vaultLock, daoType, "0x0000000000000000"),
    accumulator: cell("c", 300n * CKB, accumulatorLock, null, "0x"),
    feeCell: cell("d", 100n * CKB, ownerLock, null, "0x"),
    operatorOwnerLock: ownerLock,
    transactionFee: 50_000n,
    operation: "preferred_prepare" as const,
    depositHeaderHash: hash("d"),
    depositBlockNumber: 10n,
    executionSince: (1n << 61n) | 100n,
    claimSince: (1n << 61n) | 104n,
  };
}

function witnessOutputType(value: `0x${string}`): Uint8Array {
  const bytes = hexToBytes(value);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const outputOffset = view.getUint32(12, true);
  const length = view.getUint32(outputOffset, true);
  return bytes.slice(outputOffset + 4, outputOffset + 4 + length);
}

test("V2 transition builders produce committed prepare and claim successors", () => {
  const prepared = buildDaoHarvestV2PrepareTransition(prepareInput());
  assert.equal(prepared.transaction.inputs.length, 4);
  assert.equal(prepared.transaction.outputs.length, 4);
  const envelope = DaoHarvestEnvelopeV2.unpack(
    witnessOutputType(prepared.transaction.witnesses[0]!),
  );
  const credit = Uint8Array.from(envelope.prepare_credit);
  assert(credit.length > 0);

  const claimJob = cell("e", 400n * CKB, jobLock, policy, prepared.transaction.outputsData[0]!);
  const claimVault = cell(
    "f",
    10_000n * CKB,
    vaultLock,
    daoType,
    prepared.transaction.outputsData[1]!,
  );
  const withdrawing = DaoHarvestProgressV2.pack({
    version: 2,
    state: 1,
    cycle_index: 0,
    prepare_credit_hash: [...deriveDaoHarvestV2PrepareCreditHash(credit)],
  });
  const claimed = buildDaoHarvestV2ClaimTransition({
    ...prepareInput(),
    operation: "preferred_claim",
    progress: withdrawing,
    job: claimJob,
    vault: claimVault,
    compensation: cell("1", 201n * CKB, compensationLock, null, "0x"),
    prepareAccumulator: cell("2", 300n * CKB, accumulatorLock, null, "0x"),
    prepareCredit: credit,
    depositHeaderHash: hash("d"),
    prepareHeaderHash: hash("e"),
    depositAccumulatedRate: 10_000_000_000_000_000n,
    prepareAccumulatedRate: 10_010_000_000_000_000n,
    vaultOccupiedCapacity: 242n * CKB,
    executionSince: (1n << 61n) | 104n,
    nextPrepareSince: (1n << 61n) | 200n,
  });
  assert.equal(claimed.transaction.outputs.length, 5);
  assert.equal(BigInt(claimed.transaction.outputs[0]!.capacity), 400n * CKB);
  assert.equal(claimed.transaction.outputsData[1], "0x0000000000000000");
});

test("V2 transition builders fail closed on payload substitution and missing fallback proof", () => {
  const changedPayload = Uint8Array.from(payload);
  changedPayload[changedPayload.length - 1] = changedPayload.at(-1)! ^ 1;
  assert.throws(
    () => buildDaoHarvestV2PrepareTransition({ ...prepareInput(), payload: changedPayload }),
    /does not commit to the supplied V2 payload/,
  );
  assert.throws(
    () =>
      buildDaoHarvestV2PrepareTransition({
        ...prepareInput(),
        operation: "fallback_prepare",
      }),
    /requires the committed operator proof/,
  );
  assert.doesNotThrow(() =>
    buildDaoHarvestV2PrepareTransition({
      ...prepareInput(),
      operation: "fallback_prepare",
      operatorProof: proof,
    }),
  );
});
