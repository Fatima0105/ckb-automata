import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { bytes } from "@ckb-lumos/codec";

import {
  DaoHarvestPayloadV2,
  DaoHarvestEnvelopeV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
} from "./generated/dao_harvest_v2.ts";

type JsonRecord = Record<string, string | number | string[]>;

interface Fixture {
  payload: JsonRecord;
  prepare_credit: JsonRecord;
  progress: JsonRecord;
  witness: JsonRecord;
  envelope: JsonRecord;
  compensation_lock_args: JsonRecord;
}

const payloadFields = [
  "version",
  "owner_lock_hash",
  "payout_lock_hash",
  "vault_lock_code_hash",
  "compensation_lock_code_hash",
  "dao_type_hash",
  "principal_capacity",
  "preferred_prepare_operator_lock_hash",
  "fallback_prepare_executor_set_hash",
  "prepare_service_fee",
  "claim_service_fee",
  "compensation_seed_capacity",
  "prepare_buffer_epochs",
  "takeover_delay_epochs",
  "confirmation_margin_epochs",
  "total_cycles",
  "end_epoch_since",
] as const;

const creditFields = [
  "version",
  "job_id",
  "cycle_index",
  "preparer_lock_hash",
  "prepared_vault_output_index",
  "job_output_index",
] as const;

const progressFields = ["version", "state", "cycle_index", "prepare_credit_hash"] as const;

const witnessFields = [
  "version",
  "operation",
  "flags",
  "job_input_index",
  "vault_input_index",
  "compensation_input_index",
  "identity_input_index",
  "prepare_accumulator_input_index",
  "claim_accumulator_input_index",
  "job_output_index",
  "vault_output_index",
  "compensation_output_index",
  "prepare_accumulator_output_index",
  "claim_accumulator_output_index",
  "payload_hash",
  "progress_hash",
  "prepare_credit_hash",
] as const;

function byteArray(value: string): number[] {
  return Array.from(bytes.bytify(value));
}

function codecValue(
  record: JsonRecord,
  fields: readonly string[],
): Record<string, string | number | number[]> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = record[field];
      assert.notEqual(value, undefined, `fixture field ${field}`);
      return [
        field,
        typeof value === "string" && value.startsWith("0x") ? byteArray(value) : value,
      ];
    }),
  ) as Record<string, string | number | number[]>;
}

function changed(value: string | number | number[]): string | number | number[] {
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[0] = (copy[0]! + 1) & 0xff;
    return copy;
  }
  return typeof value === "number" ? value + 1 : (BigInt(value) + 1n).toString();
}

async function fixture(): Promise<Fixture> {
  return JSON.parse(
    await readFile(
      new URL("../../../contracts/fixtures/dao_harvest_v2.json", import.meta.url),
      "utf8",
    ),
  ) as Fixture;
}

test("DAO Harvest V2 Molecule types match the canonical fixture", async () => {
  const value = await fixture();
  for (const [codec, record, fields] of [
    [DaoHarvestPayloadV2, value.payload, payloadFields],
    [DaoHarvestPrepareCreditV2, value.prepare_credit, creditFields],
    [DaoHarvestProgressV2, value.progress, progressFields],
    [DaoHarvestWitnessV2, value.witness, witnessFields],
  ] as const) {
    const encoded = codec.pack(codecValue(record, fields) as never);
    assert.equal(bytes.hexify(encoded), record["expected_hex"]);
    assert.deepEqual(codec.pack(codec.unpack(encoded) as never), encoded);
  }
});

test("every V2 persistent and witness field changes its canonical bytes", async () => {
  const value = await fixture();
  for (const [codec, record, fields] of [
    [DaoHarvestPayloadV2, value.payload, payloadFields],
    [DaoHarvestPrepareCreditV2, value.prepare_credit, creditFields],
    [DaoHarvestProgressV2, value.progress, progressFields],
    [DaoHarvestWitnessV2, value.witness, witnessFields],
  ] as const) {
    const canonical = codecValue(record, fields);
    const encoded = bytes.hexify(codec.pack(canonical as never));
    for (const field of fields) {
      const fieldValue = canonical[field];
      assert.notEqual(fieldValue, undefined);
      const mutation = { ...canonical, [field]: changed(fieldValue!) };
      assert.notEqual(bytes.hexify(codec.pack(mutation as never)), encoded, field);
    }
  }
});

test("Compensation Lock args fixture has five ordered non-interchangeable hashes", async () => {
  const value = await fixture();
  const fields = [
    "job_id",
    "owner_lock_hash",
    "payout_lock_hash",
    "policy_script_hash",
    "payload_hash",
  ] as const;
  const expected = fields.map((field) => String(value.compensation_lock_args[field])).join("");
  assert.equal(
    String(value.compensation_lock_args["expected_hex"]),
    `0x${expected.replaceAll("0x", "")}`,
  );
  assert.equal(bytes.bytify(String(value.compensation_lock_args["expected_hex"])).length, 160);
});

test("V2 witness envelope frames all external bytes without inferred lengths", async () => {
  const value = await fixture();
  const encoded = DaoHarvestEnvelopeV2.pack({
    payload: byteArray(String(value.envelope["payload"])),
    progress: byteArray(String(value.envelope["progress"])),
    prepare_credit: byteArray(String(value.envelope["prepare_credit"])),
    operator_proof: byteArray(String(value.envelope["operator_proof"])),
    successor_payload: byteArray(String(value.envelope["successor_payload"])),
  });
  assert.equal(bytes.hexify(encoded), value.envelope["expected_hex"]);
  const decoded = DaoHarvestEnvelopeV2.unpack(encoded);
  assert.equal(bytes.hexify(Uint8Array.from(decoded.payload)), value.envelope["payload"]);
  assert.equal(bytes.hexify(Uint8Array.from(decoded.progress)), value.envelope["progress"]);
  assert.equal(
    bytes.hexify(Uint8Array.from(decoded.prepare_credit)),
    value.envelope["prepare_credit"],
  );
  assert.equal(
    bytes.hexify(Uint8Array.from(decoded.operator_proof)),
    value.envelope["operator_proof"],
  );
  assert.equal(
    bytes.hexify(Uint8Array.from(decoded.successor_payload)),
    value.envelope["successor_payload"],
  );
});
