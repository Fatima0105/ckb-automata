import { isAbsoluteBlockDeadline } from "./campaign.ts";
import {
  parseBlockNumber,
  parseHash32,
  parseOutPoint,
  parseSequence,
  parseShannons,
  type Hash32,
  type OutPoint,
} from "./chain-values.ts";
import { CONTRACT_CAPACITY } from "./contract-costs.ts";

export interface DeadlineRequestPledge {
  readonly outPoint: OutPoint;
  readonly refundLockHash: Hash32;
  readonly amount: string;
}

export interface DeadlineCreationRequest {
  readonly pledges: readonly DeadlineRequestPledge[];
  readonly target: string;
  readonly deadlineBlock: string;
  readonly successLockHash: Hash32;
  readonly cancelLockHash: Hash32;
  readonly reward: string;
  readonly creatorNonce: string;
  readonly preferredExecutorLockHash?: Hash32;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  keys: readonly string[],
  name: string,
  optional: readonly string[] = [],
): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new TypeError(`${name} contains unsupported fields`);
  }
  if (keys.some((key) => !optional.includes(key) && !(key in value))) {
    throw new TypeError(`${name} is missing required fields`);
  }
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

export function parseDeadlineCreationRequest(input: unknown): DeadlineCreationRequest {
  const request = record(input, "deadline request");
  exact(
    request,
    [
      "pledges",
      "target",
      "deadlineBlock",
      "successLockHash",
      "cancelLockHash",
      "reward",
      "creatorNonce",
      "preferredExecutorLockHash",
    ],
    "deadline request",
    ["preferredExecutorLockHash"],
  );

  if (!Array.isArray(request["pledges"]) || request["pledges"].length === 0) {
    throw new RangeError("pledges must contain at least one funding input");
  }
  if (request["pledges"].length > 0xffff_ffff) {
    throw new RangeError("pledges must fit within a uint32 count");
  }

  const seenOutPoints = new Set<string>();
  let pledgedTotal = 0n;
  const pledges = request["pledges"].map((value, index) => {
    const pledge = record(value, `pledges[${index}]`);
    exact(pledge, ["outPoint", "refundLockHash", "amount"], `pledges[${index}]`);
    const point = record(pledge["outPoint"], `pledges[${index}].outPoint`);
    exact(point, ["txHash", "index"], `pledges[${index}].outPoint`);
    const outPoint = parseOutPoint({
      txHash: nonzeroHash(point["txHash"], `pledges[${index}].outPoint.txHash`),
      index: decimal(point["index"], `pledges[${index}].outPoint.index`),
    });
    const key = `${outPoint.txHash}:${outPoint.index}`;
    if (seenOutPoints.has(key)) throw new RangeError("pledge outpoints must be unique");
    seenOutPoints.add(key);

    const amount = parseShannons(decimal(pledge["amount"], `pledges[${index}].amount`));
    if (amount < CONTRACT_CAPACITY.plainWalletCell) {
      throw new RangeError("each pledge must fund a future plain refund output");
    }
    pledgedTotal += amount;
    parseShannons(pledgedTotal);
    return Object.freeze({
      outPoint,
      refundLockHash: nonzeroHash(pledge["refundLockHash"], `pledges[${index}].refundLockHash`),
      amount: amount.toString(),
    });
  });

  const target = parseShannons(decimal(request["target"], "target"));
  if (target === 0n) throw new RangeError("target must be greater than zero");
  const deadlineBlock = parseBlockNumber(decimal(request["deadlineBlock"], "deadlineBlock"));
  if (!isAbsoluteBlockDeadline(deadlineBlock)) {
    throw new RangeError("deadlineBlock must be a non-zero absolute block number");
  }
  const reward = parseShannons(decimal(request["reward"], "reward"));
  if (reward < CONTRACT_CAPACITY.plainWalletCell) {
    throw new RangeError("reward must fund a future plain output");
  }
  const creatorNonce = parseSequence(decimal(request["creatorNonce"], "creatorNonce"));

  return Object.freeze({
    pledges: Object.freeze(pledges),
    target: target.toString(),
    deadlineBlock: deadlineBlock.toString(),
    successLockHash: nonzeroHash(request["successLockHash"], "successLockHash"),
    cancelLockHash: nonzeroHash(request["cancelLockHash"], "cancelLockHash"),
    reward: reward.toString(),
    creatorNonce: creatorNonce.toString(),
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
