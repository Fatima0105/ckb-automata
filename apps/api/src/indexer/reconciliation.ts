import type { ClientBlock } from "@ckb-ccc/shell";

import { parseBlockNumber, type RegisteredDeployment } from "@ckb-automata/core";

import type { CkbReadClient } from "../ckb-client.ts";
import type { DaoHarvestV2Deployment } from "../dao-harvest-v2-adapter.ts";
import type { CanonicalCheckpointStore } from "./checkpoints.ts";
import type { DaoHarvestV2RevisionIndexer } from "./dao-harvest-v2-indexer.ts";
import type { JobCellDiscovery } from "./job-discovery.ts";
import type { JobTransitionIndexer } from "./job-transitions.ts";

export const RECONCILIATION_POLL_INTERVAL_MS = 15_000;
export const RECONCILIATION_PAGE_SIZE = 100;
export const RECONCILIATION_INITIAL_LOOKBACK_BLOCKS = 256n;
const MAX_RECONCILIATION_PAGES = 100;

interface ReconciliationLogger {
  info(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

interface LiveJobReconcilerOptions {
  readonly enabled: boolean;
  readonly loadDeployment: () => Promise<RegisteredDeployment>;
  readonly pollIntervalMs?: number;
  readonly daoHarvestV2?: {
    readonly deployments: readonly DaoHarvestV2Deployment[];
    readonly indexer: Pick<DaoHarvestV2RevisionIndexer, "projectBlock">;
  };
}

type ReconciliationChainClient = Pick<
  CkbReadClient,
  "findTransactionsPaged" | "getBlockByNumber" | "getTipHeader"
>;

export interface ReconciliationResult {
  readonly firstBlock: bigint | undefined;
  readonly lastBlock: bigint | undefined;
  readonly projectedBlocks: number;
  readonly stableTip: bigint;
}

function stableTip(tip: bigint, requiredDepth: number): bigint | undefined {
  if (!Number.isSafeInteger(requiredDepth) || requiredDepth < 1) {
    throw new RangeError("confirmation depth must be a positive safe integer");
  }
  const offset = BigInt(requiredDepth - 1);
  return tip < offset ? undefined : tip - offset;
}

function exactJobLock(deployment: RegisteredDeployment) {
  return Object.freeze({ ...deployment.contracts["job-lock"].script, args: "0x" as const });
}

export class LiveJobReconciler {
  readonly #chain: ReconciliationChainClient;
  readonly #checkpoints: Pick<CanonicalCheckpointStore, "load">;
  readonly #discovery: Pick<JobCellDiscovery, "projectBlock">;
  readonly #transitions: Pick<JobTransitionIndexer, "indexBlock">;
  readonly #logger: ReconciliationLogger;
  readonly #options: Required<Pick<LiveJobReconcilerOptions, "enabled" | "pollIntervalMs">> &
    Pick<LiveJobReconcilerOptions, "loadDeployment" | "daoHarvestV2">;
  #lastScanned: bigint | undefined;
  #running = false;
  #stopped = true;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    chain: ReconciliationChainClient,
    checkpoints: Pick<CanonicalCheckpointStore, "load">,
    discovery: Pick<JobCellDiscovery, "projectBlock">,
    transitions: Pick<JobTransitionIndexer, "indexBlock">,
    logger: ReconciliationLogger,
    options: LiveJobReconcilerOptions,
  ) {
    const pollIntervalMs = options.pollIntervalMs ?? RECONCILIATION_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new RangeError("reconciliation poll interval must be a positive safe integer");
    }
    this.#chain = chain;
    this.#checkpoints = checkpoints;
    this.#discovery = discovery;
    this.#transitions = transitions;
    this.#logger = logger;
    this.#options = Object.freeze({
      enabled: options.enabled,
      loadDeployment: options.loadDeployment,
      pollIntervalMs,
      ...(options.daoHarvestV2 === undefined ? {} : { daoHarvestV2: options.daoHarvestV2 }),
    });
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  start(): void {
    if (!this.#options.enabled || !this.#stopped) return;
    this.#stopped = false;
    this.#logger.info("indexer.reconciliation.started", "Live Job Cell reconciliation started", {
      pollIntervalMs: this.#options.pollIntervalMs,
    });
    this.#schedule(0);
  }

  onApplicationShutdown(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<ReconciliationResult> {
    const deployment = await this.#options.loadDeployment();
    const [checkpoint, tipHeader] = await Promise.all([
      this.#checkpoints.load(deployment.network),
      this.#chain.getTipHeader(),
    ]);
    const confirmedTip = stableTip(
      parseBlockNumber(tipHeader.number.toString()),
      deployment.confirmation.requiredDepth,
    );
    if (confirmedTip === undefined) {
      return Object.freeze({
        firstBlock: undefined,
        lastBlock: undefined,
        projectedBlocks: 0,
        stableTip: 0n,
      });
    }

    const checkpointNext =
      checkpoint === undefined
        ? confirmedTip >= RECONCILIATION_INITIAL_LOOKBACK_BLOCKS
          ? confirmedTip - RECONCILIATION_INITIAL_LOOKBACK_BLOCKS + 1n
          : 0n
        : checkpoint.blockNumber + 1n;
    const rememberedNext = this.#lastScanned === undefined ? 0n : this.#lastScanned + 1n;
    const first = checkpointNext > rememberedNext ? checkpointNext : rememberedNext;
    if (first > confirmedTip) {
      this.#lastScanned = confirmedTip;
      return Object.freeze({
        firstBlock: undefined,
        lastBlock: undefined,
        projectedBlocks: 0,
        stableTip: confirmedTip,
      });
    }

    const blockNumbers = new Set<bigint>();
    const scripts = [
      { script: exactJobLock(deployment), searchMode: "exact" as const },
      ...(this.#options.daoHarvestV2 === undefined
        ? []
        : this.#options.daoHarvestV2.deployments.flatMap((harvestDeployment) => [
            {
              script: {
                codeHash: harvestDeployment.contracts.jobLock.codeHash,
                hashType: "data1" as const,
                args: "0x" as const,
              },
              searchMode: "exact" as const,
            },
            {
              script: {
                codeHash: harvestDeployment.contracts.vaultLock.codeHash,
                hashType: "data1" as const,
                args: "0x" as const,
              },
              searchMode: "prefix" as const,
            },
            {
              script: {
                codeHash: harvestDeployment.contracts.compensationLock.codeHash,
                hashType: "data1" as const,
                args: "0x" as const,
              },
              searchMode: "prefix" as const,
            },
          ])),
    ];
    for (const { script, searchMode } of scripts) {
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < MAX_RECONCILIATION_PAGES; pageNumber += 1) {
        const page = await this.#chain.findTransactionsPaged(
          {
            script,
            scriptType: "lock",
            scriptSearchMode: searchMode,
            filter: { blockRange: [first, confirmedTip + 1n] },
            groupByTransaction: true,
          },
          "asc",
          RECONCILIATION_PAGE_SIZE,
          cursor,
        );
        for (const transaction of page.transactions) {
          blockNumbers.add(parseBlockNumber(transaction.blockNumber.toString()));
        }
        if (page.transactions.length < RECONCILIATION_PAGE_SIZE) break;
        if (page.lastCursor === cursor) {
          throw new Error("CKB indexer reconciliation cursor stalled");
        }
        cursor = page.lastCursor;
        if (pageNumber === MAX_RECONCILIATION_PAGES - 1) {
          throw new Error("CKB indexer reconciliation page limit exceeded");
        }
      }
    }

    const orderedBlocks = [...blockNumbers].toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const blockNumber of orderedBlocks) {
      const block = await this.#chain.getBlockByNumber(blockNumber);
      if (block === undefined || parseBlockNumber(block.header.number.toString()) !== blockNumber) {
        throw new Error("CKB reconciliation block is unavailable");
      }
      await this.#project(block, deployment);
    }
    this.#lastScanned = confirmedTip;

    const result = Object.freeze({
      firstBlock: first,
      lastBlock: confirmedTip,
      projectedBlocks: orderedBlocks.length,
      stableTip: confirmedTip,
    });
    this.#logger.info("indexer.reconciliation.completed", "Confirmed Job Cell blocks reconciled", {
      firstBlock: first.toString(),
      lastBlock: confirmedTip.toString(),
      projectedBlocks: orderedBlocks.length,
    });
    return result;
  }

  async #project(block: ClientBlock, deployment: RegisteredDeployment): Promise<void> {
    await this.#discovery.projectBlock(block, deployment);
    await this.#transitions.indexBlock(block, deployment);
    await this.#options.daoHarvestV2?.indexer.projectBlock(block);
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#poll(), delayMs);
  }

  async #poll(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.#logger.error("indexer.reconciliation.failed", "Live Job Cell reconciliation failed", {
        code: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      });
    } finally {
      this.#running = false;
      this.#schedule(this.#options.pollIntervalMs);
    }
  }
}
