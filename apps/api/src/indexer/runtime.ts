import type { ClientBlock } from "@ckb-ccc/shell";

import { parseBlockNumber, type RegisteredDeployment } from "@ckb-automata/core";

import type { CkbReadClient } from "../ckb-client.ts";
import { CheckpointError, type CanonicalCheckpointStore } from "./checkpoints.ts";
import type { CanonicalBlockProjector } from "./reorg.ts";

export const INDEXER_INITIAL_BACKFILL_BLOCKS = 256n;
export const INDEXER_BATCH_BLOCKS = 128n;
export const INDEXER_FETCH_CONCURRENCY = 8;
export const INDEXER_POLL_INTERVAL_MS = 3_000;

export interface IndexerScanRange {
  readonly first: bigint;
  readonly last: bigint;
}

export function nextIndexerScanRange(
  checkpoint: bigint | undefined,
  tip: bigint,
  initialBackfill: bigint = INDEXER_INITIAL_BACKFILL_BLOCKS,
  batchSize: bigint = INDEXER_BATCH_BLOCKS,
): IndexerScanRange | undefined {
  if (tip < 0n || initialBackfill < 1n || batchSize < 1n) {
    throw new RangeError("indexer range inputs must be positive canonical block counts");
  }
  const first =
    checkpoint === undefined
      ? tip >= initialBackfill
        ? tip - initialBackfill + 1n
        : 0n
      : checkpoint + 1n;
  if (first > tip) return undefined;
  const batchLast = first + batchSize - 1n;
  return Object.freeze({ first, last: batchLast < tip ? batchLast : tip });
}

interface IndexerLogger {
  info(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface LiveIndexerRuntimeOptions {
  readonly enabled: boolean;
  readonly loadDeployment: () => Promise<RegisteredDeployment>;
  readonly pollIntervalMs?: number;
}

export class LiveIndexerRuntime {
  readonly #chain: Pick<CkbReadClient, "getBlockByNumber" | "getTipHeader"> &
    Partial<Pick<CkbReadClient, "getBlocksByNumber">>;
  readonly #checkpoints: CanonicalCheckpointStore;
  readonly #projector: Pick<CanonicalBlockProjector, "projectBlock">;
  readonly #logger: IndexerLogger;
  readonly #options: Required<Pick<LiveIndexerRuntimeOptions, "enabled" | "pollIntervalMs">> &
    Pick<LiveIndexerRuntimeOptions, "loadDeployment">;
  #running = false;
  #stopped = true;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    chain: Pick<CkbReadClient, "getBlockByNumber" | "getTipHeader"> &
      Partial<Pick<CkbReadClient, "getBlocksByNumber">>,
    checkpoints: CanonicalCheckpointStore,
    projector: Pick<CanonicalBlockProjector, "projectBlock">,
    logger: IndexerLogger,
    options: LiveIndexerRuntimeOptions,
  ) {
    const pollIntervalMs = options.pollIntervalMs ?? INDEXER_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) {
      throw new RangeError("indexer poll interval must be a positive safe integer");
    }
    this.#chain = chain;
    this.#checkpoints = checkpoints;
    this.#projector = projector;
    this.#logger = logger;
    this.#options = Object.freeze({
      enabled: options.enabled,
      loadDeployment: options.loadDeployment,
      pollIntervalMs,
    });
  }

  onApplicationBootstrap(): void {
    this.start();
  }

  start(): void {
    if (!this.#options.enabled || !this.#stopped) return;
    this.#stopped = false;
    this.#logger.info("indexer.runtime.started", "Canonical indexer runtime started", {
      batchBlocks: INDEXER_BATCH_BLOCKS.toString(),
      initialBackfillBlocks: INDEXER_INITIAL_BACKFILL_BLOCKS.toString(),
      pollIntervalMs: this.#options.pollIntervalMs,
    });
    this.#schedule(0);
  }

  onApplicationShutdown(): void {
    this.#stopped = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  async runBatch(): Promise<{ readonly caughtUp: boolean; readonly scanned: number }> {
    const deployment = await this.#options.loadDeployment();
    const [checkpoint, tip] = await Promise.all([
      this.#checkpoints.load(deployment.network),
      this.#chain.getTipHeader(),
    ]);
    const range = nextIndexerScanRange(checkpoint?.blockNumber, tip.number);
    if (range === undefined) return Object.freeze({ caughtUp: true, scanned: 0 });
    let scanned = 0;
    const loadAndProject = async (blockNumbers: readonly bigint[]) => {
      const loaded = this.#chain.getBlocksByNumber
        ? await this.#chain.getBlocksByNumber(blockNumbers)
        : await Promise.all(
            blockNumbers.map((blockNumber) => this.#chain.getBlockByNumber(blockNumber)),
          );
      if (loaded.length !== blockNumbers.length) {
        throw new Error("CKB client returned the wrong number of blocks");
      }
      const blocks = loaded.map((block, index) => {
        if (!block) throw new Error("canonical block is unavailable");
        if (parseBlockNumber(block.header.number.toString()) !== blockNumbers[index]) {
          throw new Error("CKB client returned a block at the wrong height");
        }
        return block;
      });
      assertContiguousBlocks(blocks);
      for (const block of blocks) {
        await this.#projector.projectBlock(block, deployment);
        scanned += 1;
      }
    };
    if (this.#chain.getBlocksByNumber) {
      await loadAndProject(
        Array.from(
          { length: Number(range.last - range.first + 1n) },
          (_, index) => range.first + BigInt(index),
        ),
      );
    } else {
      for (
        let first = range.first;
        first <= range.last;
        first += BigInt(INDEXER_FETCH_CONCURRENCY)
      ) {
        const last =
          first + BigInt(INDEXER_FETCH_CONCURRENCY) - 1n < range.last
            ? first + BigInt(INDEXER_FETCH_CONCURRENCY) - 1n
            : range.last;
        const blockNumbers = Array.from(
          { length: Number(last - first + 1n) },
          (_, index) => first + BigInt(index),
        );
        await loadAndProject(blockNumbers);
      }
    }
    const caughtUp = range.last === tip.number;
    this.#logger.info("indexer.batch.completed", "Canonical indexer batch completed", {
      caughtUp,
      firstBlock: range.first.toString(),
      lastBlock: range.last.toString(),
      scanned,
    });
    return Object.freeze({ caughtUp, scanned });
  }

  #schedule(delayMs: number): void {
    if (this.#stopped) return;
    this.#timer = setTimeout(() => void this.#poll(), delayMs);
  }

  async #poll(): Promise<void> {
    if (this.#running || this.#stopped) return;
    this.#running = true;
    let delay = this.#options.pollIntervalMs;
    try {
      const result = await this.runBatch();
      if (!result.caughtUp) delay = 0;
    } catch (error) {
      this.#logger.error("indexer.batch.failed", "Canonical indexer batch failed", {
        code:
          error instanceof CheckpointError
            ? error.code
            : error instanceof Error
              ? error.name
              : "UNKNOWN_ERROR",
      });
    } finally {
      this.#running = false;
      this.#schedule(delay);
    }
  }
}

function assertContiguousBlocks(blocks: readonly ClientBlock[]): void {
  for (let index = 1; index < blocks.length; index += 1) {
    if (blocks[index]!.header.parentHash !== blocks[index - 1]!.header.hash) {
      throw new Error("CKB client returned a non-canonical block range");
    }
  }
}
