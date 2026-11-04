import assert from "node:assert/strict";
import test from "node:test";

import { CheckpointError } from "./checkpoints.ts";
import { CanonicalBlockProjector } from "./reorg.ts";

const hash = (byte: string) => `0x${byte.repeat(32)}` as const;

function block(number: bigint, blockHash: string, parentHash: string) {
  return {
    header: { number, hash: blockHash, parentHash, timestamp: 1_000n + number },
    transactions: [],
  } as never;
}

test("reorg rollback failures preserve the stable checkpoint error contract", () => {
  const error = new CheckpointError(
    "REORG_BEYOND_WINDOW",
    "reorg parent is not in the retained canonical window",
  );
  assert.equal(error.code, "REORG_BEYOND_WINDOW");
  assert.doesNotMatch(error.message, /postgres|rpc|url/i);
});

test("projector finds a retained common ancestor and replays every replacement block", async () => {
  const oldTen = hash("10");
  const commonNine = hash("09");
  const newTen = hash("20");
  const newEleven = hash("21");
  let checkpoint = { blockNumber: 10n, blockHash: oldTen };
  const projected: bigint[] = [];
  const rollbackCalls: unknown[][] = [];
  const ordering: string[] = [];
  const blocks = new Map([
    [9n, block(9n, commonNine, hash("08"))],
    [10n, block(10n, newTen, commonNine)],
    [11n, block(11n, newEleven, newTen)],
  ]);
  const projector = new CanonicalBlockProjector(
    { getBlockByNumber: async (height: bigint) => blocks.get(height) } as never,
    {
      load: async () => checkpoint,
      listRetained: async () => [
        { blockNumber: 10n, blockHash: oldTen },
        { blockNumber: 9n, blockHash: commonNine },
      ],
      record: async (input: { blockNumber: bigint; blockHash: typeof oldTen }) => {
        checkpoint = { blockNumber: input.blockNumber, blockHash: input.blockHash };
        return { status: "advanced", checkpoint, rolledBackBlocks: 0 };
      },
    } as never,
    {
      rollbackToParent: async (...args: unknown[]) => {
        ordering.push("checkpoint-rollback");
        rollbackCalls.push(args);
        checkpoint = { blockNumber: 9n, blockHash: commonNine };
        return {
          rolledBackBlocks: 1,
          orphanedEvents: 0,
          orphanedVersions: 0,
          restoredJobs: 0,
          orphanedJobs: 0,
          checkpoint,
        };
      },
    } as never,
    {
      projectBlock: async (candidate: { header: { number: bigint } }) => {
        projected.push(candidate.header.number);
        return { discovered: 0 };
      },
    } as never,
    { indexBlock: async () => ({ transitions: 0 }) } as never,
    {
      daoHarvestV2: {
        rollback: async (_network: string, hashes: readonly string[]) => {
          ordering.push(`v2-rollback:${hashes.join(",")}`);
          return [];
        },
        projectBlock: async (candidate: { header: { number: bigint } }) => {
          ordering.push(`v2-project:${candidate.header.number}`);
          return { events: 0, partial: 0, snapshots: 0 };
        },
      },
    },
  );

  const result = await projector.scanBlock(11n, { network: "ckb_testnet" } as never);

  assert.deepEqual(rollbackCalls, [["ckb_testnet", 9n, commonNine]]);
  assert.deepEqual(projected, [10n, 11n]);
  assert.equal(result.rollback?.rolledBackBlocks, 1);
  assert.deepEqual(checkpoint, { blockNumber: 11n, blockHash: newEleven });
  assert.deepEqual(ordering, [
    `v2-rollback:${oldTen}`,
    "checkpoint-rollback",
    "v2-project:10",
    "v2-project:11",
  ]);
});
