import assert from "node:assert/strict";
import test from "node:test";

import {
  HARVEST_V2_COMPENSATION_CELL_OCCUPIED_CAPACITY,
  prototypeCompensationClose,
  prototypeCompensationSeed,
  prototypeCompensationSweep,
  prototypeHarvestV2Settlement,
  prototypeOperatorAccumulator,
  prototypePlainCellOccupiedCapacity,
} from "./dao-harvest-v2-prototype.ts";

const CKB = 100_000_000n;

test("prototype occupied capacities match short, secp, and long payout locks", () => {
  assert.equal(prototypePlainCellOccupiedCapacity(0), 41n * CKB);
  assert.equal(prototypePlainCellOccupiedCapacity(20), 61n * CKB);
  assert.equal(prototypePlainCellOccupiedCapacity(128), 169n * CKB);
  assert.equal(HARVEST_V2_COMPENSATION_CELL_OCCUPIED_CAPACITY, 201n * CKB);
  assert.equal(prototypeCompensationSeed(0), 201n * CKB);
  assert.equal(prototypeCompensationSeed(20), 201n * CKB);
  assert.equal(prototypeCompensationSeed(128), 201n * CKB);
  assert.equal(prototypeCompensationSeed(160), 201n * CKB);
});

test("claim preserves principal and applies exact fee priority", () => {
  const seed = prototypeCompensationSeed(20);
  const result = prototypeHarvestV2Settlement({
    principalCapacity: 10_000n * CKB,
    grossCompensation: 100n * CKB,
    prepareServiceFee: 20n * CKB,
    claimServiceFee: 30n * CKB,
    compensationCellCapacity: seed + 7n * CKB,
    compensationSeedCapacity: seed,
    ownerCompletesClaim: false,
  });
  assert.deepEqual(result, {
    principalRedeployed: 10_000n * CKB,
    preparePayment: 20n * CKB,
    claimPayment: 30n * CKB,
    ownerCompensation: 50n * CKB,
    compensationCellBefore: seed + 7n * CKB,
    compensationCellAfter: seed + 57n * CKB,
    grossCompensation: 100n * CKB,
  });
  assert.equal(
    result.preparePayment + result.claimPayment + result.ownerCompensation,
    result.grossCompensation,
  );
});

test("insufficient compensation pays partial work without debt or principal loss", () => {
  const seed = prototypeCompensationSeed(20);
  const result = prototypeHarvestV2Settlement({
    principalCapacity: 10_000n * CKB,
    grossCompensation: 15n * CKB,
    prepareServiceFee: 20n * CKB,
    claimServiceFee: 30n * CKB,
    compensationCellCapacity: seed,
    compensationSeedCapacity: seed,
    ownerCompletesClaim: false,
  });
  assert.equal(result.principalRedeployed, 10_000n * CKB);
  assert.equal(result.preparePayment, 15n * CKB);
  assert.equal(result.claimPayment, 0n);
  assert.equal(result.ownerCompensation, 0n);
  assert.equal(result.compensationCellAfter, seed);
});

test("owner completion waives claim payment and accumulates the remainder", () => {
  const seed = prototypeCompensationSeed(20);
  const result = prototypeHarvestV2Settlement({
    principalCapacity: 10_000n * CKB,
    grossCompensation: 40n * CKB,
    prepareServiceFee: 10n * CKB,
    claimServiceFee: 30n * CKB,
    compensationCellCapacity: seed,
    compensationSeedCapacity: seed,
    ownerCompletesClaim: true,
  });
  assert.equal(result.preparePayment, 10n * CKB);
  assert.equal(result.claimPayment, 0n);
  assert.equal(result.ownerCompensation, 30n * CKB);
  assert.equal(result.compensationCellAfter, seed + 30n * CKB);
});

test("policy-bound accumulator accepts payments that would make dust direct payouts", () => {
  const occupied = prototypePlainCellOccupiedCapacity(64);
  const small = prototypeOperatorAccumulator(occupied + 5n * CKB, 1n * CKB);
  assert.equal(small.outputCapacity, occupied + 6n * CKB);
  assert.equal(small.directPayoutIsDust, true);

  const large = prototypeOperatorAccumulator(occupied, occupied);
  assert.equal(large.outputCapacity, occupied * 2n);
  assert.equal(large.directPayoutIsDust, false);
  assert.throws(() => prototypeOperatorAccumulator(occupied - 1n, 1n), /below occupied/);
});

test("sweep recreates the exact reserve and conserves the accumulated delta", () => {
  const seed = prototypeCompensationSeed(20);
  const result = prototypeCompensationSweep(seed + 80n * CKB, seed, 20);
  assert.deepEqual(result, {
    compensationCellInput: seed + 80n * CKB,
    compensationCellOutput: seed,
    payout: 80n * CKB,
  });
  assert.equal(result.compensationCellOutput + result.payout, result.compensationCellInput);
  assert.throws(
    () => prototypeCompensationSweep(seed + 60n * CKB, seed, 20),
    /cannot create a valid payout Cell/,
  );
});

test("final close returns reserve and accumulation for every reviewed payout lock", () => {
  for (const lockArgsBytes of [0, 20, 128, 160]) {
    const seed = prototypeCompensationSeed(lockArgsBytes);
    const result = prototypeCompensationClose(seed + 1n, seed, lockArgsBytes);
    assert.equal(result.payout, seed + 1n);
    assert.equal(result.recoveredSeed, seed);
    assert.equal(result.accumulatedCompensation, 1n);
  }
});

test("successor overflow and reserve violations fail closed", () => {
  const seed = prototypeCompensationSeed(20);
  assert.throws(
    () =>
      prototypeHarvestV2Settlement({
        principalCapacity: 1n,
        grossCompensation: 1n,
        prepareServiceFee: 0n,
        claimServiceFee: 0n,
        compensationCellCapacity: (1n << 64n) - 1n,
        compensationSeedCapacity: seed,
        ownerCompletesClaim: false,
      }),
    /exceeds uint64/,
  );
  assert.throws(
    () => prototypeCompensationClose(seed - 1n, seed, 20),
    /below its recoverable reserve/,
  );
});

test("competing transitions share one canonical Compensation Cell input", () => {
  const canonicalOutPoint = `${"ab".repeat(32)}:0`;
  const firstAttempt = { compensationInput: canonicalOutPoint, claimant: "operator-a" };
  const secondAttempt = { compensationInput: canonicalOutPoint, claimant: "operator-b" };
  assert.equal(firstAttempt.compensationInput, secondAttempt.compensationInput);

  const committedInputs = new Set<string>();
  assert.equal(committedInputs.has(firstAttempt.compensationInput), false);
  committedInputs.add(firstAttempt.compensationInput);
  assert.equal(committedInputs.has(secondAttempt.compensationInput), true);
});
