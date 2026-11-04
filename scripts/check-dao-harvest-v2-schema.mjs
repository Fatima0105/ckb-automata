import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const schema = await readFile(
  new URL("../contracts/schemas/dao_harvest_v2.mol", import.meta.url),
  "utf8",
);

function tableFields(name) {
  const body = schema.match(new RegExp(`table\\s+${name}\\s*\\{(?<body>[\\s\\S]*?)\\}`))?.groups
    ?.body;
  assert.ok(body, `${name} table is missing`);
  return [...body.matchAll(/^\s+(\w+):\s+(\w+),\s*$/gm)].map(
    ([, field, type]) => `${field}:${type}`,
  );
}

assert.match(schema, /array CompensationLockArgsV2 \[byte; 160\];/);

assert.deepEqual(tableFields("DaoHarvestPayloadV2"), [
  "version:Uint16",
  "owner_lock_hash:Byte32",
  "payout_lock_hash:Byte32",
  "vault_lock_hash:Byte32",
  "compensation_lock_hash:Byte32",
  "dao_type_hash:Byte32",
  "principal_capacity:Uint64",
  "preferred_prepare_operator_lock_hash:Byte32",
  "fallback_prepare_executor_set_hash:Byte32",
  "prepare_service_fee:Uint64",
  "claim_service_fee:Uint64",
  "compensation_seed_capacity:Uint64",
  "prepare_buffer_epochs:Uint64",
  "takeover_delay_epochs:Uint64",
  "confirmation_margin_epochs:Uint64",
  "total_cycles:Uint32",
  "end_epoch_since:Uint64",
]);

assert.deepEqual(tableFields("DaoHarvestPrepareCreditV2"), [
  "version:Uint16",
  "job_id:Byte32",
  "cycle_index:Uint32",
  "preparer_lock_hash:Byte32",
  "prepared_vault_output_index:Uint32",
  "job_output_index:Uint32",
]);

assert.deepEqual(tableFields("DaoHarvestProgressV2"), [
  "version:Uint16",
  "state:byte",
  "cycle_index:Uint32",
  "prepare_credit_hash:Byte32",
]);

assert.deepEqual(tableFields("DaoHarvestWitnessV2"), [
  "version:Uint16",
  "operation:byte",
  "flags:byte",
  "job_input_index:Uint32",
  "vault_input_index:Uint32",
  "compensation_input_index:Uint32",
  "identity_input_index:Uint32",
  "prepare_accumulator_input_index:Uint32",
  "claim_accumulator_input_index:Uint32",
  "job_output_index:Uint32",
  "vault_output_index:Uint32",
  "compensation_output_index:Uint32",
  "prepare_accumulator_output_index:Uint32",
  "claim_accumulator_output_index:Uint32",
  "payload_hash:Byte32",
  "progress_hash:Byte32",
  "prepare_credit_hash:Byte32",
]);

assert.deepEqual(tableFields("DaoHarvestEnvelopeV2"), [
  "payload:Bytes",
  "progress:Bytes",
  "prepare_credit:Bytes",
]);

for (const rule of [
  "job_id || owner_lock_hash || payout_lock_hash || policy_script_hash ||",
  "UINT32_MAX is the only",
  "both consumed outpoints",
  "owner-authorized rotation",
  "No field authorizes a reduction of principal",
]) {
  assert.ok(schema.includes(rule), `missing V2 schema rule: ${rule}`);
}

for (const forbiddenField of ["min_compensation", "executor_reward", "remaining_budget"]) {
  assert.ok(!schema.includes(`${forbiddenField}:`), `forbidden V2 field: ${forbiddenField}`);
}

console.log("DAO Harvest V2 schema review passed: 47 ordered fields and one 160-byte lock layout");
