import {
  MAX_UINT32,
  parseBlockNumber,
  parseHash32,
  parseRunCount,
  parseSequence,
  parseShannons,
  type Hash32,
} from "./chain-values.ts";
import { CONTRACT_CAPACITY } from "./contract-costs.ts";
import { isValidRecurringSchedule } from "./recurring.ts";

export interface RecurringCreationRequest {
  readonly ownerLockHash: Hash32;
  readonly recipientLockHash: Hash32;
  readonly amount: string;
  readonly intervalBlocks: string;
  readonly firstNotBefore: string;
  readonly totalRuns: string;
  readonly reward: string;
  readonly creatorNonce: string;
  readonly preferredExecutorLockHash?: Hash32;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("recurring request must be an object");
  }
  return value as Record<string, unknown>;
}

function decimal(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`${name} must be a canonical decimal string`);
  }
  return value;
}

function nonzeroHash(value: unknown, name: string): Hash32 {
  const hash = parseHash32(typeof value === "string" ? value : "");
  if (/^0x0{64}$/.test(hash)) throw new RangeError(`${name} must not be zero`);
  return hash;
}

export function parseRecurringCreationRequest(input: unknown): RecurringCreationRequest {
  const request = record(input);
  const keys = [
    "ownerLockHash",
    "recipientLockHash",
    "amount",
    "intervalBlocks",
    "firstNotBefore",
    "totalRuns",
    "reward",
    "creatorNonce",
    "preferredExecutorLockHash",
  ] as const;
  if (Object.keys(request).some((key) => !keys.includes(key as (typeof keys)[number]))) {
    throw new TypeError("recurring request contains unsupported fields");
  }
  if (keys.some((key) => key !== "preferredExecutorLockHash" && !(key in request))) {
    throw new TypeError("recurring request is missing required fields");
  }

  const amount = parseShannons(decimal(request["amount"], "amount"));
  const reward = parseShannons(decimal(request["reward"], "reward"));
  if (amount < CONTRACT_CAPACITY.plainWalletCell) {
    throw new RangeError("amount must fund a future plain output");
  }
  if (reward < CONTRACT_CAPACITY.plainWalletCell) {
    throw new RangeError("reward must fund a future plain output");
  }
  const intervalBlocks = parseBlockNumber(decimal(request["intervalBlocks"], "intervalBlocks"));
  const firstNotBefore = parseBlockNumber(decimal(request["firstNotBefore"], "firstNotBefore"));
  const totalRuns = parseRunCount(decimal(request["totalRuns"], "totalRuns"));
  if (
    !isValidRecurringSchedule({
      amount,
      intervalBlocks,
      firstNotBefore,
      totalRuns,
      finalRefundKind: 0,
    })
  ) {
    throw new RangeError("recurring schedule contains an unsupported boundary");
  }
  if (totalRuns > MAX_UINT32) throw new RangeError("totalRuns exceeds uint32");
  const lastRun = firstNotBefore + (totalRuns - 1n) * intervalBlocks;
  if (lastRun > (1n << 56n) - 1n) {
    throw new RangeError("recurring schedule exceeds the absolute block-number range");
  }

  const applicationTotal = amount * totalRuns;
  const rewardTotal = reward * totalRuns;
  parseShannons(applicationTotal);
  parseShannons(rewardTotal);
  const remainingBudget = parseShannons(applicationTotal + rewardTotal);
  parseShannons(CONTRACT_CAPACITY.jobCellV1 + remainingBudget);

  return Object.freeze({
    ownerLockHash: nonzeroHash(request["ownerLockHash"], "ownerLockHash"),
    recipientLockHash: nonzeroHash(request["recipientLockHash"], "recipientLockHash"),
    amount: amount.toString(),
    intervalBlocks: intervalBlocks.toString(),
    firstNotBefore: firstNotBefore.toString(),
    totalRuns: totalRuns.toString(),
    reward: reward.toString(),
    creatorNonce: parseSequence(decimal(request["creatorNonce"], "creatorNonce")).toString(),
    ...(request["preferredExecutorLockHash"] === undefined
      ? {}
      : {
          preferredExecutorLockHash: nonzeroHash(
            request["preferredExecutorLockHash"],
            "preferredExecutorLockHash",
          ),
        }),
  });
}
