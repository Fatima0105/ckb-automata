import type { ClientBlock } from "@ckb-ccc/shell";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  parseHash32,
  parseOutPoint,
  parseOutputIndex,
  parseShannons,
  type ScriptIdentity,
} from "@ckb-automata/core";

import type { CkbReadClient } from "../ckb-client.ts";
import type { DaoHarvestV2Deployment } from "../dao-harvest-v2-adapter.ts";
import {
  extractDaoHarvestV2ProjectionEvents,
  type DaoHarvestV2ProjectionDeployment,
  type DaoHarvestV2ResolvedInput,
} from "./dao-harvest-v2-projection.ts";
import type { DaoHarvestV2ProjectionStore } from "./dao-harvest-v2-store.ts";

function script(value: {
  readonly codeHash: unknown;
  readonly hashType: unknown;
  readonly args: unknown;
}): ScriptIdentity {
  const hashType = String(value.hashType);
  const args = String(value.args);
  if (!(["data", "data1", "data2", "type"] as const).includes(hashType as never)) {
    throw new TypeError("resolved V2 input has an invalid script hash type");
  }
  if (!/^0x(?:[0-9a-f]{2})*$/.test(args)) {
    throw new TypeError("resolved V2 input has invalid script args");
  }
  return Object.freeze({
    codeHash: parseHash32(String(value.codeHash)),
    hashType: hashType as ScriptIdentity["hashType"],
    args: args as `0x${string}`,
  });
}

function projectionDeployment(
  networkId: string,
  deployment: DaoHarvestV2Deployment,
): DaoHarvestV2ProjectionDeployment {
  return Object.freeze({
    networkId,
    jobLock: Object.freeze({
      codeHash: deployment.contracts.jobLock.codeHash,
      hashType: "data1" as const,
    }),
    policy: Object.freeze({
      codeHash: deployment.contracts.policy.codeHash,
      hashType: "data1" as const,
      args: deployment.contracts.jobLock.codeHash as `0x${string}`,
    }),
    vaultLock: Object.freeze({
      codeHash: deployment.contracts.vaultLock.codeHash,
      hashType: "data1" as const,
    }),
    compensationLock: Object.freeze({
      codeHash: deployment.contracts.compensationLock.codeHash,
      hashType: "data1" as const,
    }),
    daoTypeHash: parseHash32(
      scriptToHash({
        codeHash: deployment.nervosDao.codeHash,
        hashType: "type",
        args: "0x",
      }),
    ),
  });
}

export interface DaoHarvestV2BlockProjectionResult {
  readonly events: number;
  readonly partial: number;
  readonly snapshots: number;
}

export class DaoHarvestV2BlockIndexer {
  readonly #chain: Pick<CkbReadClient, "getTransactionStatus">;
  readonly #deployment: DaoHarvestV2ProjectionDeployment;
  readonly #store: Pick<
    DaoHarvestV2ProjectionStore,
    "append" | "reset" | "rollback" | "trackedOutPoints"
  >;

  constructor(
    chain: Pick<CkbReadClient, "getTransactionStatus">,
    store: Pick<DaoHarvestV2ProjectionStore, "append" | "reset" | "rollback" | "trackedOutPoints">,
    networkId: string,
    deployment: DaoHarvestV2Deployment,
  ) {
    this.#chain = chain;
    this.#store = store;
    this.#deployment = projectionDeployment(networkId, deployment);
  }

  async projectBlock(
    block: ClientBlock,
    trackedOutPoints?: ReadonlySet<string>,
  ): Promise<DaoHarvestV2BlockProjectionResult> {
    const resolved = await this.#resolveInputs(block, trackedOutPoints);
    const extraction = extractDaoHarvestV2ProjectionEvents(block, this.#deployment, resolved);
    if (extraction.malformed > 0) {
      throw new Error("canonical block contains a malformed DAO harvest V2 transition");
    }
    const snapshots = await this.#store.append(extraction.events);
    return Object.freeze({
      events: extraction.events.length,
      partial: extraction.partial,
      snapshots: snapshots.length,
    });
  }

  rollback(networkId: string, orphanedBlockHashes: readonly string[]) {
    return this.#store.rollback(networkId, orphanedBlockHashes);
  }

  reset(networkId: string) {
    return this.#store.reset(networkId);
  }

  async #resolveInputs(
    block: ClientBlock,
    trackedOutPoints?: ReadonlySet<string>,
  ): Promise<readonly DaoHarvestV2ResolvedInput[]> {
    const inBlock = new Map<string, ClientBlock["transactions"][number]>(
      block.transactions.map((transaction) => [transaction.hash().toString(), transaction]),
    );
    const tracked = new Set(
      trackedOutPoints ?? (await this.#store.trackedOutPoints(this.#deployment.networkId)),
    );
    for (const transaction of block.transactions) {
      const transactionHash = transaction.hash().toString();
      transaction.outputs.forEach((output, outputIndex) => {
        if (
          (output.lock.codeHash.toString() === this.#deployment.jobLock.codeHash &&
            output.lock.hashType === this.#deployment.jobLock.hashType) ||
          (output.lock.codeHash.toString() === this.#deployment.vaultLock.codeHash &&
            output.lock.hashType === this.#deployment.vaultLock.hashType) ||
          (output.lock.codeHash.toString() === this.#deployment.compensationLock.codeHash &&
            output.lock.hashType === this.#deployment.compensationLock.hashType)
        ) {
          tracked.add(`${transactionHash}:${outputIndex}`);
        }
      });
    }
    const resolved = new Map<string, DaoHarvestV2ResolvedInput>();
    for (const transaction of block.transactions) {
      const relevantOutput = transaction.outputs.some(
        (output) =>
          (output.type?.codeHash.toString() === this.#deployment.policy.codeHash &&
            output.type.hashType === this.#deployment.policy.hashType) ||
          (output.lock.codeHash.toString() === this.#deployment.compensationLock.codeHash &&
            output.lock.hashType === this.#deployment.compensationLock.hashType),
      );
      const spendsTracked = transaction.inputs.some((input) => {
        const txHash = input.previousOutput.txHash.toString();
        const index = BigInt(input.previousOutput.index).toString();
        return tracked.has(`${txHash}:${index}`);
      });
      if (!relevantOutput && !spendsTracked) continue;
      for (const input of transaction.inputs) {
        const txHash = parseHash32(input.previousOutput.txHash.toString());
        const index = Number(parseOutputIndex(input.previousOutput.index.toString()));
        const key = `${txHash}:${index}`;
        if (resolved.has(key)) continue;
        const previous =
          inBlock.get(txHash) ?? (await this.#chain.getTransactionStatus(txHash))?.transaction;
        const output = previous?.outputs[index];
        const data = previous?.outputsData[index];
        if (!output || data === undefined) {
          throw new Error(`canonical V2 input ${key} could not be resolved`);
        }
        resolved.set(
          key,
          Object.freeze({
            outPoint: parseOutPoint({ txHash, index: `0x${index.toString(16)}` }),
            capacity: parseShannons(output.capacity.toString()),
            lock: script(output.lock),
            type: output.type == null ? null : script(output.type),
            data: data.toString() as `0x${string}`,
          }),
        );
      }
    }
    return Object.freeze([...resolved.values()]);
  }
}

export class DaoHarvestV2RevisionIndexer {
  readonly #indexers: readonly DaoHarvestV2BlockIndexer[];
  readonly #networkId: string;
  readonly #store: Pick<DaoHarvestV2ProjectionStore, "reset" | "rollback" | "trackedOutPoints">;

  constructor(
    chain: Pick<CkbReadClient, "getTransactionStatus">,
    store: Pick<DaoHarvestV2ProjectionStore, "append" | "reset" | "rollback" | "trackedOutPoints">,
    networkId: string,
    deployments: readonly DaoHarvestV2Deployment[],
  ) {
    if (deployments.length === 0) throw new RangeError("at least one V2 deployment is required");
    this.#networkId = networkId;
    this.#store = store;
    this.#indexers = Object.freeze(
      deployments.map(
        (deployment) => new DaoHarvestV2BlockIndexer(chain, store, networkId, deployment),
      ),
    );
  }

  async projectBlock(block: ClientBlock): Promise<DaoHarvestV2BlockProjectionResult> {
    const trackedOutPoints = await this.#store.trackedOutPoints(this.#networkId);
    const results: DaoHarvestV2BlockProjectionResult[] = [];
    for (const indexer of this.#indexers) {
      results.push(await indexer.projectBlock(block, trackedOutPoints));
    }
    return Object.freeze({
      events: results.reduce((total, result) => total + result.events, 0),
      partial: results.reduce((total, result) => total + result.partial, 0),
      snapshots: results.reduce((total, result) => total + result.snapshots, 0),
    });
  }

  rollback(networkId: string, orphanedBlockHashes: readonly string[]) {
    return this.#store.rollback(networkId, orphanedBlockHashes);
  }

  reset(networkId: string) {
    return this.#store.reset(networkId);
  }
}
