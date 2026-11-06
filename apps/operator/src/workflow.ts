import { writeFile } from "node:fs/promises";

import { clientDaoAccumulatedRate } from "@ckb-automata/ccc";
import {
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  addEpochFractions,
  addEpochs,
  buildDaoHarvestV2ClaimTransition,
  decodeAbsoluteEpochSince,
  decodeRelativeEpochSince,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  encodeAbsoluteEpochSince,
  hash32FromBytes,
  minimumPlainCellCapacity,
  parseEpoch,
  parseHash32,
  parseOutputIndex,
  parseShannons,
  selectDaoPrepareWindow,
  type DaoHarvestV2TransitionCell,
  type Hash32,
  type OutPoint,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";
import {
  DaoHarvestEnvelopeV2,
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
  JobDataV1,
} from "@ckb-automata/molecule";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import type { OperatorConfiguration } from "./config.ts";
import type { LoadedOperatorManifest, OperatorManifest } from "./manifest.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { record, string } from "./rpc.ts";
import {
  operatorLockArgs,
  signOperatorTransaction,
  toRpcTransaction,
  type OperatorExecutionBundle,
} from "./transaction.ts";

type Hex = `0x${string}`;

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

function rpcOutPoint(value: unknown, name: string): OutPoint {
  const parsed = record(value, name);
  return Object.freeze({
    txHash: parseHash32(string(parsed["tx_hash"], `${name}.tx_hash`)),
    index: parseOutputIndex(string(parsed["index"], `${name}.index`)),
  });
}

function cell(value: unknown, outPoint: OutPoint, name: string): DaoHarvestV2TransitionCell {
  const parsed = record(value, name);
  const output = record(parsed["output"], `${name}.output`);
  const data = record(parsed["data"], `${name}.data`);
  return Object.freeze({
    outPoint,
    capacity: parseShannons(string(output["capacity"], `${name}.capacity`)),
    lock: rpcScript(output["lock"], `${name}.lock`),
    type: output["type"] === null ? null : rpcScript(output["type"], `${name}.type`),
    data: string(data["content"], `${name}.data.content`) as Hex,
  });
}

async function liveCell(
  rpc: JsonRpcClient,
  outPoint: OutPoint,
  name: string,
): Promise<DaoHarvestV2TransitionCell> {
  const result = record(
    await rpc.call("get_live_cell", [
      { tx_hash: outPoint.txHash, index: `0x${BigInt(outPoint.index).toString(16)}` },
      true,
    ]),
    name,
  );
  if (result["status"] !== "live") throw new Error(`${name} is no longer live`);
  return cell(result["cell"], outPoint, `${name}.cell`);
}

function ownerLock(manifest: OperatorManifest, privateKey: string): ScriptIdentity {
  return Object.freeze({
    codeHash: manifest.secp256k1Blake160.codeHash,
    hashType: "type" as const,
    args: operatorLockArgs(privateKey),
  });
}

function policyScript(manifest: OperatorManifest): ScriptIdentity {
  return Object.freeze({
    codeHash: manifest.contracts.policy.codeHash,
    hashType: "data1" as const,
    args: manifest.contracts.jobLock.codeHash as Hex,
  });
}

function accumulatorLock(
  manifest: OperatorManifest,
  operatorOwnerLock: ScriptIdentity,
  policyScriptHash: Hash32,
): ScriptIdentity {
  return Object.freeze({
    codeHash: manifest.contracts.compensationLock.codeHash,
    hashType: "data1" as const,
    args: bytesToHex(
      Uint8Array.from([
        ...hexToBytes(parseHash32(scriptToHash(operatorOwnerLock))),
        ...hexToBytes(policyScriptHash),
      ]),
    ) as Hex,
  });
}

async function findPlainCell(
  indexer: JsonRpcClient,
  rpc: JsonRpcClient,
  lock: ScriptIdentity,
  minimumCapacity: bigint,
): Promise<DaoHarvestV2TransitionCell | undefined> {
  const result = record(
    await indexer.call("get_cells", [
      {
        script: { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args },
        script_type: "lock",
        script_search_mode: "exact",
        filter: { output_data_len_range: ["0x0", "0x1"] },
      },
      "asc",
      "0x64",
    ]),
    "operator cells",
  );
  if (!Array.isArray(result["objects"])) throw new TypeError("operator cells are invalid");
  for (const [index, item] of result["objects"].entries()) {
    const found = record(item, `operator cell ${index}`);
    const point = rpcOutPoint(found["out_point"], `operator cell ${index}.out_point`);
    try {
      const live = await liveCell(rpc, point, `operator cell ${index}`);
      if (live.type === null && live.data === "0x" && BigInt(live.capacity) >= minimumCapacity) {
        return live;
      }
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no longer live")) throw error;
    }
  }
  return undefined;
}

function sourceWitness(transaction: Record<string, unknown>) {
  const witnesses = transaction["witnesses"];
  if (!Array.isArray(witnesses) || typeof witnesses[0] !== "string") {
    throw new Error("source transaction has no protocol witness");
  }
  const raw = hexToBytes(witnesses[0]);
  if (raw.length < 16) throw new Error("source witness is not a Molecule WitnessArgs table");
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const total = view.getUint32(0, true);
  const offsets = [view.getUint32(4, true), view.getUint32(8, true), view.getUint32(12, true)];
  if (total !== raw.length || offsets[0] !== 16 || offsets[1]! < 16 || offsets[2]! < offsets[1]!) {
    throw new Error("source witness offsets are invalid");
  }
  const field = (start: number, end: number) => {
    if (start === end) return new Uint8Array();
    if (view.getUint32(start, true) !== end - start - 4) {
      throw new Error("source witness field is invalid");
    }
    return raw.slice(start + 4, end);
  };
  const inputType = field(offsets[1]!, offsets[2]!);
  const outputType = field(offsets[2]!, total);
  return Object.freeze({
    witness: DaoHarvestWitnessV2.unpack(inputType),
    envelope: DaoHarvestEnvelopeV2.unpack(outputType),
  });
}

function blockNumberFromDaoData(data: Hex): bigint {
  const bytes = hexToBytes(data);
  if (bytes.length !== 8 || bytes.every((value) => value === 0)) {
    throw new Error("withdrawing DAO vault data is invalid");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

function transitionDeployment(manifest: OperatorManifest) {
  return Object.freeze({
    secp256k1Blake160: manifest.secp256k1Blake160,
    nervosDao: manifest.nervosDao,
    contracts: Object.freeze({
      jobLock: manifest.contracts.jobLock,
      policy: manifest.contracts.policy,
      vaultLock: manifest.contracts.vaultLock,
      compensationLock: manifest.contracts.compensationLock,
    }),
  });
}

export async function provisionOperatorAccumulator(
  loaded: LoadedOperatorManifest,
  config: OperatorConfiguration,
  rpc: JsonRpcClient,
  indexer: JsonRpcClient,
) {
  if (!config.privateKey) throw new Error("OPERATOR_PRIVATE_KEY is required for setup");
  const owner = ownerLock(loaded.manifest, config.privateKey);
  const policyHash = parseHash32(scriptToHash(policyScript(loaded.manifest)));
  const lock = accumulatorLock(loaded.manifest, owner, policyHash);
  const existing = await findPlainCell(indexer, rpc, lock, 1n);
  if (existing) {
    return Object.freeze({ status: "ready" as const, outPoint: existing.outPoint, lock });
  }
  const accumulatorCapacity = minimumPlainCellCapacity(lock);
  const ownerMinimum = minimumPlainCellCapacity(owner);
  const funding = await findPlainCell(
    indexer,
    rpc,
    owner,
    accumulatorCapacity + ownerMinimum + config.transactionFee,
  );
  if (!funding) throw new Error("operator funding cell is unavailable");
  const change = BigInt(funding.capacity) - accumulatorCapacity - config.transactionFee;
  const unsigned: UnsignedDeadlineTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([loaded.manifest.secp256k1Blake160.cellDep]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([
      Object.freeze({
        since: "0x0" as const,
        previousOutput: Object.freeze({
          txHash: funding.outPoint.txHash,
          index: `0x${BigInt(funding.outPoint.index).toString(16)}` as Hex,
        }),
      }),
    ]),
    outputs: Object.freeze([
      Object.freeze({ capacity: `0x${accumulatorCapacity.toString(16)}` as Hex, lock, type: null }),
      Object.freeze({ capacity: `0x${change.toString(16)}` as Hex, lock: owner, type: null }),
    ]),
    outputsData: Object.freeze(["0x" as const, "0x" as const]),
    witnesses: Object.freeze(["0x" as const]),
  });
  const signed = signOperatorTransaction(unsigned, config.privateKey, [0]);
  await rpc.call("dry_run_transaction", [toRpcTransaction(signed)]);
  const transactionHash = parseHash32(
    await rpc.call<string>("send_transaction", [toRpcTransaction(signed), "passthrough"]),
  );
  return Object.freeze({
    status: "submitted" as const,
    transactionHash,
    accumulatorOutPoint: Object.freeze({ txHash: transactionHash, index: 0 }),
    capacity: accumulatorCapacity.toString(),
    lock,
  });
}

export async function buildFallbackClaimBundle(
  jobOutPoint: OutPoint,
  loaded: LoadedOperatorManifest,
  config: OperatorConfiguration,
  rpc: JsonRpcClient,
  indexer: JsonRpcClient,
): Promise<OperatorExecutionBundle> {
  if (!config.privateKey) throw new Error("OPERATOR_PRIVATE_KEY is required to build a claim");
  const jobCell = await liveCell(rpc, jobOutPoint, "job cell");
  if (
    jobCell.lock.codeHash !== loaded.manifest.contracts.jobLock.codeHash ||
    jobCell.lock.args !== "0x"
  ) {
    throw new Error("job outpoint does not use the active V2 Job Lock");
  }
  const sourceResult = record(
    await rpc.call("get_transaction", [jobOutPoint.txHash]),
    "source transaction",
  );
  const status = record(sourceResult["tx_status"], "source transaction status");
  if (status["status"] !== "committed") throw new Error("job source transaction is not committed");
  const source = record(sourceResult["transaction"], "source transaction body");
  const decoded = sourceWitness(source);
  if (BigInt(jobOutPoint.index) !== BigInt(decoded.witness.job_output_index.toString())) {
    throw new Error("job outpoint does not match the protocol witness");
  }
  const inputProgress = Uint8Array.from(decoded.envelope.progress);
  const inputPayload = Uint8Array.from(decoded.envelope.payload);
  const prepareCredit = Uint8Array.from(decoded.envelope.prepare_credit);
  const operation = Number(decoded.witness.operation);
  if (operation !== 1 && operation !== 2) {
    throw new Error("fallback claim requires a live job produced by a DAO prepare transaction");
  }
  if (prepareCredit.length === 0) throw new Error("prepared job has no prepare credit");
  const previousProgress = DaoHarvestProgressV2.unpack(inputProgress);
  const progress = DaoHarvestProgressV2.pack({
    version: 2,
    state: 1,
    cycle_index: previousProgress.cycle_index,
    prepare_credit_hash: [...deriveDaoHarvestV2PrepareCreditHash(prepareCredit)],
  });
  const payload = DaoHarvestPayloadV2.unpack(inputPayload);
  const credit = DaoHarvestPrepareCreditV2.unpack(prepareCredit);
  const job = JobDataV1.unpack(hexToBytes(jobCell.data));
  const jobId = hash32FromBytes(Uint8Array.from(job.job_id));
  const policy = policyScript(loaded.manifest);
  const policyHash = parseHash32(scriptToHash(policy));
  if (
    jobCell.type === null ||
    parseHash32(scriptToHash(jobCell.type)) !== policyHash ||
    hash32FromBytes(deriveDaoHarvestV2PayloadHash(hexToBytes(policyHash), inputPayload)) !==
      hash32FromBytes(Uint8Array.from(job.payload_hash)) ||
    hash32FromBytes(deriveDaoHarvestV2ProgressHash(progress)) !==
      hash32FromBytes(Uint8Array.from(job.trigger_params_hash)) ||
    hash32FromBytes(Uint8Array.from(credit.job_id)) !== jobId
  ) {
    throw new Error("live prepared state does not match its committed V2 data");
  }
  const outputPoint = (index: bigint | number) =>
    Object.freeze({ txHash: jobOutPoint.txHash, index: parseOutputIndex(index.toString()) });
  const vaultCell = await liveCell(
    rpc,
    outputPoint(decoded.witness.vault_output_index),
    "vault cell",
  );
  const compensationCell = await liveCell(
    rpc,
    outputPoint(decoded.witness.compensation_output_index),
    "compensation cell",
  );
  const prepareAccumulator = await liveCell(
    rpc,
    outputPoint(decoded.witness.prepare_accumulator_output_index),
    "prepare accumulator",
  );
  if (
    parseHash32(scriptToHash(prepareAccumulator.lock)) !==
    hash32FromBytes(Uint8Array.from(credit.preparer_lock_hash))
  ) {
    throw new Error("prepare accumulator does not match the credited operator");
  }
  const owner = ownerLock(loaded.manifest, config.privateKey);
  const claimLock = accumulatorLock(loaded.manifest, owner, policyHash);
  const claimAccumulator = await findPlainCell(indexer, rpc, claimLock, 1n);
  if (!claimAccumulator) {
    throw new Error(
      "operator accumulator is unavailable; run the setup command and confirm it first",
    );
  }
  const feeCell = await findPlainCell(
    indexer,
    rpc,
    owner,
    config.transactionFee + minimumPlainCellCapacity(owner),
  );
  if (!feeCell) throw new Error("operator fee cell is unavailable");
  const sourceBlockHash = parseHash32(string(status["block_hash"], "source block hash"));
  const sourceHeader = record(await rpc.call("get_header", [sourceBlockHash]), "source header");
  const depositNumber = blockNumberFromDaoData(vaultCell.data);
  const [depositBlockValue, prepareBlockValue, tipValue] = await Promise.all([
    rpc.call("get_block_by_number", [`0x${depositNumber.toString(16)}`]),
    rpc.call("get_block_by_number", [string(sourceHeader["number"], "source block number")]),
    rpc.call("get_tip_header"),
  ]);
  const depositBlock = record(depositBlockValue, "deposit block");
  const prepareBlock = record(prepareBlockValue, "prepare block");
  const depositHeader = record(depositBlock["header"], "deposit header");
  const prepareHeader = record(prepareBlock["header"], "prepare header");
  const tip = record(tipValue, "tip header");
  const buffer = decodeRelativeEpochSince(payload.prepare_buffer_epochs.toString());
  const margin = decodeRelativeEpochSince(payload.confirmation_margin_epochs.toString());
  const anticipatedDeposit = addEpochs(parseEpoch(string(tip["epoch"], "tip epoch")), 1n);
  const next = selectDaoPrepareWindow({
    deposit: anticipatedDeposit,
    tip: anticipatedDeposit,
    bufferEpochs: buffer.number,
    confirmationMarginEpochs: margin.number,
  });
  const executionSince = encodeAbsoluteEpochSince(
    addEpochFractions(
      decodeAbsoluteEpochSince(job.not_before.toString()),
      decodeRelativeEpochSince(payload.takeover_delay_epochs.toString()),
    ),
  );
  const built = buildDaoHarvestV2ClaimTransition({
    deployment: transitionDeployment(loaded.manifest),
    policyScriptHash: policyHash,
    payload: inputPayload,
    progress,
    prepareCredit,
    job: jobCell,
    vault: vaultCell,
    compensation: compensationCell,
    prepareAccumulator,
    accumulator: claimAccumulator,
    ...(scriptToHash(prepareAccumulator.lock) === scriptToHash(claimAccumulator.lock)
      ? {}
      : { claimAccumulator }),
    feeCell,
    operatorOwnerLock: owner,
    transactionFee: config.transactionFee,
    operation: "fallback_claim",
    depositHeaderHash: parseHash32(string(depositHeader["hash"], "deposit header hash")),
    prepareHeaderHash: parseHash32(string(prepareHeader["hash"], "prepare header hash")),
    depositAccumulatedRate: clientDaoAccumulatedRate(depositHeader["dao"]),
    prepareAccumulatedRate: clientDaoAccumulatedRate(prepareHeader["dao"]),
    vaultOccupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
    executionSince,
    ...(BigInt(job.remaining_runs.toString()) > 1n
      ? { nextPrepareSince: encodeAbsoluteEpochSince(next.startsAt) }
      : {}),
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    manifestSha256: loaded.sha256,
    operation: "fallback_claim" as const,
    jobId,
    transaction: built.transaction,
  });
}

export async function writeExecutionBundle(path: string, bundle: OperatorExecutionBundle) {
  await writeFile(
    path,
    `${JSON.stringify(bundle, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`,
    { flag: "wx" },
  );
  return Object.freeze({ status: "written" as const, path, jobId: bundle.jobId });
}
