import { readFile } from "node:fs/promises";

import {
  ECPair,
  EMPTY_SECP_SIG,
  PERSONAL,
  blake160,
  blake2b,
  hexToBytes,
  rawTransactionToHash,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  DAO_HARVEST_V2_ABSENT_INDEX,
  DAO_HARVEST_V2_OPERATIONS,
  addEpochFractions,
  assertHarvestV2TransactionWithinLimits,
  calculateDaoMaximumWithdraw,
  compareEpochFractions,
  decodeAbsoluteEpochSince,
  decodeRelativeEpochSince,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  hash32FromBytes,
  parseHash32,
  parseEpoch,
  parseOutputIndex,
  parseShannons,
  type Hash32,
  type OutPoint,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";
import { clientDaoAccumulatedRate } from "@ckb-automata/ccc";
import {
  DaoHarvestEnvelopeV2,
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
  JobDataV1,
} from "@ckb-automata/molecule";

import type { OperatorConfiguration } from "./config.ts";
import type { LoadedOperatorManifest } from "./manifest.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { record, string } from "./rpc.ts";

type Hex = `0x${string}`;

export interface OperatorExecutionBundle {
  readonly schemaVersion: 1;
  readonly manifestSha256: string;
  readonly operation: "fallback_claim";
  readonly jobId: Hash32;
  readonly transaction: UnsignedDeadlineTransaction;
}

interface ResolvedInput {
  readonly capacity: bigint;
  readonly lock: ScriptIdentity;
  readonly data: Hex;
}

function littleEndian(value: number, bytes: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("length is invalid");
  let remaining = BigInt(value);
  const encoded = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new RangeError("length does not fit its encoding");
  return encoded;
}

function parseTransaction(value: unknown): UnsignedDeadlineTransaction {
  const transaction = record(value, "transaction") as unknown as UnsignedDeadlineTransaction;
  if (
    !Array.isArray(transaction.cellDeps) ||
    !Array.isArray(transaction.headerDeps) ||
    !Array.isArray(transaction.inputs) ||
    !Array.isArray(transaction.outputs) ||
    !Array.isArray(transaction.outputsData) ||
    !Array.isArray(transaction.witnesses) ||
    transaction.outputs.length !== transaction.outputsData.length
  ) {
    throw new TypeError("transaction arrays are invalid");
  }
  return transaction;
}

export async function loadExecutionBundle(path: string): Promise<OperatorExecutionBundle> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  const value = record(parsed, "execution bundle");
  if (value["schemaVersion"] !== 1 || value["operation"] !== "fallback_claim") {
    throw new TypeError("execution bundle must be a fallback claim bundle");
  }
  const manifestSha256 = string(value["manifestSha256"], "manifestSha256");
  if (!/^[0-9a-f]{64}$/.test(manifestSha256)) {
    throw new TypeError("manifestSha256 is invalid");
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    manifestSha256,
    operation: "fallback_claim" as const,
    jobId: parseHash32(string(value["jobId"], "jobId")),
    transaction: parseTransaction(value["transaction"]),
  });
}

function rpcScript(value: unknown, name: string): ScriptIdentity {
  const parsed = record(value, name);
  const hashType = string(parsed["hash_type"], `${name}.hash_type`);
  if (hashType !== "data" && hashType !== "data1" && hashType !== "type") {
    throw new TypeError(`${name}.hash_type is invalid`);
  }
  return Object.freeze({
    codeHash: parseHash32(string(parsed["code_hash"], `${name}.code_hash`)),
    hashType,
    args: string(parsed["args"], `${name}.args`) as Hex,
  });
}

async function resolveInputs(
  transaction: UnsignedDeadlineTransaction,
  rpc: JsonRpcClient,
): Promise<readonly ResolvedInput[]> {
  return Promise.all(
    transaction.inputs.map(async (input, index) => {
      const result = record(
        await rpc.call("get_live_cell", [
          {
            tx_hash: input.previousOutput.txHash,
            index: input.previousOutput.index,
          },
          true,
        ]),
        `input ${index}`,
      );
      if (result["status"] !== "live") throw new Error(`input ${index} is no longer live`);
      const cell = record(result["cell"], `input ${index} cell`);
      const output = record(cell["output"], `input ${index} output`);
      const data = record(cell["data"], `input ${index} data`);
      return Object.freeze({
        capacity: BigInt(string(output["capacity"], `input ${index} capacity`)),
        lock: rpcScript(output["lock"], `input ${index} lock`),
        data: string(data["content"], `input ${index} data content`) as Hex,
      });
    }),
  );
}

function witnessArgs(bytes: Hex): { inputType: Uint8Array; outputType: Uint8Array } {
  const raw = hexToBytes(bytes);
  if (raw.length < 16) throw new Error("witness 0 is not a Molecule WitnessArgs table");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const total = view.getUint32(0, true);
  const first = view.getUint32(4, true);
  const second = view.getUint32(8, true);
  const third = view.getUint32(12, true);
  if (total !== raw.length || first !== 16 || second < first || third < second || third > total) {
    throw new Error("witness 0 has invalid offsets");
  }
  const field = (start: number, end: number) => {
    if (start === end) return new Uint8Array();
    if (end - start < 4 || view.getUint32(start, true) !== end - start - 4) {
      throw new Error("witness 0 contains an invalid Bytes field");
    }
    return raw.slice(start + 4, end);
  };
  return { inputType: field(second, third), outputType: field(third, total) };
}

function outPoint(input: UnsignedDeadlineTransaction["inputs"][number]): OutPoint {
  return Object.freeze({
    txHash: parseHash32(input.previousOutput.txHash),
    index: parseOutputIndex(input.previousOutput.index),
  });
}

function outputCapacity(transaction: UnsignedDeadlineTransaction): bigint {
  return transaction.outputs.reduce((total, output) => total + BigInt(output.capacity), 0n);
}

function toRpcScript(script: ScriptIdentity) {
  return { code_hash: script.codeHash, hash_type: script.hashType, args: script.args };
}

export function toRpcTransaction(transaction: UnsignedDeadlineTransaction) {
  return {
    version: transaction.version,
    cell_deps: transaction.cellDeps.map((dep) => ({
      out_point: { tx_hash: dep.outPoint.txHash, index: dep.outPoint.index },
      dep_type: dep.depType === "depGroup" ? "dep_group" : dep.depType,
    })),
    header_deps: transaction.headerDeps,
    inputs: transaction.inputs.map((input) => ({
      since: input.since,
      previous_output: {
        tx_hash: input.previousOutput.txHash,
        index: input.previousOutput.index,
      },
    })),
    outputs: transaction.outputs.map((output) => ({
      capacity: output.capacity,
      lock: toRpcScript(output.lock),
      type: output.type === null ? null : toRpcScript(output.type),
    })),
    outputs_data: transaction.outputsData,
    witnesses: transaction.witnesses,
  };
}

export function signOperatorTransaction(
  transaction: UnsignedDeadlineTransaction,
  privateKey: string,
  lockGroupInputIndices: readonly number[],
): UnsignedDeadlineTransaction {
  const inputIndex = lockGroupInputIndices[0];
  if (inputIndex === undefined) throw new Error("operator lock group is empty");
  const transactionHash = rawTransactionToHash(
    transaction as unknown as Parameters<typeof rawTransactionToHash>[0],
  );
  const zeroedWitness = serializeWitnessArgs({
    lock: EMPTY_SECP_SIG,
    inputType: "",
    outputType: "",
  });
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(hexToBytes(transactionHash));
  const first = hexToBytes(zeroedWitness);
  hasher.update(littleEndian(first.length, 8));
  hasher.update(first);
  const witnesses = [...transaction.witnesses];
  while (witnesses.length < transaction.inputs.length) witnesses.push("0x");
  for (const groupIndex of lockGroupInputIndices.slice(1)) {
    const bytes = hexToBytes(witnesses[groupIndex] ?? "0x");
    hasher.update(littleEndian(bytes.length, 8));
    hasher.update(bytes);
  }
  for (const witness of witnesses.slice(transaction.inputs.length)) {
    const bytes = hexToBytes(witness);
    hasher.update(littleEndian(bytes.length, 8));
    hasher.update(bytes);
  }
  witnesses[inputIndex] = serializeWitnessArgs({
    lock: new ECPair(privateKey).signRecoverable(hasher.digest("binary") as Uint8Array),
    inputType: "",
    outputType: "",
  }) as Hex;
  return Object.freeze({ ...transaction, witnesses: Object.freeze(witnesses) });
}

export function operatorLockArgs(privateKey: string): Hex {
  return `0x${blake160(new ECPair(privateKey).publicKey, "hex")}`;
}

export async function dryRunFallbackClaim(
  bundle: OperatorExecutionBundle,
  loadedManifest: LoadedOperatorManifest,
  config: OperatorConfiguration,
  rpc: JsonRpcClient,
) {
  if (!config.privateKey) throw new Error("OPERATOR_PRIVATE_KEY is required for a chain dry-run");
  if (bundle.manifestSha256 !== loadedManifest.sha256) {
    throw new Error("execution bundle targets a different deployment manifest");
  }
  const transaction = bundle.transaction;
  const fields = witnessArgs(transaction.witnesses[0] as Hex);
  const witness = DaoHarvestWitnessV2.unpack(fields.inputType);
  const envelope = DaoHarvestEnvelopeV2.unpack(fields.outputType);
  if (Number(witness.operation) !== DAO_HARVEST_V2_OPERATIONS.FALLBACK_CLAIM) {
    throw new Error("transaction is not a fallback claim");
  }
  const payloadBytes = Uint8Array.from(envelope.payload);
  const progressBytes = Uint8Array.from(envelope.progress);
  const creditBytes = Uint8Array.from(envelope.prepare_credit);
  const payload = DaoHarvestPayloadV2.unpack(payloadBytes);
  const progress = DaoHarvestProgressV2.unpack(progressBytes);
  const credit = DaoHarvestPrepareCreditV2.unpack(creditBytes);
  if (envelope.operator_proof.length !== 0 || envelope.successor_payload.length !== 0) {
    throw new Error("fallback claim contains an unexpected operator proof or successor payload");
  }
  if (
    Number(progress.version) !== 2 ||
    Number(progress.state) !== 1 ||
    progress.cycle_index.toString() !== credit.cycle_index.toString()
  ) {
    throw new Error("fallback claim progress and prepare credit are inconsistent");
  }
  const policyHash = parseHash32(
    scriptToHash({
      codeHash: loadedManifest.manifest.contracts.policy.codeHash,
      hashType: loadedManifest.manifest.contracts.policy.hashType,
      args: loadedManifest.manifest.contracts.jobLock.codeHash as Hex,
    }),
  );
  const actualPayloadHash = hash32FromBytes(
    deriveDaoHarvestV2PayloadHash(hexToBytes(policyHash), payloadBytes),
  );
  if (
    actualPayloadHash !== hash32FromBytes(Uint8Array.from(witness.payload_hash)) ||
    hash32FromBytes(deriveDaoHarvestV2ProgressHash(progressBytes)) !==
      hash32FromBytes(Uint8Array.from(witness.progress_hash)) ||
    hash32FromBytes(deriveDaoHarvestV2PrepareCreditHash(creditBytes)) !==
      hash32FromBytes(Uint8Array.from(witness.prepare_credit_hash))
  ) {
    throw new Error("fallback claim witness commitments are invalid");
  }
  const indices = {
    job: Number(witness.job_input_index),
    vault: Number(witness.vault_input_index),
    compensation: Number(witness.compensation_input_index),
    identity: Number(witness.identity_input_index),
    prepareInput: Number(witness.prepare_accumulator_input_index),
    claimInput: Number(witness.claim_accumulator_input_index),
    prepareOutput: Number(witness.prepare_accumulator_output_index),
    claimOutput: Number(witness.claim_accumulator_output_index),
    jobOutput: Number(witness.job_output_index),
  };
  if (Object.values(indices).some((index) => index === DAO_HARVEST_V2_ABSENT_INDEX)) {
    throw new Error("fallback claim is missing a required state index");
  }
  const resolved = await resolveInputs(transaction, rpc);
  const jobInput = resolved[indices.job];
  const identityInput = resolved[indices.identity];
  const prepareInput = resolved[indices.prepareInput];
  const claimInput = resolved[indices.claimInput];
  const prepareOutput = transaction.outputs[indices.prepareOutput];
  const claimOutput = transaction.outputs[indices.claimOutput];
  if (
    !jobInput ||
    !identityInput ||
    !prepareInput ||
    !claimInput ||
    !prepareOutput ||
    !claimOutput
  ) {
    throw new Error("fallback claim state indices are out of bounds");
  }
  const job = JobDataV1.unpack(hexToBytes(jobInput.data));
  const jobId = hash32FromBytes(Uint8Array.from(job.job_id));
  if (jobId !== bundle.jobId || hash32FromBytes(Uint8Array.from(credit.job_id)) !== jobId) {
    throw new Error("fallback claim Job identity does not match the bundle");
  }
  const operatorLockHash = parseHash32(scriptToHash(identityInput.lock));
  const operatorInputIndices = resolved.flatMap((input, index) =>
    parseHash32(scriptToHash(input.lock)) === operatorLockHash ? [index] : [],
  );
  if (operatorInputIndices[0] !== indices.identity) {
    throw new Error("identity input must be the first input in the operator lock group");
  }
  if (parseHash32(scriptToHash(claimInput.lock)) !== operatorLockHash) {
    throw new Error("claim accumulator is not controlled by the fallback operator");
  }
  if (parseHash32(scriptToHash(claimOutput.lock)) !== operatorLockHash) {
    throw new Error("claim payment output is redirected away from the fallback operator");
  }
  const preparerLockHash = hash32FromBytes(Uint8Array.from(credit.preparer_lock_hash));
  if (
    parseHash32(scriptToHash(prepareInput.lock)) !== preparerLockHash ||
    parseHash32(scriptToHash(prepareOutput.lock)) !== preparerLockHash
  ) {
    throw new Error("prepare payment is redirected away from the credited operator");
  }
  const preparePaymentCap = parseShannons(payload.prepare_service_fee.toString());
  const claimPaymentCap = parseShannons(payload.claim_service_fee.toString());
  const preparePayment = BigInt(prepareOutput.capacity) - prepareInput.capacity;
  const claimPayment = BigInt(claimOutput.capacity) - claimInput.capacity;
  if (
    preparePayment < 0n ||
    claimPayment < 0n ||
    preparePayment > preparePaymentCap ||
    claimPayment > claimPaymentCap
  ) {
    throw new Error("operator accumulator payments exceed the committed charge caps");
  }
  const vaultInput = resolved[indices.vault];
  if (!vaultInput || transaction.headerDeps.length !== 2) {
    throw new Error("fallback claim DAO input or header dependencies are invalid");
  }
  const [depositHeaderValue, prepareHeaderValue] = await Promise.all(
    transaction.headerDeps.map((hash) => rpc.call("get_header", [hash])),
  );
  const depositHeader = record(depositHeaderValue, "deposit header");
  const prepareHeader = record(prepareHeaderValue, "prepare header");
  const maximumWithdraw = calculateDaoMaximumWithdraw({
    principal: payload.principal_capacity.toString(),
    occupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
    depositAccumulatedRate: clientDaoAccumulatedRate(depositHeader["dao"]),
    withdrawingAccumulatedRate: clientDaoAccumulatedRate(prepareHeader["dao"]),
  });
  const totalInput =
    resolved.reduce((total, input) => total + input.capacity, 0n) -
    vaultInput.capacity +
    maximumWithdraw;
  const networkFee = totalInput - outputCapacity(transaction);
  if (networkFee < 0n) throw new Error("fallback claim creates capacity");
  const expectedOwnerLock: ScriptIdentity = Object.freeze({
    codeHash: loadedManifest.manifest.secp256k1Blake160.codeHash,
    hashType: "type" as const,
    args: operatorLockArgs(config.privateKey),
  });
  const expectedOwnerLockHash = parseHash32(scriptToHash(expectedOwnerLock));
  const signingInputIndices = resolved.flatMap((input, index) =>
    parseHash32(scriptToHash(input.lock)) === expectedOwnerLockHash ? [index] : [],
  );
  if (signingInputIndices.length === 0) {
    throw new Error("operator private key does not control a transaction funding input");
  }
  const signed = signOperatorTransaction(transaction, config.privateKey, signingInputIndices);
  const dryRun = record(
    await rpc.call("dry_run_transaction", [toRpcTransaction(signed)]),
    "dry-run result",
  );
  const cycles = BigInt(string(dryRun["cycles"], "dry-run cycles"));
  const tip = record(await rpc.call("get_tip_header"), "tip header");
  const takeover = addEpochFractions(
    decodeAbsoluteEpochSince(job.not_before.toString()),
    decodeRelativeEpochSince(payload.takeover_delay_epochs.toString()),
  );
  if (compareEpochFractions(parseEpoch(string(tip["epoch"], "tip epoch")), takeover) < 0) {
    throw new Error("fallback claim takeover time has not been reached");
  }
  if (claimPayment < networkFee + config.minimumProfitMargin) {
    throw new Error("fallback claim does not cover the bounded fee and minimum margin");
  }
  const consumedInputs = transaction.inputs.map(outPoint);
  if (
    new Set(consumedInputs.map((value) => `${value.txHash}/${value.index}`)).size !==
    consumedInputs.length
  ) {
    throw new Error("fallback claim contains duplicate inputs");
  }
  const boundary = assertHarvestV2TransactionWithinLimits({
    operation: "claim",
    transaction,
    dryRunCycles: cycles,
    feeRatePerKilobyte: config.feeRatePerKilobyte,
    networkFee,
    jobInputCount: 1,
    jobOutputCount: indices.jobOutput === DAO_HARVEST_V2_ABSENT_INDEX ? 0 : 1,
  });
  return Object.freeze({
    status: "ready" as const,
    jobId,
    operation: "fallback_claim" as const,
    transactionHash: parseHash32(
      rawTransactionToHash(transaction as unknown as Parameters<typeof rawTransactionToHash>[0]),
    ),
    operatorLockHash,
    networkFee: networkFee.toString(),
    preparePayment: preparePayment.toString(),
    claimPayment: claimPayment.toString(),
    expectedMargin: (claimPayment - networkFee).toString(),
    dryRunCycles: cycles.toString(),
    serializedBytes: boundary.serializedBytes.toString(),
    identityInputIndex: indices.identity,
    operatorInputIndices: Object.freeze(operatorInputIndices),
    signingInputIndices: Object.freeze(signingInputIndices),
  });
}

export async function submitFallbackClaim(
  bundle: OperatorExecutionBundle,
  loadedManifest: LoadedOperatorManifest,
  config: OperatorConfiguration,
  rpc: JsonRpcClient,
) {
  if (!config.privateKey) throw new Error("OPERATOR_PRIVATE_KEY is required for submission");
  const evidence = await dryRunFallbackClaim(bundle, loadedManifest, config, rpc);
  const signed = signOperatorTransaction(
    bundle.transaction,
    config.privateKey,
    evidence.signingInputIndices,
  );
  const returned = parseHash32(
    await rpc.call<string>("send_transaction", [toRpcTransaction(signed), "passthrough"]),
  );
  if (returned !== evidence.transactionHash) {
    throw new Error("CKB node returned a different transaction hash");
  }
  return Object.freeze({ ...evidence, status: "submitted" as const, transactionHash: returned });
}

export async function confirmTransaction(
  transactionHash: Hash32,
  depth: bigint,
  rpc: JsonRpcClient,
) {
  const result = record(await rpc.call("get_transaction", [transactionHash]), "transaction");
  const status = record(result["tx_status"], "transaction status");
  if (status["status"] !== "committed") {
    return Object.freeze({ status: string(status["status"], "transaction status") });
  }
  const blockHash = parseHash32(string(status["block_hash"], "transaction block hash"));
  const [headerValue, tipValue] = await Promise.all([
    rpc.call("get_header", [blockHash]),
    rpc.call("get_tip_header"),
  ]);
  const header = record(headerValue, "transaction header");
  const tip = record(tipValue, "tip header");
  const confirmations =
    BigInt(string(tip["number"], "tip number")) -
    BigInt(string(header["number"], "transaction block number")) +
    1n;
  return Object.freeze({
    status: confirmations >= depth ? "confirmed" : "confirming",
    blockHash,
    confirmations: confirmations.toString(),
    requiredConfirmations: depth.toString(),
  });
}
