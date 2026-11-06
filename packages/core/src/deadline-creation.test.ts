import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { serializeRawTransaction, serializeWitnessArgs } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, parseOutPoint } from "./chain-values.ts";
import { deploymentRegistry } from "./deployment-registry.ts";
import type { OperatorAutomationDeployment } from "./operator-deployment.ts";
import {
  assertDeadlineCompletion,
  buildDeadlineCreation,
  type DeadlineCreationBuild,
  type UnsignedDeadlineTransaction,
} from "./deadline-creation.ts";

const fixtureUrl = new URL(
  "../../../contracts/fixtures/deadline_creation_v1.json",
  import.meta.url,
);

function operatorContract(byte: string, index = "0") {
  return {
    script: { codeHash: parseHash32(`0x${byte.repeat(64)}`), hashType: "data1" as const },
    cellDep: {
      outPoint: { txHash: parseHash32(`0x${byte.repeat(64)}`), index: `0x${index}` as const },
      depType: "code" as const,
    },
    binarySha256: byte.repeat(64),
    sizeBytes: 1,
  };
}

interface Fixture {
  readonly pledges: readonly {
    readonly tx_hash: string;
    readonly index: string;
    readonly refund_lock_hash: string;
    readonly amount: string;
  }[];
  readonly target: string;
  readonly deadline_block: string;
  readonly success_lock_hash: string;
  readonly cancel_lock_hash: string;
  readonly reward: string;
  readonly creator_nonce: string;
  readonly creation_fee: {
    readonly transaction_bytes: { readonly minimum: string; readonly maximum: string };
    readonly fee_rate_per_kilobyte: { readonly minimum: string; readonly maximum: string };
  };
  readonly expected: {
    readonly intent_hash: string;
    readonly campaign_id: string;
    readonly campaign_type_hash: string;
    readonly policy_script_hash: string;
    readonly payload_hash: string;
    readonly trigger_params_hash: string;
    readonly refund_commitment: string;
    readonly job_id: string;
    readonly campaign_data: string;
    readonly job_data: string;
    readonly witness_0: string;
    readonly raw_transaction: string;
  };
}

async function fixtureBuild(): Promise<{ fixture: Fixture; build: DeadlineCreationBuild }> {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Fixture;
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("fixture deployment is unavailable");
  const build = buildDeadlineCreation({
    deployment: loaded.deployment,
    pledges: fixture.pledges.map((pledge) => ({
      outPoint: parseOutPoint({ txHash: pledge.tx_hash, index: pledge.index }),
      refundLockHash: parseHash32(pledge.refund_lock_hash),
      amount: pledge.amount,
    })),
    target: fixture.target,
    deadlineBlock: fixture.deadline_block,
    successLockHash: parseHash32(fixture.success_lock_hash),
    cancelLockHash: parseHash32(fixture.cancel_lock_hash),
    reward: fixture.reward,
    creatorNonce: fixture.creator_nonce,
    creationFee: {
      transactionBytes: fixture.creation_fee.transaction_bytes,
      feeRatePerKilobyte: fixture.creation_fee.fee_rate_per_kilobyte,
    },
  });
  return { fixture, build };
}

test("deadline creation matches every byte-level fixture", async () => {
  const { fixture, build } = await fixtureBuild();
  assert.equal(build.intentHash, fixture.expected.intent_hash);
  assert.equal(build.campaignId, fixture.expected.campaign_id);
  assert.equal(build.intent.campaignTypeHash, fixture.expected.campaign_type_hash);
  assert.equal(build.intent.policyScriptHash, fixture.expected.policy_script_hash);
  assert.equal(build.intent.payloadHash, fixture.expected.payload_hash);
  assert.equal(build.intent.triggerParamsHash, fixture.expected.trigger_params_hash);
  assert.equal(build.intent.refundCommitment, fixture.expected.refund_commitment);
  assert.equal(build.jobId, fixture.expected.job_id);
  assert.equal(build.campaignData, fixture.expected.campaign_data);
  assert.equal(build.jobData, fixture.expected.job_data);
  assert.equal(build.transaction.witnesses[0], fixture.expected.witness_0);
  assert.equal(
    serializeRawTransaction(build.transaction as unknown as CKBComponents.RawTransaction),
    fixture.expected.raw_transaction,
  );
  assert.equal(build.intent.anchorOutPoint.txHash, fixture.pledges[1]?.tx_hash);
  assert.equal(build.transaction.outputs.length, 2);
  assert.equal(build.transaction.outputsData.length, 2);
});

test("wallet completion may append funding and change without changing commitments", async () => {
  const { build } = await fixtureBuild();
  const completed = {
    ...build.transaction,
    inputs: [
      ...build.transaction.inputs,
      {
        since: "0x0",
        previousOutput: { txHash: `0x${"cc".repeat(32)}`, index: "0x2" },
      },
    ],
    outputs: [
      ...build.transaction.outputs,
      {
        capacity: "0x174876e800",
        lock: build.transaction.outputs[0]?.lock,
        type: null,
      },
    ],
    outputsData: [...build.transaction.outputsData, "0x"],
    witnesses: [
      serializeWitnessArgs({
        lock: `0x${"00".repeat(65)}`,
        inputType: "",
        outputType: build.completion.requiredOutputType,
      }) as `0x${string}`,
    ],
  } as UnsignedDeadlineTransaction;
  assert.doesNotThrow(() => assertDeadlineCompletion(build, completed));

  const changedOutput = structuredClone(completed) as unknown as {
    outputs: { capacity: string }[];
  };
  const firstOutput = changedOutput.outputs[0];
  assert.ok(firstOutput);
  firstOutput.capacity = "0x1";
  assert.throws(
    () => assertDeadlineCompletion(build, changedOutput as unknown as UnsignedDeadlineTransaction),
    /changed committed output 0/,
  );
  assert.throws(
    () =>
      assertDeadlineCompletion(build, {
        ...completed,
        headerDeps: [parseHash32(`0x${"dd".repeat(32)}`)],
      } as UnsignedDeadlineTransaction),
    /changed transaction metadata/,
  );

  const equivalentInputEncoding = structuredClone(completed) as unknown as {
    inputs: { previousOutput: { index: string }; since: string }[];
  };
  const firstEquivalentInput = equivalentInputEncoding.inputs[0];
  assert.ok(firstEquivalentInput);
  firstEquivalentInput.previousOutput.index = "0x00";
  firstEquivalentInput.since = "0x00";
  assert.doesNotThrow(() =>
    assertDeadlineCompletion(
      build,
      equivalentInputEncoding as unknown as UnsignedDeadlineTransaction,
    ),
  );

  const equivalentDependencyEncoding = {
    ...completed,
    cellDeps: completed.cellDeps.map((dependency) => ({
      depType: dependency.depType,
      outPoint: {
        index: `0x0${BigInt(dependency.outPoint.index).toString(16)}`,
        txHash: dependency.outPoint.txHash,
      },
    })),
  } as unknown as UnsignedDeadlineTransaction;
  assert.doesNotThrow(() => assertDeadlineCompletion(build, equivalentDependencyEncoding));

  const changedInput = structuredClone(completed) as unknown as {
    inputs: { previousOutput: { txHash: string } }[];
  };
  const firstChangedInput = changedInput.inputs[0];
  assert.ok(firstChangedInput);
  firstChangedInput.previousOutput.txHash = `0x${"ee".repeat(32)}`;
  assert.throws(
    () => assertDeadlineCompletion(build, changedInput as unknown as UnsignedDeadlineTransaction),
    /changed required input outpoint or since at index 0/,
  );

  const removedDependency = {
    ...completed,
    cellDeps: completed.cellDeps.slice(1),
  } as UnsignedDeadlineTransaction;
  assert.throws(
    () => assertDeadlineCompletion(build, removedDependency),
    /removed a required cell dependency/,
  );
});

test("deadline creation rejects unsafe pledge and timing inputs", async () => {
  const { build } = await fixtureBuild();
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") return;
  const baseline = {
    deployment: loaded.deployment,
    pledges: [
      {
        outPoint: build.intent.anchorOutPoint,
        refundLockHash: build.intent.cancelLockHash,
        amount: "8000000000",
      },
    ],
    target: "15000000000",
    deadlineBlock: "500",
    successLockHash: build.intent.successLockHash,
    cancelLockHash: build.intent.cancelLockHash,
    reward: "10000000000",
    creatorNonce: "7",
    creationFee: {
      transactionBytes: { minimum: "700", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  } as const;
  assert.throws(() => buildDeadlineCreation({ ...baseline, deadlineBlock: "0" }), /deadlineBlock/);
  assert.throws(
    () =>
      buildDeadlineCreation({
        ...baseline,
        pledges: [{ ...baseline.pledges[0], amount: CONTRACT_MINIMUM_MINUS_ONE }],
      }),
    /future plain refund/,
  );
  assert.throws(
    () =>
      buildDeadlineCreation({ ...baseline, pledges: [...baseline.pledges, baseline.pledges[0]] }),
    /unique/,
  );
  assert.throws(
    () => buildDeadlineCreation({ ...baseline, successLockHash: baseline.cancelLockHash }),
    /recipient address must differ from the recovery address/,
  );
});

const CONTRACT_MINIMUM_MINUS_ONE = "6099999999";

test("operator-bound deadline creation uses the preferred window without changing V1", async () => {
  const { build: legacy } = await fixtureBuild();
  const loaded = await deploymentRegistry.load(legacy.intent.genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") return;
  const operator: OperatorAutomationDeployment = {
    genesisHash: loaded.deployment.genesisHash,
    manifestSha256: "a".repeat(64),
    secp256k1Blake160: loaded.deployment.manifest.secp256k1Blake160,
    contracts: {
      jobLock: operatorContract("1", "1"),
      deadlinePolicy: operatorContract("2", "2"),
      recurringPolicy: operatorContract("3", "3"),
    },
    defaultPreferredOperatorLockHash: parseHash32(`0x${"44".repeat(32)}`),
  };
  const bound = buildDeadlineCreation({
    deployment: loaded.deployment,
    pledges: [
      {
        outPoint: legacy.intent.anchorOutPoint,
        refundLockHash: legacy.intent.cancelLockHash,
        amount: "8000000000",
      },
    ],
    target: "8000000000",
    deadlineBlock: "500",
    successLockHash: legacy.intent.successLockHash,
    cancelLockHash: legacy.intent.cancelLockHash,
    reward: "10000000000",
    creatorNonce: "7",
    creationFee: {
      transactionBytes: { minimum: "700", maximum: "900" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
    operator: {
      deployment: operator,
      preferredExecutorLockHash: operator.defaultPreferredOperatorLockHash,
    },
  });
  assert.equal(bound.intent.version, 2);
  assert.equal(bound.intent.takeoverBlock, "512");
  assert.equal(
    bound.transaction.outputs[1]?.lock.codeHash,
    operator.contracts.jobLock.script.codeHash,
  );
  assert.equal(
    bound.transaction.outputs[1]?.type?.codeHash,
    operator.contracts.deadlinePolicy.script.codeHash,
  );
  assert.equal(legacy.intent.version, 1);
  assert.equal(legacy.intent.takeoverBlock, undefined);
});
