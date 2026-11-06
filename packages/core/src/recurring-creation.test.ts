import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { serializeRawTransaction, serializeWitnessArgs } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, parseOutPoint } from "./chain-values.ts";
import { deploymentRegistry } from "./deployment-registry.ts";
import type { RegisteredDeployment } from "./deployment-registry.ts";
import type { OperatorAutomationDeployment } from "./operator-deployment.ts";
import type { UnsignedDeadlineTransaction as UnsignedTransaction } from "./deadline-creation.ts";
import {
  assertRecurringCompletion,
  buildRecurringCreation,
  reconstructRecurringDisplayIntent,
  type RecurringCreationBuild,
} from "./recurring-creation.ts";

const fixtureUrl = new URL(
  "../../../contracts/fixtures/recurring_creation_v1.json",
  import.meta.url,
);

function operatorContract(byte: string) {
  return {
    script: { codeHash: parseHash32(`0x${byte.repeat(64)}`), hashType: "data1" as const },
    cellDep: {
      outPoint: { txHash: parseHash32(`0x${byte.repeat(64)}`), index: "0x0" as const },
      depType: "code" as const,
    },
    binarySha256: byte.repeat(64),
    sizeBytes: 1,
  };
}

interface Fixture {
  readonly owner_lock_hash: string;
  readonly recipient_lock_hash: string;
  readonly amount: string;
  readonly interval_blocks: string;
  readonly first_not_before: string;
  readonly total_runs: string;
  readonly reward: string;
  readonly creator_nonce: string;
  readonly creation_fee: {
    readonly transaction_bytes: { readonly minimum: string; readonly maximum: string };
    readonly fee_rate_per_kilobyte: { readonly minimum: string; readonly maximum: string };
  };
  readonly expected: {
    readonly policy_script_hash: string;
    readonly payload_hash: string;
    readonly intent_hash: string;
    readonly job_id: string;
    readonly recurring_payload: string;
    readonly job_data: string;
    readonly raw_transaction: string;
  };
}

async function fixtureBuild(): Promise<{
  fixture: Fixture;
  build: RecurringCreationBuild;
  deployment: RegisteredDeployment;
}> {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8")) as Fixture;
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") throw new Error("fixture deployment is unavailable");
  return {
    fixture,
    deployment: loaded.deployment,
    build: buildRecurringCreation({
      deployment: loaded.deployment,
      ownerLockHash: parseHash32(fixture.owner_lock_hash),
      recipientLockHash: parseHash32(fixture.recipient_lock_hash),
      amount: fixture.amount,
      intervalBlocks: fixture.interval_blocks,
      firstNotBefore: fixture.first_not_before,
      totalRuns: fixture.total_runs,
      reward: fixture.reward,
      creatorNonce: fixture.creator_nonce,
      creationFee: {
        transactionBytes: fixture.creation_fee.transaction_bytes,
        feeRatePerKilobyte: fixture.creation_fee.fee_rate_per_kilobyte,
      },
    }),
  };
}

test("recurring creation matches the expected policy and transaction bytes", async () => {
  const { fixture, build, deployment } = await fixtureBuild();
  assert.equal(build.intent.policyScriptHash, fixture.expected.policy_script_hash);
  assert.equal(build.intent.payloadHash, fixture.expected.payload_hash);
  assert.equal(build.intentHash, fixture.expected.intent_hash);
  assert.equal(build.jobId, fixture.expected.job_id);
  assert.equal(build.recurringPayload, fixture.expected.recurring_payload);
  assert.equal(build.jobData, fixture.expected.job_data);
  assert.equal(
    serializeRawTransaction(build.transaction as unknown as CKBComponents.RawTransaction),
    fixture.expected.raw_transaction,
  );
  assert.deepEqual(
    reconstructRecurringDisplayIntent(build.transaction, deployment),
    build.displayIntent,
  );
});

test("wallet funding inputs and change preserve the recurring intent", async () => {
  const { build } = await fixtureBuild();
  assert.throws(
    () => assertRecurringCompletion(build, build.transaction),
    /did not add a funding input/,
  );
  const completed = {
    ...build.transaction,
    inputs: [
      {
        since: "0x0",
        previousOutput: {
          txHash: parseOutPoint({ txHash: `0x${"aa".repeat(32)}`, index: "0" }).txHash,
          index: "0x0",
        },
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
  } as UnsignedTransaction;
  assert.doesNotThrow(() => assertRecurringCompletion(build, completed));
  assert.doesNotThrow(() =>
    assertRecurringCompletion(build, {
      ...completed,
      cellDeps: completed.cellDeps.map((dependency) => ({
        depType: dependency.depType,
        outPoint: {
          index: `0x0${BigInt(dependency.outPoint.index).toString(16)}`,
          txHash: dependency.outPoint.txHash,
        },
      })),
    }),
  );
  assert.throws(
    () =>
      assertRecurringCompletion(build, {
        ...completed,
        cellDeps: completed.cellDeps.slice(1),
      }),
    /removed a required cell dependency/,
  );
  assert.throws(
    () =>
      assertRecurringCompletion(build, {
        ...completed,
        outputsData: ["0x", ...completed.outputsData.slice(1)],
      }),
    /changed the recurring Job Cell/,
  );
});

test("recurring creation rejects unpayable or overflowing schedules", async () => {
  const { build } = await fixtureBuild();
  const [genesisHash] = deploymentRegistry.genesisHashes;
  assert.ok(genesisHash);
  const loaded = await deploymentRegistry.load(genesisHash);
  assert.equal(loaded.status, "ok");
  if (loaded.status !== "ok") return;
  const baseline = {
    deployment: loaded.deployment,
    ownerLockHash: build.displayIntent.ownerLockHash,
    recipientLockHash: build.displayIntent.recipientLockHash,
    amount: "10000000000",
    intervalBlocks: "100",
    firstNotBefore: "500",
    totalRuns: "3",
    reward: "10000000000",
    creatorNonce: "9",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "800" },
      feeRatePerKilobyte: { minimum: "1000", maximum: "2000" },
    },
  } as const;
  assert.throws(() => buildRecurringCreation({ ...baseline, totalRuns: "0" }), /unsupported/);
  assert.throws(
    () =>
      buildRecurringCreation({
        ...baseline,
        firstNotBefore: ((1n << 56n) - 50n).toString(),
      }),
    /absolute block-number range/,
  );
  assert.throws(
    () => buildRecurringCreation({ ...baseline, amount: "6099999999" }),
    /plain output minimum/,
  );
});

test("operator-bound recurring creation commits preferred and takeover blocks", async () => {
  const { build: legacy, deployment } = await fixtureBuild();
  const operator: OperatorAutomationDeployment = {
    genesisHash: deployment.genesisHash,
    manifestSha256: "a".repeat(64),
    secp256k1Blake160: deployment.manifest.secp256k1Blake160,
    contracts: {
      jobLock: operatorContract("4"),
      deadlinePolicy: operatorContract("5"),
      recurringPolicy: operatorContract("6"),
    },
    defaultPreferredOperatorLockHash: parseHash32(`0x${"77".repeat(32)}`),
  };
  const bound = buildRecurringCreation({
    deployment,
    ownerLockHash: legacy.displayIntent.ownerLockHash,
    recipientLockHash: legacy.displayIntent.recipientLockHash,
    amount: "10000000000",
    intervalBlocks: "100",
    firstNotBefore: "500",
    totalRuns: "3",
    reward: "10000000000",
    creatorNonce: "9",
    creationFee: {
      transactionBytes: { minimum: "500", maximum: "800" },
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
    bound.transaction.outputs[0]?.lock.codeHash,
    operator.contracts.jobLock.script.codeHash,
  );
  assert.equal(
    bound.transaction.outputs[0]?.type?.codeHash,
    operator.contracts.recurringPolicy.script.codeHash,
  );
  assert.equal(legacy.intent.version, 1);
});
