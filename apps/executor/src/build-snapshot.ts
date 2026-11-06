import { WitnessArgs, type ClientTransactionResponse } from "@ckb-ccc/shell";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import { clientDaoHex, packClientEpoch } from "@ckb-automata/ccc";
import {
  inspectJobData,
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseShannons,
  registeredDaoHarvestDeployment,
  type RegisteredDeployment,
  type OperatorAutomationDeployment,
  type ScriptIdentity,
} from "@ckb-automata/core";

import type { ExecutorCellSnapshot, ExecutorHeaderSnapshot, ExecutorSnapshot } from "./adapter.ts";
import type { BuildSnapshotSource } from "./build.ts";
import type { EligibilityJobRecord } from "./eligibility.ts";
import type { ExecutorRuntime } from "./runtime.ts";

const MAX_LINEAGE_DEPTH = 128;
const MAX_FEE_CELLS = 100;

export interface LockResolutionSource {
  loadResolvedLocks(): Promise<readonly ScriptIdentity[]>;
  rememberResolvedLocks(locks: readonly ScriptIdentity[]): Promise<void>;
}

type ChainCell = Awaited<ReturnType<ExecutorRuntime["getCellLive"]>>;

export function chainScriptIdentity(value: {
  readonly codeHash: unknown;
  readonly hashType: unknown;
  readonly args: unknown;
}): ScriptIdentity {
  const hashType = String(value.hashType);
  if (!(["data", "type", "data1", "data2"] as const).includes(hashType as never)) {
    throw new TypeError("chain script hash type is invalid");
  }
  const args = String(value.args);
  if (!/^0x(?:[0-9a-f]{2})*$/.test(args)) throw new TypeError("chain script args are invalid");
  return Object.freeze({
    codeHash: parseHash32(String(value.codeHash)),
    hashType: hashType as ScriptIdentity["hashType"],
    args: args as `0x${string}`,
  });
}

function headerSnapshot(
  header: Awaited<ReturnType<ExecutorRuntime["getTipHeader"]>>,
): ExecutorHeaderSnapshot {
  return Object.freeze({
    hash: parseHash32(header.hash),
    number: parseBlockNumber(header.number.toString()),
    epoch: `0x${packClientEpoch(header.epoch).toString(16)}`,
    timestamp: header.timestamp.toString() as `0x${string}`,
    ...(header.dao === undefined ? {} : { dao: clientDaoHex(header.dao) }),
  });
}

function chainCellSnapshot(
  cell: NonNullable<ChainCell>,
  block: { readonly hash: string; readonly number: bigint | string },
): ExecutorCellSnapshot {
  return Object.freeze({
    outPoint: parseOutPoint({
      txHash: cell.outPoint.txHash,
      index: cell.outPoint.index.toString(),
    }),
    output: Object.freeze({
      capacity: `0x${parseShannons(cell.cellOutput.capacity.toString()).toString(16)}` as const,
      lock: chainScriptIdentity(cell.cellOutput.lock),
      type: cell.cellOutput.type === undefined ? null : chainScriptIdentity(cell.cellOutput.type),
    }),
    data: cell.outputData.toString() as `0x${string}`,
    blockHash: parseHash32(block.hash),
    blockNumber: parseBlockNumber(block.number.toString()),
  });
}

function transactionOutput(
  response: ClientTransactionResponse,
  index: number,
): {
  readonly output: ClientTransactionResponse["transaction"]["outputs"][number];
  readonly data: string;
} {
  const output = response.transaction.outputs[index];
  const data = response.transaction.outputsData[index];
  if (!output || data === undefined) throw new Error("chain transaction output is unavailable");
  return { output, data: data.toString() };
}

function committed(response: ClientTransactionResponse | undefined): ClientTransactionResponse {
  if (!response || response.status !== "committed" || !response.blockHash) {
    throw new Error("build evidence transaction is not committed");
  }
  return response;
}

function witnessTypePayloads(response: ClientTransactionResponse): readonly `0x${string}`[] {
  const payloads: `0x${string}`[] = [];
  for (const witness of response.transaction.witnesses) {
    try {
      const decoded = WitnessArgs.fromBytes(witness);
      const inputType = decoded.inputType;
      const outputType = decoded.outputType;
      if (inputType) payloads.push(inputType.toString() as `0x${string}`);
      if (outputType) payloads.push(outputType.toString() as `0x${string}`);
    } catch {
      // Other inputs may use unrelated witness layouts.
    }
  }
  return payloads;
}

function outputTypePayloads(response: ClientTransactionResponse): readonly `0x${string}`[] {
  const payloads: `0x${string}`[] = [];
  for (const witness of response.transaction.witnesses) {
    try {
      const outputType = WitnessArgs.fromBytes(witness).outputType;
      if (outputType) payloads.push(outputType.toString() as `0x${string}`);
    } catch {
      // Other inputs may use unrelated witness layouts.
    }
  }
  return payloads;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

export function assertSnapshotTipContinuity(
  before: ExecutorHeaderSnapshot,
  after: ExecutorHeaderSnapshot,
): void {
  if (
    after.number < before.number ||
    (after.number === before.number && after.hash !== before.hash)
  ) {
    throw Object.assign(new Error("chain tip changed while assembling the build snapshot"), {
      code: "EXECUTOR_CHAIN_SNAPSHOT_MOVED",
    });
  }
}

export class ChainBuildSnapshotSource implements BuildSnapshotSource {
  readonly #deployment: RegisteredDeployment;
  readonly #runtime: ExecutorRuntime;
  readonly #rewardLock: ScriptIdentity;
  readonly #resolutions: LockResolutionSource;
  readonly #operatorDeployment: OperatorAutomationDeployment | undefined;
  readonly #loadOperatorDeployment:
    (() => Promise<OperatorAutomationDeployment | undefined>) | undefined;
  #operatorDeploymentPromise: Promise<OperatorAutomationDeployment | undefined> | undefined;

  constructor(options: {
    readonly deployment: RegisteredDeployment;
    readonly runtime: ExecutorRuntime;
    readonly rewardLock: ScriptIdentity;
    readonly resolutions: LockResolutionSource;
    readonly operatorDeployment?: OperatorAutomationDeployment;
    readonly loadOperatorDeployment?: () => Promise<OperatorAutomationDeployment | undefined>;
  }) {
    this.#deployment = options.deployment;
    this.#runtime = options.runtime;
    this.#rewardLock = options.rewardLock;
    this.#resolutions = options.resolutions;
    this.#operatorDeployment = options.operatorDeployment;
    this.#loadOperatorDeployment = options.loadOperatorDeployment;
  }

  async reload(record: EligibilityJobRecord): Promise<ExecutorSnapshot | undefined> {
    this.#operatorDeploymentPromise ??=
      this.#operatorDeployment !== undefined
        ? Promise.resolve(this.#operatorDeployment)
        : (this.#loadOperatorDeployment?.() ?? Promise.resolve(undefined));
    const operatorDeployment = await this.#operatorDeploymentPromise;
    const tipBefore = headerSnapshot(await this.#runtime.getTipHeader());
    const liveJob = await this.#runtime.getCellLive(record.outPoint);
    if (!liveJob) return undefined;
    const job = chainCellSnapshot(liveJob, record.block);
    if (
      job.data !== record.data ||
      parseShannons(job.output.capacity) !== parseShannons(record.capacity)
    ) {
      return undefined;
    }
    const inspected = inspectJobData(job.data, {
      manifest: this.#deployment.manifest,
      expectedGenesisHash: this.#deployment.genesisHash,
      ...(job.output.type === null ? {} : { policyScript: job.output.type }),
      ...(operatorDeployment === undefined ? {} : { operatorDeployment }),
    });
    if (
      inspected.status !== "ok" ||
      inspected.job.jobId !== record.jobId ||
      inspected.job.sequence.toString() !== record.sequence
    ) {
      return undefined;
    }

    const lineage = await this.#lineage(record.outPoint.txHash);
    const first = lineage[0];
    if (!first || first.blockHash !== record.block.hash) return undefined;
    const current = transactionOutput(first, Number(BigInt(record.outPoint.index)));
    if (
      current.data !== record.data ||
      BigInt(current.output.capacity) !== parseShannons(record.capacity)
    ) {
      return undefined;
    }

    const locks = await this.#resolvedLocks(lineage);
    const payloads = Object.freeze([...new Set(lineage.flatMap(witnessTypePayloads))]);
    const applicationCells = await this.#applicationCells(lineage, inspected.policy);
    const headers = await this.#headers(applicationCells, inspected.policy);
    const feeCells = await this.#feeCells();
    const tip = headerSnapshot(await this.#runtime.getTipHeader());
    assertSnapshotTipContinuity(tipBefore, tip);
    return Object.freeze({
      deployment: this.#deployment,
      tip,
      job,
      applicationCells,
      feeCells,
      headers,
      resolvedLocks: locks,
      payloads,
      claims: Object.freeze({}),
      ...(operatorDeployment === undefined ? {} : { operatorDeployment }),
    });
  }

  async #lineage(start: string): Promise<readonly ClientTransactionResponse[]> {
    const lineage: ClientTransactionResponse[] = [];
    const seen = new Set<string>();
    let hash = parseHash32(start);
    let complete = false;
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      if (seen.has(hash)) throw new Error("job transaction lineage contains a cycle");
      seen.add(hash);
      const response = committed(await this.#runtime.getTransactionStatus(hash));
      lineage.push(response);
      if (outputTypePayloads(response).length > 0) {
        complete = true;
        break;
      }
      const previous = response.transaction.inputs[0]?.previousOutput.txHash.toString();
      if (!previous || /^0x0{64}$/.test(previous)) {
        complete = true;
        break;
      }
      hash = parseHash32(previous);
    }
    if (!complete) {
      throw new Error("job transaction lineage exceeds the supported depth");
    }
    return Object.freeze(lineage);
  }

  async #resolvedLocks(
    lineage: readonly ClientTransactionResponse[],
  ): Promise<readonly ScriptIdentity[]> {
    const locks = new Map<string, ScriptIdentity>();
    const add = (value: Parameters<typeof chainScriptIdentity>[0]) => {
      const normalized = chainScriptIdentity(value);
      locks.set(stable(normalized), normalized);
    };
    add(this.#rewardLock);
    for (const lock of await this.#resolutions.loadResolvedLocks()) add(lock);
    for (const response of lineage) {
      for (const output of response.transaction.outputs) add(output.lock);
      for (const input of response.transaction.inputs) {
        if (/^0x0{64}$/.test(input.previousOutput.txHash.toString())) continue;
        const source = committed(
          await this.#runtime.getTransactionStatus(input.previousOutput.txHash),
        );
        const referenced = source.transaction.outputs[Number(input.previousOutput.index)];
        if (referenced) add(referenced.lock);
      }
    }
    const resolved = Object.freeze([...locks.values()]);
    await this.#resolutions.rememberResolvedLocks(resolved);
    return resolved;
  }

  async #applicationCells(
    lineage: readonly ClientTransactionResponse[],
    policy: Extract<ReturnType<typeof inspectJobData>, { readonly status: "ok" }>["policy"],
  ): Promise<readonly ExecutorCellSnapshot[]> {
    if (policy.kind !== "deadline" && policy.kind !== "dao_harvest") return Object.freeze([]);
    const matches: ExecutorCellSnapshot[] = [];
    const harvest =
      policy.kind === "dao_harvest" ? registeredDaoHarvestDeployment(this.#deployment) : undefined;
    for (const response of lineage) {
      for (const [index, output] of response.transaction.outputs.entries()) {
        const outputTypeHash = output.type
          ? parseHash32(scriptToHash(chainScriptIdentity(output.type)))
          : undefined;
        const matchesPolicy =
          policy.kind === "deadline"
            ? outputTypeHash === policy.campaignTypeHash
            : harvest !== undefined &&
              outputTypeHash ===
                parseHash32(scriptToHash({ ...harvest.daoType.script, args: "0x" })) &&
              output.lock.codeHash === harvest.vaultLock.script.codeHash &&
              output.lock.hashType === harvest.vaultLock.script.hashType;
        if (!matchesPolicy) {
          continue;
        }
        const live = await this.#runtime.getCellLive({
          txHash: response.transaction.hash(),
          index,
        });
        if (!live || !response.blockHash || response.blockNumber === undefined) continue;
        matches.push(
          chainCellSnapshot(live, { hash: response.blockHash, number: response.blockNumber }),
        );
      }
    }
    return Object.freeze(matches);
  }

  async #headers(
    cells: readonly ExecutorCellSnapshot[],
    policy: Extract<ReturnType<typeof inspectJobData>, { readonly status: "ok" }>["policy"],
  ): Promise<readonly ExecutorHeaderSnapshot[]> {
    if (policy.kind !== "dao_harvest") return Object.freeze([]);
    const headers = new Map<string, ExecutorHeaderSnapshot>();
    for (const cell of cells) {
      const containing = await this.#runtime.getBlockByHash(cell.blockHash);
      if (!containing) throw new Error("DAO vault inclusion header is unavailable");
      const snapshot = headerSnapshot(containing.header);
      headers.set(snapshot.hash, snapshot);
      if (cell.data !== "0x0000000000000000") {
        const body = Buffer.from(cell.data.slice(2), "hex");
        if (body.length !== 8) throw new Error("withdrawing DAO vault data is invalid");
        const depositNumber = body.readBigUInt64LE();
        const deposit = await this.#runtime.getBlockByNumber(depositNumber);
        if (!deposit) throw new Error("DAO deposit header is unavailable");
        const depositSnapshot = headerSnapshot(deposit.header);
        headers.set(depositSnapshot.hash, depositSnapshot);
      }
    }
    return Object.freeze([...headers.values()]);
  }

  async #feeCells(): Promise<readonly ExecutorCellSnapshot[]> {
    const page = await this.#runtime.findCellsPaged(
      {
        script: this.#rewardLock,
        scriptType: "lock",
        scriptSearchMode: "exact",
        filter: { outputDataLenRange: [0, 1], scriptLenRange: [0, 1] },
        withData: true,
      },
      "asc",
      MAX_FEE_CELLS,
    );
    const cells: ExecutorCellSnapshot[] = [];
    for (const cell of page.cells) {
      const live = await this.#runtime.getCellLive(cell.outPoint);
      if (!live) continue;
      const source = committed(await this.#runtime.getTransactionStatus(live.outPoint.txHash));
      if (!source.blockHash || source.blockNumber === undefined) continue;
      cells.push(chainCellSnapshot(live, { hash: source.blockHash, number: source.blockNumber }));
    }
    return Object.freeze(cells);
  }
}
