import type { ApiDaoHarvestV2Build } from "@ckb-automata/api-client";
import {
  CREATION_REVIEW_WINDOW_BLOCKS,
  parseHash32,
  parseShannons,
  verifyCompletedDaoHarvestV2Transaction,
  type DaoHarvestV2Build,
  type ResolvedDaoHarvestV2FundingInput,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

interface ReviewInputResolver {
  readonly resolveReviewInput: (
    input: UnsignedDeadlineTransaction["inputs"][number],
  ) => Promise<{ readonly capacity: bigint; readonly lockHash: string }>;
}

export interface DaoHarvestV2ReviewSnapshot {
  readonly blockHash: string;
  readonly blockNumber: string;
  readonly expiresAfterBlock: string;
}

export function daoHarvestV2ReviewSnapshot(
  tip: Readonly<{ blockHash: string; blockNumber: string }>,
): DaoHarvestV2ReviewSnapshot {
  parseHash32(tip.blockHash);
  if (!/^(?:0|[1-9][0-9]*)$/.test(tip.blockNumber)) {
    throw new Error("The reviewed snapshot block is invalid.");
  }
  return Object.freeze({
    ...tip,
    expiresAfterBlock: (BigInt(tip.blockNumber) + CREATION_REVIEW_WINDOW_BLOCKS).toString(),
  });
}

function transaction(value: unknown): UnsignedDeadlineTransaction {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The reviewed transaction is invalid.");
  }
  const item = value as Record<string, unknown>;
  for (const field of ["cellDeps", "headerDeps", "inputs", "outputs", "outputsData", "witnesses"]) {
    if (!Array.isArray(item[field])) throw new Error("The reviewed transaction is incomplete.");
  }
  if (typeof item["version"] !== "string") {
    throw new Error("The reviewed transaction version is invalid.");
  }
  return value as UnsignedDeadlineTransaction;
}

export function normalizeDaoHarvestV2Build(build: ApiDaoHarvestV2Build): DaoHarvestV2Build {
  parseHash32(build.jobId);
  const review = build.review;
  const completion = build.completion;
  return Object.freeze({
    operation:
      build.operation === "setup"
        ? 0
        : build.operation === "sweep"
          ? 6
          : build.operation === "close"
            ? 7
            : build.operation === "rotate"
              ? 8
              : 9,
    transaction: transaction(build.transaction),
    intentHash: parseHash32(build.intentHash),
    payloadHash: parseHash32(build.payloadHash),
    progressHash: parseHash32(build.progressHash),
    prepareCreditHash: parseHash32(build.prepareCreditHash),
    review: Object.freeze({
      originalAmount: parseShannons(review.originalAmount),
      expectedCompensation: parseShannons(review.expectedCompensation),
      completedWorkCharges: Object.freeze({
        prepare: parseShannons(review.completedWorkCharges.prepare),
        claim: parseShannons(review.completedWorkCharges.claim),
        maximumTotal: parseShannons(review.completedWorkCharges.maximumTotal),
      }),
      maximumNetworkFee: parseShannons(review.maximumNetworkFee),
      recoverableReserve: parseShannons(review.recoverableReserve),
      accumulatedCompensation: parseShannons(review.accumulatedCompensation),
      totalLockedAmount: parseShannons(review.totalLockedAmount),
      notes: Object.freeze([...review.notes]),
    }),
    completion: Object.freeze({
      requiredInputCount: completion.requiredInputCount,
      requiredOutputCount: completion.requiredOutputCount,
      requiredInputCapacity: parseShannons(completion.requiredInputCapacity),
      maximumFee: parseShannons(completion.maximumFee),
      allowedFundingLockHashes: Object.freeze(completion.allowedFundingLockHashes.map(parseHash32)),
    }),
  });
}

export async function verifyCompletedDaoHarvestV2Review(
  build: ApiDaoHarvestV2Build,
  completed: UnsignedDeadlineTransaction,
  resolver: ReviewInputResolver,
): Promise<void> {
  const normalized = normalizeDaoHarvestV2Build(build);
  const added = completed.inputs.slice(normalized.completion.requiredInputCount);
  const fundingInputs: ResolvedDaoHarvestV2FundingInput[] = await Promise.all(
    added.map(async (input) => {
      const resolved = await resolver.resolveReviewInput(input);
      return Object.freeze({
        outPoint: input.previousOutput,
        capacity: resolved.capacity,
        lockHash: parseHash32(resolved.lockHash),
      });
    }),
  );
  verifyCompletedDaoHarvestV2Transaction(normalized, completed, fundingInputs);
}

export function verifyRefreshedDaoHarvestV2Build(
  reviewed: ApiDaoHarvestV2Build,
  refreshed: ApiDaoHarvestV2Build,
): void {
  if (
    reviewed.operation !== refreshed.operation ||
    reviewed.jobId !== refreshed.jobId ||
    reviewed.payloadHash !== refreshed.payloadHash ||
    reviewed.progressHash !== refreshed.progressHash ||
    reviewed.prepareCreditHash !== refreshed.prepareCreditHash
  ) {
    throw new Error("The harvest review changed. Build a fresh review before signing.");
  }
}
