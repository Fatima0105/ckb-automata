import assert from "node:assert/strict";
import test from "node:test";

import type { ApiDaoHarvestV2Build } from "@ckb-automata/api-client";

import {
  normalizeDaoHarvestV2Build,
  verifyRefreshedDaoHarvestV2Build,
} from "./dao-harvest-v2-review.ts";

const hash = (value: string) => `0x${value.repeat(64)}`;

function build(): ApiDaoHarvestV2Build {
  return {
    version: 2,
    jobId: hash("a"),
    operation: "setup",
    transaction: {
      version: "0x0",
      cellDeps: [],
      headerDeps: [],
      inputs: [],
      outputs: [],
      outputsData: [],
      witnesses: [],
    },
    intentHash: hash("1"),
    payloadHash: hash("2"),
    progressHash: hash("3"),
    prepareCreditHash: hash("0"),
    review: {
      originalAmount: "1000",
      expectedCompensation: "20",
      completedWorkCharges: { prepare: "4", claim: "5", maximumTotal: "9" },
      maximumNetworkFee: "2",
      recoverableReserve: "100",
      accumulatedCompensation: "0",
      totalLockedAmount: "1100",
      notes: ["Original amount is protected."],
    },
    completion: {
      requiredInputCount: 0,
      requiredOutputCount: 0,
      requiredInputCapacity: "0",
      maximumFee: "2",
      allowedFundingLockHashes: [hash("4")],
    },
  };
}

test("normalizes every reviewed amount without floating point", () => {
  const normalized = normalizeDaoHarvestV2Build(build());
  assert.equal(normalized.review.originalAmount, 1000n);
  assert.equal(normalized.review.completedWorkCharges.maximumTotal, 9n);
  assert.equal(normalized.completion.maximumFee, 2n);
});

test("stale reviews reject every changed protocol commitment", () => {
  const reviewed = build();
  verifyRefreshedDaoHarvestV2Build(reviewed, structuredClone(reviewed));
  for (const field of ["intentHash", "payloadHash", "progressHash", "prepareCreditHash"] as const) {
    assert.throws(() =>
      verifyRefreshedDaoHarvestV2Build(reviewed, { ...reviewed, [field]: hash("9") }),
    );
  }
});
