import { readFile, writeFile } from "node:fs/promises";

import { WitnessArgs } from "@ckb-ccc/shell";
import { hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  deploymentRegistry,
  inspectJobData,
  parseBlockNumber,
  parseHash32,
  parseOutputIndex,
  parseShannons,
  type OutPoint,
  type RegisteredDeployment,
  type ScriptIdentity,
} from "@ckb-automata/core";
import {
  DEADLINE_EXECUTOR_ADAPTER,
  ExecutorAdapterRegistry,
  RECURRING_EXECUTOR_ADAPTER,
  runExecutorAdapter,
  type ExecutorCellSnapshot,
  type ExecutorSnapshot,
} from "@ckb-automata/executor";

import type { LoadedAutomationManifest } from "./automation-manifest.ts";
import type { OperatorConfiguration } from "./config.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { record, string } from "./rpc.ts";
import {
  operatorLockArgs,
  signOperatorTransaction,
  type OperatorExecutionBundle,
} from "./transaction.ts";

type Hex = `0x${string}`;

function rpcScript(value: unknown, name: string): ScriptIdentity {
  const item = record(value, name);
  const hashType = string(item["hash_type"], `${name}.hash_type`);
  if (hashType !== "data" && hashType !== "data1" && hashType !== "type") {
    throw new TypeError(`${name}.hash_type is invalid`);
  }
  return Object.freeze({
    codeHash: parseHash32(string(item["code_hash"], `${name}.code_hash`)),
    hashType,
    args: string(item["args"], `${name}.args`) as Hex,
  });
}

function rpcOutPoint(value: unknown, name: string): OutPoint {
  const item = record(value, name);
  return Object.freeze({
    txHash: parseHash32(string(item["tx_hash"], `${name}.tx_hash`)),
    index: parseOutputIndex(string(item["index"], `${name}.index`)),
  });
}

function outputCell(
  value: unknown,
  data: unknown,
  outPoint: OutPoint,
  blockHash: string,
  blockNumber: string,
  name: string,
): ExecutorCellSnapshot {
  const output = record(value, `${name}.output`);
  return Object.freeze({
    outPoint,
    output: Object.freeze({
      capacity: string(output["capacity"], `${name}.capacity`) as Hex,
      lock: rpcScript(output["lock"], `${name}.lock`),
      type: output["type"] === null ? null : rpcScript(output["type"], `${name}.type`),
    }),
    data: string(data, `${name}.data`) as Hex,
    blockHash: parseHash32(blockHash),
    blockNumber: parseBlockNumber(blockNumber),
  });
}

function witnessPayloads(value: unknown): readonly Hex[] {
  if (typeof value !== "string" || value === "0x") return Object.freeze([]);
  try {
    const witness = WitnessArgs.fromBytes(hexToBytes(value));
    return Object.freeze(
      [witness.inputType, witness.outputType].filter(
        (item): item is Hex => item !== undefined && item !== "0x",
      ),
    );
  } catch {
    return Object.freeze([]);
  }
}

async function loadConfiguredLocks(path?: string): Promise<readonly ScriptIdentity[]> {
  if (path === undefined) return Object.freeze([]);
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) throw new TypeError("operator lock resolutions must be an array");
  return Object.freeze(parsed.map((item, index) => rpcScript(item, `lock resolution ${index}`)));
}

async function transaction(rpc: JsonRpcClient, hash: string, name: string) {
  const response = record(await rpc.call("get_transaction", [hash]), name);
  const status = record(response["tx_status"], `${name}.status`);
  if (status["status"] !== "committed") throw new Error(`${name} is not committed`);
  return Object.freeze({
    body: record(response["transaction"], `${name}.body`),
    blockHash: string(status["block_hash"], `${name}.block_hash`),
  });
}

async function resolveInputLocks(
  rpc: JsonRpcClient,
  body: Record<string, unknown>,
): Promise<readonly ScriptIdentity[]> {
  const inputs = body["inputs"];
  if (!Array.isArray(inputs)) throw new TypeError("source transaction inputs are invalid");
  const locks: ScriptIdentity[] = [];
  for (const [index, value] of inputs.entries()) {
    const input = record(value, `source input ${index}`);
    const point = rpcOutPoint(input["previous_output"], `source input ${index}.previous_output`);
    if (/^0x0{64}$/.test(point.txHash)) continue;
    const source = await transaction(rpc, point.txHash, `source input ${index} transaction`);
    const outputs = source.body["outputs"];
    if (!Array.isArray(outputs)) throw new TypeError("referenced outputs are invalid");
    const output = outputs[Number(point.index)];
    if (output !== undefined)
      locks.push(rpcScript(record(output, "referenced output")["lock"], "referenced lock"));
  }
  return Object.freeze(locks);
}

async function findFeeCell(
  rpc: JsonRpcClient,
  indexer: JsonRpcClient,
  lock: ScriptIdentity,
  minimum: bigint,
): Promise<ExecutorCellSnapshot> {
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
    "operator fee cells",
  );
  if (!Array.isArray(result["objects"])) throw new TypeError("operator fee cells are invalid");
  for (const [index, value] of result["objects"].entries()) {
    const item = record(value, `operator fee cell ${index}`);
    const point = rpcOutPoint(item["out_point"], `operator fee cell ${index}.out_point`);
    const live = record(
      await rpc.call("get_live_cell", [
        { tx_hash: point.txHash, index: `0x${point.index.toString(16)}` },
        true,
      ]),
      `operator fee cell ${index}`,
    );
    if (live["status"] !== "live") continue;
    const source = await transaction(rpc, point.txHash, `operator fee cell ${index} source`);
    const header = record(await rpc.call("get_header", [source.blockHash]), "fee cell header");
    const cell = record(live["cell"], `operator fee cell ${index}.cell`);
    const data = record(cell["data"], `operator fee cell ${index}.data`);
    const snapshot = outputCell(
      record(cell["output"], `operator fee cell ${index}.output`),
      data["content"],
      point,
      source.blockHash,
      string(header["number"], "fee cell block number"),
      `operator fee cell ${index}`,
    );
    if (
      snapshot.output.type === null &&
      snapshot.data === "0x" &&
      parseShannons(snapshot.output.capacity) >= minimum
    ) {
      return snapshot;
    }
  }
  throw new Error("operator fee cell is unavailable");
}

async function loadSnapshot(
  jobOutPoint: OutPoint,
  loaded: LoadedAutomationManifest,
  config: OperatorConfiguration,
  rpc: JsonRpcClient,
  indexer: JsonRpcClient,
): Promise<{ readonly snapshot: ExecutorSnapshot; readonly deployment: RegisteredDeployment }> {
  if (!config.privateKey) throw new Error("OPERATOR_PRIVATE_KEY is required to build a payment");
  const registered = await deploymentRegistry.load(loaded.manifest.genesisHash);
  if (registered.status !== "ok") throw new Error("base CKAutomata deployment is unavailable");
  const source = await transaction(rpc, jobOutPoint.txHash, "job source transaction");
  const header = record(await rpc.call("get_header", [source.blockHash]), "job source header");
  const live = record(
    await rpc.call("get_live_cell", [
      { tx_hash: jobOutPoint.txHash, index: `0x${jobOutPoint.index.toString(16)}` },
      true,
    ]),
    "job cell",
  );
  if (live["status"] !== "live") throw new Error("job cell is no longer live");
  const liveCell = record(live["cell"], "job live cell");
  const liveData = record(liveCell["data"], "job live data");
  const job = outputCell(
    liveCell["output"],
    liveData["content"],
    jobOutPoint,
    source.blockHash,
    string(header["number"], "job block number"),
    "job cell",
  );
  const inspected = inspectJobData(job.data, {
    manifest: registered.deployment.manifest,
    expectedGenesisHash: registered.deployment.genesisHash,
    ...(job.output.type === null ? {} : { policyScript: job.output.type }),
    operatorDeployment: loaded.deployment,
  });
  if (
    inspected.status !== "ok" ||
    (inspected.policy.kind !== "deadline" && inspected.policy.kind !== "recurring")
  ) {
    throw new Error("job is not a supported scheduled or recurring payment");
  }
  const operatorLock: ScriptIdentity = Object.freeze({
    codeHash: registered.deployment.manifest.secp256k1Blake160.codeHash,
    hashType: registered.deployment.manifest.secp256k1Blake160.hashType,
    args: operatorLockArgs(config.privateKey),
  });
  const outputs = source.body["outputs"];
  const outputsData = source.body["outputs_data"];
  const witnesses = source.body["witnesses"];
  if (!Array.isArray(outputs) || !Array.isArray(outputsData) || !Array.isArray(witnesses)) {
    throw new TypeError("job source transaction arrays are invalid");
  }
  const sourceLocks = outputs.map((output, index) =>
    rpcScript(record(output, `source output ${index}`)["lock"], `source output ${index}.lock`),
  );
  const resolvedLocks = [
    operatorLock,
    ...sourceLocks,
    ...(await resolveInputLocks(rpc, source.body)),
    ...(await loadConfiguredLocks(config.lockResolutionsPath)),
  ];
  const uniqueLocks = Object.freeze([
    ...new Map(resolvedLocks.map((lock) => [scriptToHash(lock), lock])).values(),
  ]);
  const applicationCells: ExecutorCellSnapshot[] = [];
  if (inspected.policy.kind === "deadline") {
    for (const [index, outputValue] of outputs.entries()) {
      const output = record(outputValue, `source output ${index}`);
      if (output["type"] === null) continue;
      const type = rpcScript(output["type"], `source output ${index}.type`);
      if (parseHash32(scriptToHash(type)) !== inspected.policy.campaignTypeHash) continue;
      const point = Object.freeze({
        txHash: jobOutPoint.txHash,
        index: parseOutputIndex(index.toString()),
      });
      const campaignLive = record(
        await rpc.call("get_live_cell", [
          { tx_hash: point.txHash, index: `0x${point.index.toString(16)}` },
          true,
        ]),
        "campaign cell",
      );
      if (campaignLive["status"] !== "live") throw new Error("campaign cell is no longer live");
      applicationCells.push(
        outputCell(
          output,
          outputsData[index],
          point,
          source.blockHash,
          string(header["number"], "job block number"),
          "campaign cell",
        ),
      );
    }
  }
  const feeCell = await findFeeCell(
    rpc,
    indexer,
    operatorLock,
    config.transactionFee + 6_100_000_000n,
  );
  const tipValue = record(await rpc.call("get_tip_header"), "tip header");
  return Object.freeze({
    deployment: registered.deployment,
    snapshot: Object.freeze({
      deployment: registered.deployment,
      operatorDeployment: loaded.deployment,
      tip: Object.freeze({
        hash: parseHash32(string(tipValue["hash"], "tip hash")),
        number: parseBlockNumber(string(tipValue["number"], "tip number")),
        epoch: string(tipValue["epoch"], "tip epoch") as Hex,
        timestamp: string(tipValue["timestamp"], "tip timestamp") as Hex,
      }),
      job,
      applicationCells: Object.freeze(applicationCells),
      feeCells: Object.freeze([feeCell]),
      headers: Object.freeze([]),
      resolvedLocks: uniqueLocks,
      payloads: Object.freeze(witnesses.flatMap(witnessPayloads)),
      claims: Object.freeze({}),
    }),
  });
}

export async function buildPaymentExecutionBundle(
  jobOutPoint: OutPoint,
  loaded: LoadedAutomationManifest,
  config: OperatorConfiguration,
  rpc: JsonRpcClient,
  indexer: JsonRpcClient,
): Promise<OperatorExecutionBundle> {
  if (!config.privateKey) throw new Error("OPERATOR_PRIVATE_KEY is required to build a payment");
  const { snapshot, deployment } = await loadSnapshot(jobOutPoint, loaded, config, rpc, indexer);
  const inspection = inspectJobData(snapshot.job.data, {
    manifest: deployment.manifest,
    expectedGenesisHash: deployment.genesisHash,
    policyScript: snapshot.job.output.type!,
    operatorDeployment: loaded.deployment,
  });
  if (inspection.status !== "ok") throw new Error("job inspection failed");
  const rewardLock: ScriptIdentity = Object.freeze({
    codeHash: deployment.manifest.secp256k1Blake160.codeHash,
    hashType: deployment.manifest.secp256k1Blake160.hashType,
    args: operatorLockArgs(config.privateKey),
  });
  const adapter =
    inspection.policy.kind === "deadline"
      ? DEADLINE_EXECUTOR_ADAPTER
      : inspection.policy.kind === "recurring"
        ? RECURRING_EXECUTOR_ADAPTER
        : undefined;
  if (adapter === undefined) throw new Error("job is not a supported payment policy");
  const result = await runExecutorAdapter(
    new ExecutorAdapterRegistry([adapter]),
    snapshot,
    Object.freeze({ rewardLock, transactionFee: parseShannons(config.transactionFee) }),
  );
  if (result.status === "ineligible") {
    throw new Error("this operator is not yet allowed to process the payment");
  }
  if (result.status !== "built") throw new Error("payment transaction failed local verification");
  const operation =
    inspection.policy.kind === "deadline" ? "scheduled_payment" : "recurring_payment";
  return Object.freeze({
    schemaVersion: 1 as const,
    manifestSha256: loaded.sha256,
    operation,
    jobId: inspection.job.jobId,
    transaction: signOperatorTransaction(result.build.transaction, config.privateKey, [1]),
  });
}

export async function writePaymentExecutionBundle(path: string, bundle: OperatorExecutionBundle) {
  await writeFile(path, `${JSON.stringify(bundle, null, 2)}\n`, { flag: "wx" });
  return Object.freeze({ path, operation: bundle.operation, jobId: bundle.jobId });
}
