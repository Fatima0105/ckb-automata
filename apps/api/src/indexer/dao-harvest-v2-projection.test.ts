import assert from "node:assert/strict";
import test from "node:test";

import { bytesToHex, scriptToHash, serializeWitnessArgs } from "@nervosnetwork/ckb-sdk-utils";

import {
  DAO_HARVEST_V2_ABSENT_INDEX,
  createEpoch,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2ProgressHash,
  encodeAbsoluteEpochSince,
  encodeDaoHarvestV2CompensationLockArgs,
  encodeDaoHarvestV2FallbackOperatorProof,
  encodeRelativeEpochSince,
  hash32FromBytes,
  hash32ToBytes,
  parseHash32,
  type Hash32,
  type ScriptIdentity,
} from "@ckb-automata/core";
import {
  DaoHarvestEnvelopeV2,
  DaoHarvestPayloadV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
  JobDataV1,
} from "@ckb-automata/molecule";

import {
  extractDaoHarvestV2ProjectionEvents,
  rebuildDaoHarvestV2Snapshot,
  type DaoHarvestV2ProjectionDeployment,
  type DaoHarvestV2ProjectionEvent,
} from "./dao-harvest-v2-projection.ts";

const hash = (value: string): Hash32 => parseHash32(`0x${value.repeat(64)}`);
const script = (value: string, args = "0x"): ScriptIdentity => ({
  codeHash: hash(value),
  hashType: "data1",
  args: args as `0x${string}`,
});
const jobId = hash("a");
const owner = hash("b");
const payout = hash("c");
const policy = script("d");
const policyHash = parseHash32(scriptToHash(policy));
const daoType = script("e");
const deployment: DaoHarvestV2ProjectionDeployment = {
  networkId: "ckb_testnet",
  jobLock: script("1"),
  policy,
  vaultLock: script("2"),
  compensationLock: script("3"),
  daoTypeHash: parseHash32(scriptToHash(daoType)),
};

function setupBlock() {
  const fallbackOperators = [hash32ToBytes(hash("4"))];
  const payload = DaoHarvestPayloadV2.pack({
    version: 2,
    owner_lock_hash: [...hash32ToBytes(owner)],
    payout_lock_hash: [...hash32ToBytes(payout)],
    vault_lock_code_hash: [...hash32ToBytes(deployment.vaultLock.codeHash)],
    compensation_lock_code_hash: [...hash32ToBytes(deployment.compensationLock.codeHash)],
    dao_type_hash: [...hash32ToBytes(deployment.daoTypeHash)],
    principal_capacity: "1000",
    preferred_prepare_operator_lock_hash: [...hash32ToBytes(hash("5"))],
    fallback_prepare_executor_set_hash: [
      ...deriveDaoHarvestV2FallbackOperatorSetHash(fallbackOperators),
    ],
    prepare_service_fee: "10",
    claim_service_fee: "20",
    compensation_seed_capacity: "200",
    prepare_buffer_epochs: encodeRelativeEpochSince(
      createEpoch({ number: 10n, index: 0n, length: 0n }),
    ).toString(),
    takeover_delay_epochs: encodeRelativeEpochSince(
      createEpoch({ number: 4n, index: 0n, length: 0n }),
    ).toString(),
    confirmation_margin_epochs: encodeRelativeEpochSince(
      createEpoch({ number: 1n, index: 0n, length: 0n }),
    ).toString(),
    total_cycles: 2,
    end_epoch_since: "0",
  });
  const progress = DaoHarvestProgressV2.pack({
    version: 2,
    state: 0,
    cycle_index: 0,
    prepare_credit_hash: Array(32).fill(0),
  });
  const payloadHash = hash32FromBytes(
    deriveDaoHarvestV2PayloadHash(hash32ToBytes(policyHash), payload),
  );
  const progressHash = hash32FromBytes(deriveDaoHarvestV2ProgressHash(progress));
  const notBefore = encodeAbsoluteEpochSince(createEpoch({ number: 100n, index: 0n, length: 0n }));
  const job = JobDataV1.pack({
    version: 1,
    flags: 0,
    job_id: [...hash32ToBytes(jobId)],
    sequence: "0",
    state: 0,
    trigger_kind: 2,
    trigger_params_hash: [...hash32ToBytes(progressHash)],
    policy_script_hash: [...hash32ToBytes(policyHash)],
    payload_hash: [...hash32ToBytes(payloadHash)],
    reward: "0",
    remaining_budget: "0",
    not_before: notBefore.toString(),
    not_after: "0",
    remaining_runs: 2,
    cancel_lock_hash: [...hash32ToBytes(owner)],
  });
  const witness = DaoHarvestWitnessV2.pack({
    version: 2,
    operation: 0,
    flags: 0,
    job_input_index: DAO_HARVEST_V2_ABSENT_INDEX,
    vault_input_index: DAO_HARVEST_V2_ABSENT_INDEX,
    compensation_input_index: DAO_HARVEST_V2_ABSENT_INDEX,
    identity_input_index: 0,
    prepare_accumulator_input_index: DAO_HARVEST_V2_ABSENT_INDEX,
    claim_accumulator_input_index: DAO_HARVEST_V2_ABSENT_INDEX,
    job_output_index: 0,
    vault_output_index: 1,
    compensation_output_index: 2,
    prepare_accumulator_output_index: DAO_HARVEST_V2_ABSENT_INDEX,
    claim_accumulator_output_index: DAO_HARVEST_V2_ABSENT_INDEX,
    payload_hash: [...hash32ToBytes(payloadHash)],
    progress_hash: [...hash32ToBytes(progressHash)],
    prepare_credit_hash: Array(32).fill(0),
  });
  const envelope = DaoHarvestEnvelopeV2.pack({
    payload: [...payload],
    progress: [...progress],
    prepare_credit: [],
    operator_proof: [...encodeDaoHarvestV2FallbackOperatorProof(fallbackOperators)],
    successor_payload: [],
  });
  const vaultArgs = new Uint8Array(160);
  vaultArgs.set(hash32ToBytes(jobId));
  const compensationArgs = encodeDaoHarvestV2CompensationLockArgs({
    jobId: hash32ToBytes(jobId),
    ownerLockHash: hash32ToBytes(owner),
    payoutLockHash: hash32ToBytes(payout),
    policyScriptHash: hash32ToBytes(policyHash),
    payloadHash: hash32ToBytes(payloadHash),
  });
  const txHash = hash("f");
  const transaction = {
    hash: () => txHash,
    inputs: [{ previousOutput: { txHash: hash("6"), index: "0x0" } }],
    outputs: [
      { capacity: "0x64", lock: { ...deployment.jobLock, args: "0x" }, type: policy },
      {
        capacity: "0x3e8",
        lock: { ...deployment.vaultLock, args: bytesToHex(vaultArgs) },
        type: daoType,
      },
      {
        capacity: "0xc8",
        lock: { ...deployment.compensationLock, args: bytesToHex(compensationArgs) },
        type: undefined,
      },
    ],
    outputsData: [bytesToHex(job), "0x0000000000000000", "0x"],
    witnesses: [
      serializeWitnessArgs({
        lock: "",
        inputType: bytesToHex(witness),
        outputType: bytesToHex(envelope),
      }),
    ],
  };
  return {
    block: {
      header: { hash: hash("7"), number: "0x64" },
      transactions: [transaction],
    },
    txHash,
  };
}

test("extracts a fully bound V2 setup projection from chain bytes", () => {
  const { block, txHash } = setupBlock();
  const result = extractDaoHarvestV2ProjectionEvents(block as never, deployment);
  assert.equal(result.malformed, 0);
  assert.equal(result.partial, 0);
  assert.equal(result.events.length, 1);
  const event = result.events[0]!;
  assert.equal(event.jobId, jobId);
  assert.equal(event.operation, "setup");
  assert.equal(event.transactionHash, txHash);
  assert.equal(event.lifecycleState, "deposited");
  assert.equal(event.compensationCapacity, "200");
  assert.equal(event.accumulatedCompensation, "0");
  assert.equal(event.operatorWindow?.preferredFromSince, absoluteSince(100n));
  assert.equal(event.operatorWindow?.fallbackFromSince, absoluteSince(104n));
  assert.equal(event.operatorWindow?.prepareCutoffSince, absoluteSince(109n));
});

function absoluteSince(number: bigint): string {
  return encodeAbsoluteEpochSince(createEpoch({ number, index: 0n, length: 0n })).toString();
}

function partialClaim(setup: DaoHarvestV2ProjectionEvent): DaoHarvestV2ProjectionEvent {
  return {
    ...setup,
    eventId: `${hash("8")}:0:preferred_claim`,
    transactionHash: hash("8"),
    blockNumber: "101",
    operation: "preferred_claim",
    cycleIndex: "1",
    projectionCompleteness: "partial",
    serviceSettlement: { status: "partial", preparePaid: null, claimPaid: null },
    prepareCredit: {
      cycleIndex: "0",
      preparerLockHash: hash("5"),
      preparedVaultOutputIndex: "1",
      jobOutputIndex: "0",
    },
  };
}

test("rebuild is duplicate-safe and preserves explicit partial settlement evidence", () => {
  const setup = extractDaoHarvestV2ProjectionEvents(setupBlock().block as never, deployment)
    .events[0]!;
  const claim = partialClaim(setup);
  const rebuilt = rebuildDaoHarvestV2Snapshot([setup, setup, claim]);
  assert.equal(rebuilt?.cycleIndex, "1");
  assert.equal(rebuilt?.projectionCompleteness, "partial");
  assert.equal(rebuilt?.serviceSettlement.status, "partial");
  assert.equal(rebuilt?.serviceSettlement.preparePaid, "0");
});

test("reorg rollback and database reset rebuild only canonical evidence", () => {
  const setup = extractDaoHarvestV2ProjectionEvents(setupBlock().block as never, deployment)
    .events[0]!;
  assert.equal(rebuildDaoHarvestV2Snapshot([{ ...setup, canonical: false }]), undefined);
  const beforeReset = rebuildDaoHarvestV2Snapshot([setup]);
  const afterReset = rebuildDaoHarvestV2Snapshot(structuredClone([setup]));
  assert.deepEqual(afterReset, beforeReset);
});

test("contradictory duplicates and immutable changes fail closed", () => {
  const setup = extractDaoHarvestV2ProjectionEvents(setupBlock().block as never, deployment)
    .events[0]!;
  assert.throws(() => rebuildDaoHarvestV2Snapshot([setup, { ...setup, blockHash: hash("9") }]));
  assert.throws(() =>
    rebuildDaoHarvestV2Snapshot([setup, { ...partialClaim(setup), payoutLockHash: hash("9") }]),
  );
});

test("rotation may replace only the rotatable payload commitment", () => {
  const setup = extractDaoHarvestV2ProjectionEvents(setupBlock().block as never, deployment)
    .events[0]!;
  const rotation: DaoHarvestV2ProjectionEvent = {
    ...setup,
    eventId: `${hash("9")}:0:rotate`,
    transactionHash: hash("9"),
    blockNumber: "101",
    operation: "rotate",
    payloadHash: hash("0"),
  };
  assert.equal(rebuildDaoHarvestV2Snapshot([setup, rotation])?.payloadHash, hash("0"));
  assert.throws(() =>
    rebuildDaoHarvestV2Snapshot([setup, { ...rotation, ownerLockHash: hash("9") }]),
  );
  assert.throws(() =>
    rebuildDaoHarvestV2Snapshot([setup, { ...rotation, payoutLockHash: hash("9") }]),
  );
});

test("unrelated transactions are ignored without malformed noise", () => {
  const { block } = setupBlock();
  const transaction = block.transactions[0]!;
  for (const output of transaction.outputs) {
    output.lock = script("9");
    output.type = undefined;
  }
  const result = extractDaoHarvestV2ProjectionEvents(block as never, deployment);
  assert.deepEqual(result, { events: [], malformed: 0, partial: 0 });
});

test("relevant transactions without the closed V2 witness are malformed", () => {
  const { block } = setupBlock();
  block.transactions[0]!.witnesses = ["0x"];
  const result = extractDaoHarvestV2ProjectionEvents(block as never, deployment);
  assert.equal(result.events.length, 0);
  assert.equal(result.malformed, 1);
});

test("malformed commitment bytes never become an authoritative projection", () => {
  const { block } = setupBlock();
  const transaction = block.transactions[0]!;
  transaction.outputsData[0] = "0x";
  const result = extractDaoHarvestV2ProjectionEvents(block as never, deployment);
  assert.equal(result.events.length, 0);
  assert.equal(result.malformed, 1);
});
