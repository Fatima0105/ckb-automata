import assert from "node:assert/strict";
import test from "node:test";

import type { LoggerService } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { WitnessArgs } from "@ckb-ccc/shell";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import testnetManifest from "../../../deploy/manifests/testnet.json" with { type: "json" };
import {
  buildDaoHarvestExecutorRotation,
  createDeploymentRegistry,
  deploymentRegistry,
  hashDeploymentManifest,
  parseHash32,
  parseOutPoint,
  registeredDaoHarvestDeployment,
  type ResolvedLiveCell,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";

import { createApiApplication } from "./bootstrap.ts";
import {
  DAO_HARVEST_READ_STATES,
  DaoHarvestMutationService,
  DaoHarvestPendingService,
  DaoHarvestReadService,
  DaoHarvestTransactionAdapter,
} from "./dao-harvest.ts";
import { DaoHarvestV2MutationService, DaoHarvestV2PendingService } from "./dao-harvest-v2.ts";
import {
  DaoHarvestProjectionStore,
  extractDaoHarvestProjections,
} from "./indexer/dao-harvest-projection.ts";

const quietLogger: LoggerService = {
  log: () => undefined,
  fatal: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

function environment() {
  return {
    AUTOMATA_PROFILE: "local",
    CKB_NETWORK: "ckb_dev",
    CKB_GENESIS_HASH: "0x5a7b2eb5a3aa224edb367eb7aba742c6f60efaddb6b9536ab2a2c20e0af6cff3",
    CKB_RPC_URL: "http://127.0.0.1:58114",
    CKB_INDEXER_URL: "http://127.0.0.1:58116",
    DATABASE_URL: "postgresql://automata:test@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

test("DAO harvest API publishes read, quote, and unsigned mutation routes", async () => {
  const { app } = await createApiApplication(environment(), { logger: quietLogger });
  try {
    await app.init();
    const document = SwaggerModule.createDocument(app, new DocumentBuilder().build());
    for (const path of [
      "/v1/dao-harvest",
      "/v1/dao-harvest/{jobId}",
      "/v1/dao-harvest/{jobId}/quote",
      "/v1/dao-harvest/setup",
      "/v1/dao-harvest/stop",
      "/v1/dao-harvest/exit",
      "/v1/dao-harvest/recover",
      "/v1/dao-harvest/register-setup",
    ]) {
      assert.ok(document.paths[path], `missing OpenAPI path ${path}`);
    }
    for (const path of [
      "/v1/dao-harvest-v2",
      "/v1/dao-harvest-v2/{jobId}",
      "/v1/dao-harvest-v2/{jobId}/quote",
      "/v1/dao-harvest-v2/setup",
      "/v1/dao-harvest-v2/sweep",
      "/v1/dao-harvest-v2/close",
      "/v1/dao-harvest-v2/rotate",
      "/v1/dao-harvest-v2/recover",
    ]) {
      assert.ok(document.paths[path], `missing OpenAPI path ${path}`);
    }
    const schema = document.paths["/v1/dao-harvest/{jobId}"]?.get?.responses?.["200"];
    assert.match(JSON.stringify(schema), /principal/);
    assert.match(JSON.stringify(schema), /prepareStartSince/);
    const listSchema = document.paths["/v1/dao-harvest"]?.get?.responses?.["200"];
    assert.match(JSON.stringify(listSchema), /pendingItems/);
    const v2DetailSchema = document.paths["/v1/dao-harvest-v2/{jobId}"]?.get?.responses?.["200"];
    assert.match(JSON.stringify(v2DetailSchema), /availableToWithdraw/);
    assert.match(JSON.stringify(v2DetailSchema), /operatorWindow/);
    assert.match(JSON.stringify(v2DetailSchema), /serviceSettlement/);
    assert.match(JSON.stringify(v2DetailSchema), /blockNumber/);
    const fastify = app.getHttpAdapter().getInstance() as {
      inject(input: {
        method: string;
        url: string;
      }): Promise<{ statusCode: number; json(): unknown }>;
    };
    const invalidV2Query = await fastify.inject({
      method: "GET",
      url: "/v1/dao-harvest-v2?limit=0",
    });
    assert.equal(invalidV2Query.statusCode, 400);
    assert.deepEqual(invalidV2Query.json(), {
      status: "invalid_request",
      code: "INVALID_DAO_HARVEST_V2_QUERY",
      message: "limit must be a positive integer",
    });
  } finally {
    await app.close();
  }
});

test("V2 pending reconciliation survives status outages without claiming confirmation", async () => {
  let fail = true;
  const service = new DaoHarvestV2PendingService({
    list: async () => [
      {
        transactionHash: `0x${"a".repeat(64)}`,
        submittedAt: new Date("2026-01-01T00:00:00.000Z"),
        lastKnownStatus: "submitted",
      },
    ],
    status: async () => {
      if (fail) throw new Error("temporary status outage");
      return "confirmed";
    },
  });
  assert.deepEqual(await service.list(), [
    {
      transactionHash: `0x${"a".repeat(64)}`,
      submittedAt: "2026-01-01T00:00:00.000Z",
      status: "submitting",
      lastKnownStatus: "submitted",
    },
  ]);
  fail = false;
  assert.deepEqual(await service.list(), []);
});

test("V2 build endpoints fail closed until a chain-aware adapter is deployed", async () => {
  const unavailable = new DaoHarvestV2MutationService();
  assert.throws(() => unavailable.build("setup", {}), /not deployed/);
  const available = new DaoHarvestV2MutationService({
    build: async (operation) => ({
      version: 2,
      operation,
      transaction: {},
      intentHash: `0x${"b".repeat(64)}`,
      payloadHash: `0x${"c".repeat(64)}`,
      progressHash: `0x${"d".repeat(64)}`,
      prepareCreditHash: `0x${"0".repeat(64)}`,
      review: {
        originalAmount: "1000",
        expectedCompensation: "10",
        completedWorkCharges: { prepare: "1", claim: "1", maximumTotal: "2" },
        maximumNetworkFee: "1",
        recoverableReserve: "100",
        accumulatedCompensation: "0",
        totalLockedAmount: "1100",
        notes: [],
      },
      completion: {
        requiredInputCount: 1,
        requiredOutputCount: 3,
        requiredInputCapacity: "1101",
        maximumFee: "1",
        allowedFundingLockHashes: [`0x${"e".repeat(64)}`],
      },
    }),
  });
  assert.equal((await available.build("rotate", {})).operation, "rotate");
});

test("mutation service cannot sign, broadcast, or build before deployment registration", () => {
  const service = new DaoHarvestMutationService();
  assert.throws(() => service.build("setup", {}), /not deployed/);
  assert.deepEqual(DAO_HARVEST_READ_STATES, [
    "deposited",
    "withdrawing",
    "claim_ready",
    "completed",
    "recovery_required",
  ]);
});

test("active deployment builds an exact unsigned setup and rejects understated funding", async () => {
  const ownerLock = {
    codeHash: parseHash32(`0x${"01".repeat(32)}`),
    hashType: "type" as const,
    args: "0x1111" as const,
  };
  const payoutLock = {
    codeHash: parseHash32(`0x${"02".repeat(32)}`),
    hashType: "type" as const,
    args: "0x2222" as const,
  };
  const ownerLockHash = parseHash32(scriptToHash(ownerLock));
  const payoutLockHash = parseHash32(scriptToHash(payoutLock));
  const remembered: unknown[] = [];
  const manifest = structuredClone(testnetManifest) as Record<string, unknown>;
  manifest["daoHarvest"] = {
    deployment: { transactionHash: `0x${"b".repeat(64)}`, blockHash: `0x${"c".repeat(64)}` },
    contracts: {
      "harvest-vault-lock": {
        codeHash: "0xa4693f462087a7e980817a7769224a11d1f4e3025f8aa97f1b49d724c4d7ae32",
        hashType: "data1",
        cellDep: {
          outPoint: { txHash: `0x${"b".repeat(64)}`, index: "0x0" },
          depType: "code",
        },
        binarySha256: "b543f869868c94bb56552f074c7d40ea32faf5b8ad1abd4b3e72d7c20f141b08",
        sizeBytes: 15_336,
      },
      "dao-harvest-policy": {
        codeHash: "0xa3ffba9aa6a33bc9cdbba5a6d9e9a103074fe2ae23635bc094c0bc214b01301c",
        hashType: "data1",
        cellDep: {
          outPoint: { txHash: `0x${"b".repeat(64)}`, index: "0x1" },
          depType: "code",
        },
        binarySha256: "9d8b781493c4cf8f8479468766a300d7cfef69495b830963a190203d7e5b6c69",
        sizeBytes: 41_304,
      },
    },
    nervosDao: {
      codeHash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
      hashType: "type",
      cellDep: {
        outPoint: {
          txHash: "0x8f8c79eb6671709633fe6a46de93c0fedc9c1b8a6527a18d3983879542635c9f",
          index: "0x2",
        },
        depType: "code",
      },
    },
    prepareExecutorLockHashes: [`0x${"d".repeat(64)}`],
  };
  const manifestSha256 = await hashDeploymentManifest(manifest);
  const registry = createDeploymentRegistry([
    {
      genesisHash: testnetManifest.genesisHash,
      manifestSha256,
      manifest,
      confirmationDepth: 5,
    },
  ]);
  const adapter = new DaoHarvestTransactionAdapter(
    {
      getTipHeader: async () =>
        ({
          dao: {
            c: 6_389_163_654_073_961_728n,
            ar: 11_922_919_488_376_595n,
            s: 749_970_336_604_435_714n,
            u: 682_750_630_500_000_000n,
          },
          epoch: { integer: 13_920n, numerator: 1_151n, denominator: 1_800n },
          hash: `0x${"e".repeat(64)}`,
          number: 22_583_952n,
        }) as never,
    },
    testnetManifest.genesisHash,
    { remember: async (locks) => void remembered.push(...locks) },
    registry,
  );
  const result = await adapter.build("setup", {
    ownerLockHash,
    payoutLockHash,
    principal: "24200000000",
    totalCycles: 1,
    lockResolutions: [ownerLock, payoutLock],
  });
  const transaction = result.transaction as UnsignedDeadlineTransaction;
  assert.equal(result.operation, "setup");
  assert.match(result.jobId ?? "", /^0x[0-9a-f]{64}$/);
  assert.equal(transaction.inputs.length, 0);
  assert.equal(BigInt(transaction.outputs[0]!.capacity), 24_200_000_000n);
  assert.equal(BigInt(transaction.outputs[1]!.capacity), 50_300_000_000n);
  assert.equal(transaction.cellDeps.length, 5);
  assert.deepEqual(remembered, [ownerLock, payoutLock]);

  const sameAddressResult = await adapter.build("setup", {
    ownerLockHash,
    payoutLockHash: ownerLockHash,
    principal: "24200000000",
    totalCycles: 1,
    lockResolutions: [ownerLock, ownerLock],
  });
  assert.equal(sameAddressResult.operation, "setup");
  assert.deepEqual(remembered.slice(-2), [ownerLock, ownerLock]);

  await assert.rejects(
    adapter.build("setup", {
      ownerLockHash,
      payoutLockHash,
      principal: "24200000000",
      totalCycles: 1,
      lockResolutions: [ownerLock, ownerLock],
    }),
    /match the owner and payout hashes/,
  );

  const registered = await registry.load(testnetManifest.genesisHash);
  assert.equal(registered.status, "ok");
  if (registered.status !== "ok") throw new Error("test deployment is unavailable");
  const projected = extractDaoHarvestProjections(
    {
      header: {
        epoch: { integer: 13_920n, numerator: 1_152n, denominator: 1_800n },
        hash: `0x${"ab".repeat(32)}`,
        number: 22_583_953n,
      },
      transactions: [
        {
          hash: () => `0x${"cd".repeat(32)}`,
          outputs: transaction.outputs.map((output) => ({
            ...output,
            capacity: BigInt(output.capacity),
            type: output.type ?? undefined,
          })),
          outputsData: transaction.outputsData,
          witnesses: transaction.witnesses,
        },
      ],
    } as never,
    registeredDaoHarvestDeployment(registered.deployment),
  );
  assert.equal(projected.malformed, 0);
  assert.equal(projected.projections.length, 1);
  assert.equal(projected.projections[0]?.jobId, result.jobId);
  assert.equal(projected.projections[0]?.principalCapacity, 24_200_000_000n);
  assert.equal(projected.projections[0]?.vaultState, "deposited");
  const setupHash = `0x${"cd".repeat(32)}`;
  const ownerHash = `0x${"ef".repeat(32)}`;
  const vaultOutPoint = parseOutPoint({ txHash: setupHash, index: 0n });
  const jobOutPoint = parseOutPoint({ txHash: setupHash, index: 1n });
  const ownerOutPoint = parseOutPoint({ txHash: ownerHash, index: 0n });
  const outputType = WitnessArgs.fromBytes(transaction.witnesses[0]!).outputType;
  assert.ok(outputType);
  const envelope = hexToBytes(outputType);
  const payloadSize = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(0, true);
  const payload = bytesToHex(envelope.slice(0, payloadSize)) as `0x${string}`;
  const stopQuery = {
    from: () => stopQuery,
    innerJoin: () => stopQuery,
    where: () => stopQuery,
    limit: async () => [
      {
        jobTxHash: setupHash,
        jobIndex: "1",
        ownerLockHash,
        payload: Buffer.from(payload.slice(2), "hex"),
      },
    ],
  };
  const stopAdapter = new DaoHarvestTransactionAdapter(
    {
      getTipHeader: async () => assert.fail("stop must not request a setup quote"),
      getCellLive: async () => ({
        outPoint: jobOutPoint,
        cellOutput: {
          capacity: BigInt(transaction.outputs[1]!.capacity),
          lock: transaction.outputs[1]!.lock,
          type: transaction.outputs[1]!.type ?? undefined,
        },
        outputData: transaction.outputsData[1]!,
      }),
    } as never,
    testnetManifest.genesisHash,
    { remember: async () => undefined },
    registry,
    { select: () => stopQuery } as never,
    registered.deployment.network,
  );
  const stop = await stopAdapter.build("stop", { jobId: result.jobId, ownerLock });
  const stopWitness = WitnessArgs.fromBytes(stop.transaction.witnesses[0]!);
  assert.equal(stop.operation, "stop");
  assert.equal(stop.transaction.inputs.length, 1);
  assert.equal(stopWitness.inputType, "0x01");
  assert.equal(stopWitness.outputType, payload);
  const liveCells = new Map<string, ResolvedLiveCell>([
    [
      `${vaultOutPoint.txHash}:${vaultOutPoint.index}`,
      {
        outPoint: vaultOutPoint,
        output: transaction.outputs[0]!,
        data: transaction.outputsData[0]!,
      },
    ],
    [
      `${jobOutPoint.txHash}:${jobOutPoint.index}`,
      {
        outPoint: jobOutPoint,
        output: transaction.outputs[1]!,
        data: transaction.outputsData[1]!,
      },
    ],
    [
      `${ownerOutPoint.txHash}:${ownerOutPoint.index}`,
      {
        outPoint: ownerOutPoint,
        output: { capacity: 10_000_000_000n, lock: ownerLock, type: null },
        data: "0x" as const,
      },
    ],
  ]);
  const rotation = await buildDaoHarvestExecutorRotation({
    deployment: registeredDaoHarvestDeployment(registered.deployment),
    expectedGenesisHash: registered.deployment.genesisHash,
    resolver: {
      resolve: async (outPoint) => liveCells.get(`${outPoint.txHash}:${outPoint.index}`) ?? null,
    },
    vaultOutPoint,
    jobOutPoint,
    ownerOutPoint,
    ownerLock,
    ownerLockHash,
    payload,
    prepareExecutorLockHashes: [parseHash32(`0x${"f0".repeat(32)}`)],
  });
  const rotated = extractDaoHarvestProjections(
    {
      header: {
        epoch: { integer: 13_920n, numerator: 1_153n, denominator: 1_800n },
        hash: `0x${"ac".repeat(32)}`,
        number: 22_583_954n,
      },
      transactions: [
        {
          hash: () => `0x${"ce".repeat(32)}`,
          inputs: rotation.transaction.inputs,
          outputs: rotation.transaction.outputs.map((output) => ({
            ...output,
            capacity: BigInt(output.capacity),
            type: output.type ?? undefined,
          })),
          outputsData: rotation.transaction.outputsData,
          witnesses: rotation.transaction.witnesses,
        },
      ],
    } as never,
    registeredDaoHarvestDeployment(registered.deployment),
  );
  assert.equal(rotated.malformed, 0);
  assert.equal(rotated.projections.length, 0);
  assert.equal(rotated.rotations.length, 1);
  assert.equal(rotated.rotations[0]?.jobId, result.jobId);
  assert.notEqual(rotated.rotations[0]?.payload, payload);
  const transactionHash = `0x${"cd".repeat(32)}`;
  let inserted: Record<string, unknown> | undefined;
  const pending = new DaoHarvestPendingService(
    {
      insert: () => ({
        values: (value: Record<string, unknown>) => ({
          onConflictDoNothing: async () => {
            inserted = value;
          },
        }),
      }),
    } as never,
    "ckb_testnet",
    testnetManifest.genesisHash,
    {
      getTipHeader: async () =>
        ({
          dao: {
            c: 6_389_163_654_073_961_728n,
            ar: 11_922_919_488_376_595n,
            s: 749_970_336_604_435_714n,
            u: 682_750_630_500_000_000n,
          },
          epoch: { integer: 13_920n, numerator: 1_152n, denominator: 1_800n },
          hash: `0x${"ab".repeat(32)}`,
          number: 22_583_953n,
        }) as never,
      getTransactionStatus: async () =>
        ({
          status: "committed" as const,
          transaction: { ...transaction, hash: () => transactionHash },
        }) as never,
    },
    {
      read: async () => ({
        block: { hash: `0x${"ab".repeat(32)}`, number: "22583953" },
        confirmations: "3",
        observedAt: "2026-10-06T00:00:00.000Z",
        reason: null,
        requiredConfirmations: 5,
        state: "committed" as const,
        transactionHash,
      }),
    } as never,
    registry,
  );
  const registeredPending = await pending.register({ transactionHash });
  assert.equal(registeredPending.jobId, result.jobId);
  assert.equal(registeredPending.status, "confirming");
  assert.equal(registeredPending.confirmations, "3");
  assert.equal(inserted?.["txHash"], transactionHash);
  assert.deepEqual(inserted?.["simulation"], {
    kind: "pending_dao_harvest",
    jobId: result.jobId,
    ownerLockHash,
    payoutLockHash,
    principal: "24200000000",
    totalCycles: "1",
  });
  await assert.rejects(
    adapter.build("setup", {
      ownerLockHash,
      payoutLockHash,
      principal: "24199999999",
      totalCycles: 1,
      lockResolutions: [ownerLock, payoutLock],
    }),
    /at least 242 CKB/,
  );
  await assert.rejects(
    adapter.build("setup", {
      ownerLockHash,
      payoutLockHash,
      principal: "24200000000",
      totalCycles: 1,
      lockResolutions: [ownerLock, payoutLock],
      extra: true,
    }),
    /unsupported fields/,
  );
});

test("DAO harvest reads expose pending submissions before canonical indexing", async () => {
  const pendingItem = {
    jobId: `0x${"11".repeat(32)}`,
    ownerLockHash: `0x${"22".repeat(32)}`,
    payoutLockHash: `0x${"33".repeat(32)}`,
    principal: "21000000000",
    progress: { completedCycles: "0" as const, totalCycles: "1" },
    status: "confirming" as const,
    confirmations: "2",
    requiredConfirmations: 5,
    submittedAt: "2026-10-06T00:00:00.000Z",
    transactionHash: `0x${"44".repeat(32)}`,
  };
  const builder = {
    from: () => builder,
    innerJoin: () => builder,
    where: () => builder,
    orderBy: () => builder,
    limit: async () => [],
  };
  const reads = new DaoHarvestReadService({ select: () => builder } as never, "ckb_testnet", {
    list: async () => [pendingItem],
  });
  const result = await reads.list({ limit: 20 });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.pendingItems, [pendingItem]);
});

test("DAO harvest consumption discovery uses one candidate query per block", async () => {
  const registered = await deploymentRegistry.load(testnetManifest.genesisHash);
  assert.equal(registered.status, "ok");
  if (registered.status !== "ok") throw new Error("testnet deployment is unavailable");

  let candidateQueries = 0;
  let transactions = 0;
  const database = {
    transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
      transactions += 1;
      return callback({
        execute: async () => undefined,
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              where: async () => {
                candidateQueries += 1;
                return [];
              },
            }),
          }),
        }),
      });
    },
  };
  const inputs = Array.from({ length: 50 }, (_, index) => ({
    previousOutput: {
      txHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
      index: BigInt(index % 2),
    },
  }));
  const result = await new DaoHarvestProjectionStore(database as never).projectBlock(
    {
      header: {
        epoch: 0n,
        hash: `0x${"ab".repeat(32)}`,
        number: 22_584_000n,
      },
      transactions: [
        {
          hash: () => `0x${"cd".repeat(32)}`,
          inputs,
          outputs: [],
          outputsData: [],
          witnesses: [],
        },
      ],
    } as never,
    registered.deployment,
  );

  assert.equal(result.persisted, 0);
  assert.equal(transactions, 1);
  assert.equal(candidateQueries, 1);
});
