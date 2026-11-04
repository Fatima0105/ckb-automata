import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
} from "@ckb-automata/molecule";

import {
  DAO_HARVEST_V2_ABSENT_INDEX,
  DAO_HARVEST_V2_OPERATIONS,
  assertDaoHarvestV2WitnessLayout,
  decodeDaoHarvestV2CompensationLockArgs,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  decodeDaoHarvestV2FallbackOperatorProof,
  encodeDaoHarvestV2FallbackOperatorProof,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  encodeDaoHarvestV2CompensationLockArgs,
  normalizeDaoHarvestV2FallbackOperators,
  type DaoHarvestV2Operation,
  type DaoHarvestV2WitnessIndices,
} from "./dao-harvest-v2.ts";

type Section = Record<string, string | number | string[]>;
interface Fixture {
  payload: Section;
  prepare_credit: Section;
  progress: Section;
  witness: Section;
  envelope: Section;
  compensation_lock_args: Section;
}

const decode = (value: unknown) => {
  const digits = String(value).replace(/^0x/, "");
  if (digits.length % 2 !== 0 || !/^[0-9a-f]*$/.test(digits)) throw new TypeError("invalid hex");
  return Uint8Array.from({ length: digits.length / 2 }, (_, index) =>
    Number.parseInt(digits.slice(index * 2, index * 2 + 2), 16),
  );
};
const encode = (value: Uint8Array) =>
  `0x${Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

async function fixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/dao_harvest_v2.json", import.meta.url),
      "utf8",
    ),
  ) as Fixture;
}

function payloadValue(value: Section) {
  return {
    version: value["version"] as number,
    owner_lock_hash: [...decode(value["owner_lock_hash"])],
    payout_lock_hash: [...decode(value["payout_lock_hash"])],
    vault_lock_hash: [...decode(value["vault_lock_hash"])],
    compensation_lock_hash: [...decode(value["compensation_lock_hash"])],
    dao_type_hash: [...decode(value["dao_type_hash"])],
    principal_capacity: value["principal_capacity"] as string,
    preferred_prepare_operator_lock_hash: [
      ...decode(value["preferred_prepare_operator_lock_hash"]),
    ],
    fallback_prepare_executor_set_hash: [...decode(value["fallback_prepare_executor_set_hash"])],
    prepare_service_fee: value["prepare_service_fee"] as string,
    claim_service_fee: value["claim_service_fee"] as string,
    compensation_seed_capacity: value["compensation_seed_capacity"] as string,
    prepare_buffer_epochs: value["prepare_buffer_epochs"] as string,
    takeover_delay_epochs: value["takeover_delay_epochs"] as string,
    confirmation_margin_epochs: value["confirmation_margin_epochs"] as string,
    total_cycles: value["total_cycles"] as number,
    end_epoch_since: value["end_epoch_since"] as string,
  };
}

function creditValue(value: Section) {
  return {
    version: value["version"] as number,
    job_id: [...decode(value["job_id"])],
    cycle_index: value["cycle_index"] as number,
    preparer_lock_hash: [...decode(value["preparer_lock_hash"])],
    prepared_vault_output_index: value["prepared_vault_output_index"] as number,
    job_output_index: value["job_output_index"] as number,
  };
}

function progressValue(value: Section) {
  return {
    version: value["version"] as number,
    state: value["state"] as number,
    cycle_index: value["cycle_index"] as number,
    prepare_credit_hash: [...decode(value["prepare_credit_hash"])],
  };
}

test("V2 domains, fallback set, and five-lock binding match the Rust fixture", async () => {
  const value = await fixture();
  const payloadBytes = DaoHarvestPayloadV2.pack(payloadValue(value.payload));
  assert.equal(encode(payloadBytes), value.payload["expected_hex"]);
  assert.equal(
    encode(
      deriveDaoHarvestV2PayloadHash(decode(value.payload["policy_script_hash"]), payloadBytes),
    ),
    value.payload["expected_hash"],
  );
  assert.equal(
    encode(
      deriveDaoHarvestV2FallbackOperatorSetHash(
        (value.payload["fallback_prepare_executor_lock_hashes"] as string[]).map(decode),
      ),
    ),
    value.payload["fallback_prepare_executor_set_hash"],
  );

  const creditBytes = DaoHarvestPrepareCreditV2.pack(creditValue(value.prepare_credit));
  assert.equal(encode(creditBytes), value.prepare_credit["expected_hex"]);
  assert.equal(
    encode(deriveDaoHarvestV2PrepareCreditHash(creditBytes)),
    value.prepare_credit["expected_hash"],
  );
  const progressBytes = DaoHarvestProgressV2.pack(progressValue(value.progress));
  assert.equal(encode(progressBytes), value.progress["expected_hex"]);
  assert.equal(
    encode(deriveDaoHarvestV2ProgressHash(progressBytes)),
    value.progress["expected_hash"],
  );

  const args = {
    jobId: decode(value.compensation_lock_args["job_id"]),
    ownerLockHash: decode(value.compensation_lock_args["owner_lock_hash"]),
    payoutLockHash: decode(value.compensation_lock_args["payout_lock_hash"]),
    policyScriptHash: decode(value.compensation_lock_args["policy_script_hash"]),
    payloadHash: decode(value.compensation_lock_args["payload_hash"]),
  };
  const encodedArgs = encodeDaoHarvestV2CompensationLockArgs(args);
  assert.equal(encode(encodedArgs), value.compensation_lock_args["expected_hex"]);
  assert.deepEqual(decodeDaoHarvestV2CompensationLockArgs(encodedArgs), args);
});

test("fallback identities are sorted, copied, bounded, and unique", () => {
  const first = Uint8Array.from({ length: 32 }, () => 0x11);
  const second = Uint8Array.from({ length: 32 }, () => 0x22);
  assert.deepEqual(normalizeDaoHarvestV2FallbackOperators([second, first]), [first, second]);
  assert.throws(() => normalizeDaoHarvestV2FallbackOperators([]), /1 to 8/);
  assert.throws(
    () => normalizeDaoHarvestV2FallbackOperators(Array.from({ length: 9 }, () => first)),
    /1 to 8/,
  );
  assert.throws(() => normalizeDaoHarvestV2FallbackOperators([first, first]), /duplicate/);
  assert.throws(() => normalizeDaoHarvestV2FallbackOperators([new Uint8Array(31)]), /32 bytes/);
});

test("fallback proof is canonical and matches the committed set", async () => {
  const value = await fixture();
  const operators = (value.payload["fallback_prepare_executor_lock_hashes"] as string[]).map(
    decode,
  );
  const expectedHash = decode(value.payload["fallback_prepare_executor_set_hash"]);
  const proof = encodeDaoHarvestV2FallbackOperatorProof(operators);
  assert.equal(encode(proof), value.envelope["operator_proof"]);
  assert.deepEqual(
    decodeDaoHarvestV2FallbackOperatorProof(proof, expectedHash),
    normalizeDaoHarvestV2FallbackOperators(operators),
  );

  const reversed = Uint8Array.from(proof);
  reversed.set(proof.slice(32, 64), 0);
  reversed.set(proof.slice(0, 32), 32);
  assert.throws(
    () => decodeDaoHarvestV2FallbackOperatorProof(reversed, expectedHash),
    /strictly sorted/,
  );
  assert.throws(
    () =>
      decodeDaoHarvestV2FallbackOperatorProof(
        proof,
        Uint8Array.from(expectedHash, (byte, index) => (index === 0 ? byte ^ 1 : byte)),
      ),
    /does not match/,
  );
});

const absentIndices = (): DaoHarvestV2WitnessIndices => ({
  jobInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  vaultInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  compensationInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  identityInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  prepareAccumulatorInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  claimAccumulatorInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  jobOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  vaultOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  compensationOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  prepareAccumulatorOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
  claimAccumulatorOutputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
});

function validIndices(operation: DaoHarvestV2Operation): DaoHarvestV2WitnessIndices {
  const value = absentIndices();
  const mutable = value as unknown as Record<keyof DaoHarvestV2WitnessIndices, number>;
  const present = (names: readonly (keyof DaoHarvestV2WitnessIndices)[]) => {
    names.forEach((name, index) => (mutable[name] = index));
  };
  switch (operation) {
    case DAO_HARVEST_V2_OPERATIONS.SETUP:
      present([
        "identityInputIndex",
        "jobOutputIndex",
        "vaultOutputIndex",
        "compensationOutputIndex",
      ]);
      break;
    case DAO_HARVEST_V2_OPERATIONS.PREFERRED_PREPARE:
    case DAO_HARVEST_V2_OPERATIONS.FALLBACK_PREPARE:
      present([
        "jobInputIndex",
        "vaultInputIndex",
        "identityInputIndex",
        "jobOutputIndex",
        "vaultOutputIndex",
      ]);
      break;
    case DAO_HARVEST_V2_OPERATIONS.PREFERRED_CLAIM:
    case DAO_HARVEST_V2_OPERATIONS.FALLBACK_CLAIM:
    case DAO_HARVEST_V2_OPERATIONS.OWNER_COMPLETE:
      present([
        "jobInputIndex",
        "vaultInputIndex",
        "compensationInputIndex",
        "identityInputIndex",
        "vaultOutputIndex",
        "compensationOutputIndex",
      ]);
      break;
    case DAO_HARVEST_V2_OPERATIONS.SWEEP:
      present([
        "jobInputIndex",
        "compensationInputIndex",
        "identityInputIndex",
        "jobOutputIndex",
        "compensationOutputIndex",
      ]);
      break;
    case DAO_HARVEST_V2_OPERATIONS.CLOSE:
      present(["jobInputIndex", "compensationInputIndex", "identityInputIndex"]);
      break;
    case DAO_HARVEST_V2_OPERATIONS.ROTATE:
      present([
        "jobInputIndex",
        "compensationInputIndex",
        "identityInputIndex",
        "jobOutputIndex",
        "compensationOutputIndex",
      ]);
      break;
    case DAO_HARVEST_V2_OPERATIONS.RECOVER:
      present(["jobInputIndex", "vaultInputIndex", "compensationInputIndex", "identityInputIndex"]);
      break;
  }
  return value;
}

test("every operation has a closed witness-index layout", () => {
  const operations = Object.values(DAO_HARVEST_V2_OPERATIONS);
  for (const operation of operations) {
    const valid = validIndices(operation);
    assert.doesNotThrow(() => assertDaoHarvestV2WitnessLayout(operation, 0, valid));
    assert.throws(() => assertDaoHarvestV2WitnessLayout(operation, 1, valid), /reserved/);
  }
  assert.throws(
    () => assertDaoHarvestV2WitnessLayout(10 as DaoHarvestV2Operation, 0, absentIndices()),
    /unsupported/,
  );
  const prepare = validIndices(DAO_HARVEST_V2_OPERATIONS.PREFERRED_PREPARE);
  assert.throws(
    () =>
      assertDaoHarvestV2WitnessLayout(DAO_HARVEST_V2_OPERATIONS.PREFERRED_PREPARE, 0, {
        ...prepare,
        compensationInputIndex: 9,
      }),
    /must be absent/,
  );
  assert.throws(
    () =>
      assertDaoHarvestV2WitnessLayout(DAO_HARVEST_V2_OPERATIONS.PREFERRED_PREPARE, 0, {
        ...prepare,
        jobInputIndex: DAO_HARVEST_V2_ABSENT_INDEX,
      }),
    /is required/,
  );
});

test("operator accumulator witness indices are exact pairs", () => {
  const claim = validIndices(DAO_HARVEST_V2_OPERATIONS.PREFERRED_CLAIM);
  assert.throws(
    () =>
      assertDaoHarvestV2WitnessLayout(DAO_HARVEST_V2_OPERATIONS.PREFERRED_CLAIM, 0, {
        ...claim,
        prepareAccumulatorInputIndex: 6,
      }),
    /present together/,
  );
  assert.doesNotThrow(() =>
    assertDaoHarvestV2WitnessLayout(DAO_HARVEST_V2_OPERATIONS.PREFERRED_CLAIM, 0, {
      ...claim,
      prepareAccumulatorInputIndex: 6,
      prepareAccumulatorOutputIndex: 5,
      claimAccumulatorInputIndex: 7,
      claimAccumulatorOutputIndex: 6,
    }),
  );
});

test("the fixture witness carries the exact committed hashes", async () => {
  const value = await fixture();
  const witness = value.witness;
  const encoded = DaoHarvestWitnessV2.pack({
    version: witness["version"] as number,
    operation: witness["operation"] as number,
    flags: witness["flags"] as number,
    job_input_index: witness["job_input_index"] as number,
    vault_input_index: witness["vault_input_index"] as number,
    compensation_input_index: witness["compensation_input_index"] as number,
    identity_input_index: witness["identity_input_index"] as number,
    prepare_accumulator_input_index: witness["prepare_accumulator_input_index"] as number,
    claim_accumulator_input_index: witness["claim_accumulator_input_index"] as number,
    job_output_index: witness["job_output_index"] as number,
    vault_output_index: witness["vault_output_index"] as number,
    compensation_output_index: witness["compensation_output_index"] as number,
    prepare_accumulator_output_index: witness["prepare_accumulator_output_index"] as number,
    claim_accumulator_output_index: witness["claim_accumulator_output_index"] as number,
    payload_hash: [...decode(witness["payload_hash"])],
    progress_hash: [...decode(witness["progress_hash"])],
    prepare_credit_hash: [...decode(witness["prepare_credit_hash"])],
  });
  assert.equal(encode(encoded), witness["expected_hex"]);
});
