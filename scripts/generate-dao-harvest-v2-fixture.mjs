import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import {
  DaoHarvestPayloadV2,
  DaoHarvestEnvelopeV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
} from "../packages/molecule/src/generated/dao_harvest_v2.ts";
import {
  DAO_HARVEST_V2_OPERATIONS,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  encodeDaoHarvestV2FallbackOperatorProof,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  encodeDaoHarvestV2CompensationLockArgs,
} from "../packages/core/src/dao-harvest-v2.ts";

const root = new URL("../", import.meta.url);
const outputUrl = new URL("contracts/fixtures/dao_harvest_v2.json", root);
const checkOnly = process.argv.slice(2).includes("--check");
const hex = (value) =>
  `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
const fill = (value) => Uint8Array.from({ length: 32 }, () => value);
const relativeEpoch = (number, index = 0n, length = 0n) =>
  (1n << 63n) | (1n << 61n) | number | (index << 24n) | (length << 40n);

const owner = fill(0x11);
const payout = fill(0x22);
const vault = fill(0x33);
const compensation = fill(0x44);
const preferred = fill(0x55);
const fallbackOperators = [fill(0x77), fill(0x66)];
const fallbackSetHash = deriveDaoHarvestV2FallbackOperatorSetHash(fallbackOperators);
const fallbackOperatorProof = encodeDaoHarvestV2FallbackOperatorProof(fallbackOperators);
const daoType = fill(0xab);
const policy = fill(0xaa);
const jobId = fill(0x88);

const payloadValue = {
  version: 2,
  owner_lock_hash: [...owner],
  payout_lock_hash: [...payout],
  vault_lock_hash: [...vault],
  compensation_lock_hash: [...compensation],
  dao_type_hash: [...daoType],
  principal_capacity: "10000000000000",
  preferred_prepare_operator_lock_hash: [...preferred],
  fallback_prepare_executor_set_hash: [...fallbackSetHash],
  prepare_service_fee: "2000000000",
  claim_service_fee: "3000000000",
  compensation_seed_capacity: "20100000000",
  prepare_buffer_epochs: relativeEpoch(4n).toString(),
  takeover_delay_epochs: relativeEpoch(0n, 1n, 20n).toString(),
  confirmation_margin_epochs: relativeEpoch(1n).toString(),
  total_cycles: 3,
  end_epoch_since: ((1n << 61n) | 4096n).toString(),
};
const payloadBytes = DaoHarvestPayloadV2.pack(payloadValue);
const payloadHash = deriveDaoHarvestV2PayloadHash(policy, payloadBytes);

const creditValue = {
  version: 2,
  job_id: [...jobId],
  cycle_index: 0,
  preparer_lock_hash: [...preferred],
  prepared_vault_output_index: 0,
  job_output_index: 1,
};
const creditBytes = DaoHarvestPrepareCreditV2.pack(creditValue);
const creditHash = deriveDaoHarvestV2PrepareCreditHash(creditBytes);

const progressValue = {
  version: 2,
  state: 1,
  cycle_index: 0,
  prepare_credit_hash: [...creditHash],
};
const progressBytes = DaoHarvestProgressV2.pack(progressValue);
const progressHash = deriveDaoHarvestV2ProgressHash(progressBytes);

const witnessValue = {
  version: 2,
  operation: DAO_HARVEST_V2_OPERATIONS.PREFERRED_CLAIM,
  flags: 0,
  job_input_index: 0,
  vault_input_index: 1,
  compensation_input_index: 2,
  identity_input_index: 3,
  prepare_accumulator_input_index: 4,
  claim_accumulator_input_index: 5,
  job_output_index: 0,
  vault_output_index: 1,
  compensation_output_index: 2,
  prepare_accumulator_output_index: 3,
  claim_accumulator_output_index: 4,
  payload_hash: [...payloadHash],
  progress_hash: [...progressHash],
  prepare_credit_hash: [...creditHash],
};
const witnessBytes = DaoHarvestWitnessV2.pack(witnessValue);
const envelopeValue = {
  payload: [...payloadBytes],
  progress: [...progressBytes],
  prepare_credit: [...creditBytes],
  operator_proof: [...fallbackOperatorProof],
};
const envelopeBytes = DaoHarvestEnvelopeV2.pack(envelopeValue);
const compensationArgs = encodeDaoHarvestV2CompensationLockArgs({
  jobId,
  ownerLockHash: owner,
  payoutLockHash: payout,
  policyScriptHash: policy,
  payloadHash,
});

const fixture = {
  payload: {
    ...payloadValue,
    owner_lock_hash: hex(owner),
    payout_lock_hash: hex(payout),
    vault_lock_hash: hex(vault),
    compensation_lock_hash: hex(compensation),
    dao_type_hash: hex(daoType),
    preferred_prepare_operator_lock_hash: hex(preferred),
    fallback_prepare_executor_lock_hashes: fallbackOperators.map(hex),
    fallback_prepare_executor_set_hash: hex(fallbackSetHash),
    policy_script_hash: hex(policy),
    expected_hex: hex(payloadBytes),
    expected_hash: hex(payloadHash),
  },
  prepare_credit: {
    ...creditValue,
    job_id: hex(jobId),
    preparer_lock_hash: hex(preferred),
    expected_hex: hex(creditBytes),
    expected_hash: hex(creditHash),
  },
  progress: {
    ...progressValue,
    prepare_credit_hash: hex(creditHash),
    expected_hex: hex(progressBytes),
    expected_hash: hex(progressHash),
  },
  witness: {
    ...witnessValue,
    payload_hash: hex(payloadHash),
    progress_hash: hex(progressHash),
    prepare_credit_hash: hex(creditHash),
    expected_hex: hex(witnessBytes),
  },
  envelope: {
    payload: hex(payloadBytes),
    progress: hex(progressBytes),
    prepare_credit: hex(creditBytes),
    operator_proof: hex(fallbackOperatorProof),
    expected_hex: hex(envelopeBytes),
  },
  compensation_lock_args: {
    job_id: hex(jobId),
    owner_lock_hash: hex(owner),
    payout_lock_hash: hex(payout),
    policy_script_hash: hex(policy),
    payload_hash: hex(payloadHash),
    expected_hex: hex(compensationArgs),
  },
};

const content = `${JSON.stringify(fixture, null, 2)}\n`;
if (checkOnly) {
  assert.equal((await readFile(outputUrl, "utf8")).replaceAll("\r\n", "\n"), content);
} else {
  await writeFile(outputUrl, content);
}
console.log(`${checkOnly ? "Checked" : "Generated"} ${outputUrl.pathname}`);
