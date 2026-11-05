import { hexToBytes, rawTransactionToHash } from "@nervosnetwork/ckb-sdk-utils";

import { JobDataV1 } from "@ckb-automata/molecule";
import {
  parseHash32,
  parseShannons,
  type Hash32,
  type ScriptIdentity,
  type Shannons,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import { operatorLockArgs, signOperatorFeeInput } from "./signing.ts";

export interface SimulationQueuePayload {
  readonly attemptId: string;
  readonly intentHash: string;
}

export interface SimulationAttempt {
  readonly attemptId: string;
  readonly intentHash: Hash32;
  readonly transaction: Readonly<Record<string, unknown>>;
  readonly snapshot: Readonly<Record<string, unknown>>;
}

export interface SimulationRecord {
  readonly cycles: string;
  readonly fee: string;
  readonly reward: string;
  readonly margin: string;
  readonly intentHash: Hash32;
  readonly feeInputIndex: number;
}

export interface SimulationStore {
  load(attemptId: string, intentHash: Hash32): Promise<SimulationAttempt | undefined>;
  approve(attempt: SimulationAttempt, record: SimulationRecord): Promise<boolean>;
  reject(attempt: SimulationAttempt, errorCode: string): Promise<void>;
}

export interface SimulationChain {
  dryRun(transaction: UnsignedDeadlineTransaction): Promise<bigint>;
}

export type SimulationResult =
  | ({ readonly status: "approved"; readonly attemptId: string } & SimulationRecord)
  | { readonly status: "rejected"; readonly attemptId: string; readonly errorCode: string }
  | { readonly status: "stale" };

type JsonRecord = Record<string, unknown>;

class SimulationGateError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "SimulationGateError";
    this.code = code;
  }
}

function record(value: unknown, name: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SimulationGateError("EXECUTOR_BUILD_RECORD_INVALID", `${name} is invalid`);
  }
  return value as JsonRecord;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new SimulationGateError("EXECUTOR_BUILD_RECORD_INVALID", `${name} is invalid`);
  }
  return value;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new SimulationGateError("EXECUTOR_BUILD_RECORD_INVALID", `${name} is invalid`);
  }
  return value;
}

function hex(value: unknown, name: string): `0x${string}` {
  const parsed = text(value, name);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(parsed)) {
    throw new SimulationGateError("EXECUTOR_BUILD_RECORD_INVALID", `${name} is invalid`);
  }
  return parsed as `0x${string}`;
}

function quantity(value: unknown, name: string): `0x${string}` {
  const parsed = text(value, name);
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(parsed)) {
    throw new SimulationGateError("EXECUTOR_BUILD_RECORD_INVALID", `${name} is invalid`);
  }
  return parsed as `0x${string}`;
}

function script(value: unknown, name: string): ScriptIdentity {
  const parsed = record(value, name);
  const hashType = text(parsed["hashType"], `${name}.hashType`);
  if (!(["data", "type", "data1", "data2"] as const).includes(hashType as never)) {
    throw new SimulationGateError("EXECUTOR_BUILD_RECORD_INVALID", `${name}.hashType is invalid`);
  }
  return Object.freeze({
    codeHash: parseHash32(text(parsed["codeHash"], `${name}.codeHash`)),
    hashType: hashType as ScriptIdentity["hashType"],
    args: hex(parsed["args"], `${name}.args`),
  });
}

export function parseStoredTransaction(
  value: Readonly<Record<string, unknown>>,
): UnsignedDeadlineTransaction {
  const inputs = array(value["inputs"], "transaction.inputs").map((item, index) => {
    const input = record(item, `transaction.inputs[${index}]`);
    const previous = record(input["previousOutput"], `transaction.inputs[${index}].previousOutput`);
    return Object.freeze({
      since: quantity(input["since"], `transaction.inputs[${index}].since`),
      previousOutput: Object.freeze({
        txHash: parseHash32(text(previous["txHash"], `transaction.inputs[${index}].txHash`)),
        index: quantity(previous["index"], `transaction.inputs[${index}].index`),
      }),
    });
  });
  const outputs = array(value["outputs"], "transaction.outputs").map((item, index) => {
    const output = record(item, `transaction.outputs[${index}]`);
    return Object.freeze({
      capacity: quantity(output["capacity"], `transaction.outputs[${index}].capacity`),
      lock: script(output["lock"], `transaction.outputs[${index}].lock`),
      type:
        output["type"] === null
          ? null
          : script(output["type"], `transaction.outputs[${index}].type`),
    });
  });
  const cellDeps = array(value["cellDeps"], "transaction.cellDeps").map((item, index) => {
    const dependency = record(item, `transaction.cellDeps[${index}]`);
    const outPoint = record(dependency["outPoint"], `transaction.cellDeps[${index}].outPoint`);
    const depType = text(dependency["depType"], `transaction.cellDeps[${index}].depType`);
    if (depType !== "code" && depType !== "depGroup") {
      throw new SimulationGateError(
        "EXECUTOR_BUILD_RECORD_INVALID",
        `transaction.cellDeps[${index}].depType is invalid`,
      );
    }
    return Object.freeze({
      outPoint: Object.freeze({
        txHash: parseHash32(text(outPoint["txHash"], `transaction.cellDeps[${index}].txHash`)),
        index: quantity(outPoint["index"], `transaction.cellDeps[${index}].index`),
      }),
      depType,
    });
  });
  const outputsData = array(value["outputsData"], "transaction.outputsData").map((item, index) =>
    hex(item, `transaction.outputsData[${index}]`),
  );
  if (outputsData.length !== outputs.length) {
    throw new SimulationGateError(
      "EXECUTOR_BUILD_RECORD_INVALID",
      "transaction output data count is invalid",
    );
  }
  const version = quantity(value["version"], "transaction.version");
  if (version !== "0x0") {
    throw new SimulationGateError(
      "EXECUTOR_BUILD_RECORD_INVALID",
      "transaction version is invalid",
    );
  }
  return Object.freeze({
    version,
    cellDeps: Object.freeze(cellDeps),
    headerDeps: Object.freeze(
      array(value["headerDeps"], "transaction.headerDeps").map((item, index) =>
        parseHash32(text(item, `transaction.headerDeps[${index}]`)),
      ),
    ),
    inputs: Object.freeze(inputs),
    outputs: Object.freeze(outputs),
    outputsData: Object.freeze(outputsData),
    witnesses: Object.freeze(
      array(value["witnesses"], "transaction.witnesses").map((item, index) =>
        hex(item, `transaction.witnesses[${index}]`),
      ),
    ),
  });
}

function outPointKey(value: unknown, name: string): string {
  const parsed = record(value, name);
  return `${parseHash32(text(parsed["txHash"], `${name}.txHash`))}/${BigInt(
    text(parsed["index"], `${name}.index`),
  )}`;
}

function accounting(
  built: UnsignedDeadlineTransaction,
  snapshot: Readonly<Record<string, unknown>>,
  rewardLock: ScriptIdentity,
): { readonly fee: Shannons; readonly reward: Shannons; readonly feeInputIndex: number } {
  const feeCells = array(snapshot["feeCells"], "snapshot.feeCells").map((item, index) =>
    record(item, `snapshot.feeCells[${index}]`),
  );
  const cells = [
    record(snapshot["job"], "snapshot.job"),
    ...array(snapshot["applicationCells"], "snapshot.applicationCells").map((item, index) =>
      record(item, `snapshot.applicationCells[${index}]`),
    ),
    ...feeCells,
  ];
  const capacities = new Map<string, Shannons>();
  for (const [index, cell] of cells.entries()) {
    const output = record(cell["output"], `snapshot.cells[${index}].output`);
    capacities.set(
      outPointKey(cell["outPoint"], `snapshot.cells[${index}].outPoint`),
      parseShannons(text(output["capacity"], `snapshot.cells[${index}].capacity`)),
    );
  }
  let inputTotal = 0n;
  const consumed = new Set<string>();
  for (const input of built.inputs) {
    const key = `${input.previousOutput.txHash}/${BigInt(input.previousOutput.index)}`;
    const capacity = capacities.get(key);
    if (capacity === undefined || consumed.has(key)) {
      throw new SimulationGateError(
        "EXECUTOR_BUILD_RECORD_INVALID",
        "transaction inputs are not uniquely resolved by the chain snapshot",
      );
    }
    consumed.add(key);
    inputTotal += capacity;
  }
  const outputTotal = built.outputs.reduce(
    (total, output) => total + parseShannons(output.capacity),
    0n,
  );
  if (inputTotal < outputTotal) {
    throw new SimulationGateError("EXECUTOR_FEE_MISMATCH", "transaction creates capacity");
  }
  const snapshotJob = record(snapshot["job"], "snapshot.job");
  const job = JobDataV1.unpack(hexToBytes(hex(snapshotJob["data"], "snapshot.job.data")));
  const reward = parseShannons(job.reward.toString());
  const rewardOutputs = built.outputs.flatMap((output, index) =>
    parseShannons(output.capacity) === reward &&
    JSON.stringify(output.lock) === JSON.stringify(rewardLock) &&
    output.type === null &&
    built.outputsData[index] === "0x"
      ? [output]
      : [],
  );
  if (rewardOutputs.length !== 1) {
    throw new SimulationGateError(
      "EXECUTOR_REWARD_INVALID",
      "transaction does not preserve the committed executor reward",
    );
  }
  const feeOutPoints = new Set(
    feeCells.flatMap((cell, index) => {
      const output = record(cell["output"], `snapshot.feeCells[${index}].output`);
      return JSON.stringify(script(output["lock"], `snapshot.feeCells[${index}].lock`)) ===
        JSON.stringify(rewardLock)
        ? [outPointKey(cell["outPoint"], `snapshot.feeCells[${index}].outPoint`)]
        : [];
    }),
  );
  const feeInputIndices = built.inputs.flatMap((input, index) =>
    feeOutPoints.has(`${input.previousOutput.txHash}/${BigInt(input.previousOutput.index)}`)
      ? [index]
      : [],
  );
  if (feeInputIndices.length !== 1) {
    throw new SimulationGateError(
      "EXECUTOR_BUILD_RECORD_INVALID",
      "transaction must consume exactly one verified executor fee input",
    );
  }
  return Object.freeze({
    fee: parseShannons(inputTotal - outputTotal),
    reward,
    feeInputIndex: feeInputIndices[0]!,
  });
}

function gateCode(error: unknown): string {
  return error instanceof SimulationGateError ? error.code : "EXECUTOR_SIMULATION_REJECTED";
}

export class SimulationGateService {
  readonly #store: SimulationStore;
  readonly #chain: SimulationChain;
  readonly #rewardLock: ScriptIdentity;
  readonly #privateKey: string;
  readonly #transactionFee: Shannons;
  readonly #maxCycles: bigint;
  readonly #minimumMargin: Shannons;

  constructor(options: {
    readonly store: SimulationStore;
    readonly chain: SimulationChain;
    readonly rewardLock: ScriptIdentity;
    readonly privateKey: string;
    readonly transactionFee: Shannons;
    readonly maxCycles: bigint;
    readonly minimumMargin: Shannons;
  }) {
    if (operatorLockArgs(options.privateKey) !== options.rewardLock.args) {
      throw new Error("operator private key does not match the configured reward lock");
    }
    if (options.maxCycles < 1n) throw new RangeError("maximum cycles must be positive");
    this.#store = options.store;
    this.#chain = options.chain;
    this.#rewardLock = options.rewardLock;
    this.#privateKey = options.privateKey;
    this.#transactionFee = options.transactionFee;
    this.#maxCycles = options.maxCycles;
    this.#minimumMargin = options.minimumMargin;
  }

  async evaluate(payload: SimulationQueuePayload): Promise<SimulationResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        payload.attemptId,
      )
    ) {
      throw new TypeError("simulation attempt ID is invalid");
    }
    const intentHash = parseHash32(payload.intentHash);
    const attempt = await this.#store.load(payload.attemptId, intentHash);
    if (!attempt) return Object.freeze({ status: "stale" });
    try {
      const built = parseStoredTransaction(attempt.transaction);
      const actualIntentHash = parseHash32(
        rawTransactionToHash(built as unknown as Parameters<typeof rawTransactionToHash>[0]),
      );
      if (actualIntentHash !== attempt.intentHash) {
        throw new SimulationGateError(
          "EXECUTOR_BUILD_RECORD_INVALID",
          "stored transaction no longer matches its intent hash",
        );
      }
      const { fee, reward, feeInputIndex } = accounting(built, attempt.snapshot, this.#rewardLock);
      if (fee !== this.#transactionFee) {
        throw new SimulationGateError(
          "EXECUTOR_FEE_MISMATCH",
          "transaction fee differs from the configured limit",
        );
      }
      if (reward < fee || reward - fee < this.#minimumMargin) {
        throw new SimulationGateError(
          "EXECUTOR_UNPROFITABLE",
          "transaction reward does not meet the configured margin",
        );
      }
      const signed = signOperatorFeeInput(built, this.#privateKey, feeInputIndex);
      const cycles = await this.#chain.dryRun(signed);
      if (cycles > this.#maxCycles) {
        throw new SimulationGateError(
          "EXECUTOR_CYCLE_LIMIT_EXCEEDED",
          "transaction exceeds the configured cycle limit",
        );
      }
      const simulationRecord = Object.freeze({
        cycles: cycles.toString(),
        fee: fee.toString(),
        reward: reward.toString(),
        margin: (reward - fee).toString(),
        intentHash,
        feeInputIndex,
      });
      if (!(await this.#store.approve(attempt, simulationRecord))) {
        return Object.freeze({ status: "stale" });
      }
      return Object.freeze({
        status: "approved",
        attemptId: attempt.attemptId,
        ...simulationRecord,
      });
    } catch (error) {
      const errorCode = gateCode(error);
      await this.#store.reject(attempt, errorCode);
      return Object.freeze({ status: "rejected", attemptId: attempt.attemptId, errorCode });
    }
  }
}
