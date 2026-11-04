import assert from "node:assert/strict";
import test from "node:test";

import type { ApiDaoHarvestV2 } from "@ckb-automata/api-client";

import {
  daoHarvestV2Presentation,
  harvestV2Operation,
  harvestV2OwnerActions,
} from "./v2-presentation.ts";

function job(state: string, available = "0"): ApiDaoHarvestV2 {
  return {
    version: 2,
    jobId: `0x${"1".repeat(64)}`,
    ownerLockHash: `0x${"2".repeat(64)}`,
    payoutLockHash: `0x${"3".repeat(64)}`,
    payloadHash: `0x${"4".repeat(64)}`,
    state,
    progress: { cycle: "1", totalCycles: "3" },
    protectedAmount: "100000000000",
    compensation: { cellAmount: available, availableToWithdraw: available },
    cells: { job: {}, daoVault: {}, compensation: {} },
    prepareCredit: null,
    operatorWindow: {},
    serviceSettlement: {
      status: "complete",
      preparePaid: "0",
      claimPaid: "0",
      lastOperation: "setup",
    },
    evidence: {
      completeness: "complete",
      transactionStatus: "committed",
      canonical: true,
      blockNumber: "1",
      blockHash: `0x${"5".repeat(64)}`,
      transactionHash: `0x${"6".repeat(64)}`,
    },
    updatedAt: "2026-11-04T00:00:00.000Z",
  };
}

test("uses waiting, processing, and completed language without raw chain timing", () => {
  assert.equal(daoHarvestV2Presentation(job("deposited")).statusLabel, "Waiting");
  assert.equal(daoHarvestV2Presentation(job("withdrawing")).statusLabel, "Processing");
  assert.equal(daoHarvestV2Presentation(job("completed")).statusLabel, "Completed");
  assert.doesNotMatch(daoHarvestV2Presentation(job("deposited")).action, /block|epoch/i);
});

test("plain activity copy distinguishes preferred and backup operators", () => {
  assert.equal(harvestV2Operation("preferred_prepare"), "Preferred operator started the harvest");
  assert.equal(harvestV2Operation("fallback_claim"), "Backup operator completed the harvest");
});

test("owner actions follow live funds and lifecycle state", () => {
  assert.deepEqual(harvestV2OwnerActions(job("deposited", "10")), ["sweep", "rotate", "recover"]);
  assert.deepEqual(harvestV2OwnerActions(job("completed")), ["close"]);
  assert.deepEqual(harvestV2OwnerActions(job("closed")), []);
});
