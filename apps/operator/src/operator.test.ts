import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PERSONAL,
  ECPair,
  blake160,
  blake2b,
  bytesToHex,
  hexToBytes,
  scriptToHash,
  rawTransactionToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  DAO_HARVEST_V2_ABSENT_INDEX,
  DAO_HARVEST_V2_OPERATIONS,
  createEpoch,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  encodeAbsoluteEpochSince,
  encodeRelativeEpochSince,
  packEpoch,
  parseHash32,
  parseOutputIndex,
  type Hash32,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";
import {
  DaoHarvestEnvelopeV2,
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
  JobDataV1,
} from "@ckb-automata/molecule";

import { parseOperatorConfiguration } from "./config.ts";
import { discoverHarvestV2Jobs, discoverPaymentJobs } from "./discovery.ts";
import { loadAutomationManifest, verifyAutomationManifest } from "./automation-manifest.ts";
import { loadOperatorManifest, verifyOperatorManifest, type OperatorManifest } from "./manifest.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { startOperatorServer } from "./server.ts";
import {
  dryRunFallbackClaim,
  submitFallbackClaim,
  type OperatorExecutionBundle,
} from "./transaction.ts";
import { buildFallbackClaimBundle, provisionOperatorAccumulator } from "./workflow.ts";

const hash = (value: string): Hash32 => `0x${value.repeat(64).slice(0, 64)}` as Hash32;
const bytes = (value: Hash32): Uint8Array => hexToBytes(value);
const epoch = (number: number) =>
  createEpoch({
    number: number.toString(),
    index: "0",
    length: "0",
  });
const absolute = (number: number) => encodeAbsoluteEpochSince(epoch(number)).toString();
const absoluteHex = (number: number): `0x${string}` =>
  `0x${encodeAbsoluteEpochSince(epoch(number)).toString(16)}`;
const relative = (number: number) => encodeRelativeEpochSince(epoch(number)).toString();
const script = (value: string): ScriptIdentity => ({
  codeHash: hash(value),
  hashType: "data1",
  args: "0x",
});

function witnessInputType(value: `0x${string}`): Uint8Array {
  const raw = hexToBytes(value);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const second = view.getUint32(8, true);
  const third = view.getUint32(12, true);
  return raw.slice(second + 4, third);
}

class RpcFixture implements JsonRpcClient {
  readonly calls: { method: string; params: readonly unknown[] }[] = [];
  readonly #responses: Readonly<
    Record<string, unknown | ((params: readonly unknown[]) => unknown)>
  >;

  constructor(
    responses: Readonly<Record<string, unknown | ((params: readonly unknown[]) => unknown)>>,
  ) {
    this.#responses = responses;
  }

  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    const response = this.#responses[method];
    if (response === undefined) throw new Error(`unexpected RPC method ${method}`);
    return (typeof response === "function" ? response(params) : response) as T;
  }
}

function ckbHash(value: Uint8Array): Hash32 {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(value);
  return `0x${hasher.digest("hex")}` as Hash32;
}

function manifestContract(value: string) {
  const binary = Uint8Array.from([Number.parseInt(value, 16), 2, 3]);
  return {
    binary,
    value: {
      codeHash: ckbHash(binary),
      hashType: "data1",
      binarySha256: createHash("sha256").update(binary).digest("hex"),
      sizeBytes: binary.length,
      cellDep: {
        outPoint: { txHash: hash(value), index: "0x0" },
        depType: "code",
      },
    },
  } as const;
}

async function manifestFixture() {
  const contracts = {
    jobLock: manifestContract("1"),
    policy: manifestContract("2"),
    vaultLock: manifestContract("3"),
    compensationLock: manifestContract("4"),
  };
  const json = {
    schemaVersion: 2,
    releaseVersion: "0.2.0",
    network: "ckb_testnet",
    genesisHash: hash("a"),
    sourceRevision: "b".repeat(40),
    predecessorManifests: [],
    secp256k1Blake160: {
      codeHash: hash("e"),
      hashType: "type",
      cellDep: { outPoint: { txHash: hash("e"), index: "0x0" }, depType: "depGroup" },
    },
    nervosDao: {
      codeHash: hash("d"),
      hashType: "type",
      cellDep: { outPoint: { txHash: hash("d"), index: "0x0" }, depType: "code" },
    },
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([name, item]) => [name, item.value]),
    ),
    operators: {
      preferredPrepareLockHash: hash("a"),
      fallbackPrepareLockHashes: [hash("b")],
    },
  };
  const directory = await mkdtemp(join(tmpdir(), "ckautomata-operator-"));
  const path = join(directory, "manifest.json");
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
  return { directory, path, contracts };
}

async function automationManifestFixture() {
  const contracts = {
    jobLock: manifestContract("5"),
    deadlinePolicy: manifestContract("6"),
    recurringPolicy: manifestContract("7"),
  };
  const json = {
    schemaVersion: 1,
    releaseVersion: "0.3.0",
    network: "ckb_testnet",
    genesisHash: hash("a"),
    sourceRevision: "b".repeat(40),
    secp256k1Blake160: {
      cellDep: { outPoint: { txHash: hash("e"), index: "0x0" }, depType: "depGroup" },
    },
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([name, item]) => [name, item.value]),
    ),
    defaultPreferredOperatorLockHash: hash("9"),
  };
  const directory = await mkdtemp(join(tmpdir(), "ckautomata-payment-operator-"));
  const path = join(directory, "manifest.json");
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`);
  return { directory, path, contracts };
}

test("configuration is public-RPC only and redacts the signing key", () => {
  const config = parseOperatorConfiguration(
    {
      CKB_RPC_URL: "https://rpc.example/",
      CKB_INDEXER_URL: "https://indexer.example/",
      CKB_GENESIS_HASH: hash("a"),
      OPERATOR_MANIFEST_PATH: "manifest.json",
      OPERATOR_PRIVATE_KEY: `0x${"1".repeat(64)}`,
    },
    "C:/operator",
  );
  assert.equal(config.rpcUrl, "https://rpc.example/");
  assert.equal(config.privateKey, `0x${"1".repeat(64)}`);
  assert.equal("DATABASE_URL" in config, false);
  assert.equal("REDIS_URL" in config, false);
});

test("a payment-only operator does not require a Harvest manifest", () => {
  const config = parseOperatorConfiguration(
    {
      CKB_RPC_URL: "https://rpc.example/",
      CKB_INDEXER_URL: "https://indexer.example/",
      OPERATOR_AUTOMATION_MANIFEST_PATH: "payments.json",
    },
    "C:/operator",
  );
  assert.equal(config.manifestPath, undefined);
  assert.equal(config.automationManifestPath, "C:\\operator\\payments.json");
});

test("payment manifest verification and discovery cover scheduled and recurring jobs", async () => {
  const fixture = await automationManifestFixture();
  try {
    const loaded = await loadAutomationManifest(fixture.path);
    const byOutPoint = new Map(
      Object.values(fixture.contracts).map((item) => [
        item.value.cellDep.outPoint.txHash,
        item.binary,
      ]),
    );
    const rpc = new RpcFixture({
      get_block_hash: hash("a"),
      get_live_cell: (params: readonly unknown[]) => {
        const point = params[0] as { tx_hash: string };
        return {
          status: "live",
          cell: { data: { content: bytesToHex(byOutPoint.get(parseHash32(point.tx_hash))!) } },
        };
      },
    });
    assert.equal((await verifyAutomationManifest(loaded, rpc)).status, "verified");
    const job = JobDataV1.pack({
      version: 1,
      flags: 0,
      job_id: [...bytes(hash("8"))],
      sequence: 0,
      state: 0,
      trigger_kind: 1,
      trigger_params_hash: [...bytes(hash("1"))],
      policy_script_hash: [...bytes(hash("2"))],
      payload_hash: [...bytes(hash("3"))],
      reward: 100,
      remaining_budget: 200,
      not_before: 1_000,
      not_after: 1_012,
      remaining_runs: 1,
      cancel_lock_hash: [...bytes(hash("4"))],
    });
    const indexer = new RpcFixture({
      get_cells: (params: readonly unknown[]) => {
        const search = params[0] as { filter: { script: { code_hash: string } } };
        return {
          objects: [
            {
              output_data: bytesToHex(job),
              out_point: {
                tx_hash:
                  search.filter.script.code_hash ===
                  loaded.deployment.contracts.deadlinePolicy.script.codeHash
                    ? hash("5")
                    : hash("6"),
                index: "0x0",
              },
              block_number: "0x64",
            },
          ],
        };
      },
    });
    const jobs = await discoverPaymentJobs(loaded, indexer, "all");
    assert.deepEqual(
      jobs.map(({ kind }) => kind),
      ["scheduled", "recurring"],
    );
    assert.equal(jobs[0]?.takeoverBlock, "1012");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("manifest verification resolves every immutable code cell", async () => {
  const fixture = await manifestFixture();
  try {
    const loaded = await loadOperatorManifest(fixture.path);
    const byOutPoint = new Map<string, Uint8Array>(
      Object.values(fixture.contracts).map((item) => [
        item.value.cellDep.outPoint.txHash,
        item.binary,
      ]),
    );
    const rpc = new RpcFixture({
      get_block_hash: hash("a"),
      get_live_cell: (params: readonly unknown[]) => {
        const outPoint = params[0] as { tx_hash: string };
        const binary = byOutPoint.get(outPoint.tx_hash);
        assert.ok(binary);
        return {
          status: "live",
          cell: { data: { content: bytesToHex(binary) } },
        };
      },
    });
    const result = await verifyOperatorManifest(loaded, rpc);
    assert.equal(result.status, "verified");
    assert.equal(result.contracts.length, 4);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("job discovery uses the V2 Job Lock and policy binding", async () => {
  const fixture = await manifestFixture();
  try {
    const loaded = await loadOperatorManifest(fixture.path);
    const policyScript = {
      codeHash: loaded.manifest.contracts.policy.codeHash,
      hashType: "data1" as const,
      args: loaded.manifest.contracts.jobLock.codeHash,
    };
    const jobData = JobDataV1.pack({
      version: 1,
      flags: 0,
      job_id: [...bytes(hash("8"))],
      sequence: 3,
      state: 0,
      trigger_kind: 2,
      trigger_params_hash: [...bytes(hash("7"))],
      policy_script_hash: [...bytes(scriptToHash(policyScript) as Hash32)],
      payload_hash: [...bytes(hash("6"))],
      reward: 0,
      remaining_budget: 0,
      not_before: absolute(100),
      not_after: absolute(200),
      remaining_runs: 2,
      cancel_lock_hash: [...bytes(hash("5"))],
    });
    const indexer = new RpcFixture({
      get_cells: {
        objects: [
          {
            output_data: bytesToHex(jobData),
            output: {
              type: {
                code_hash: policyScript.codeHash,
                hash_type: policyScript.hashType,
                args: policyScript.args,
              },
            },
            out_point: { tx_hash: hash("9"), index: "0x0" },
            block_number: "0x10",
          },
        ],
      },
    });
    const jobs = await discoverHarvestV2Jobs(loaded.manifest, indexer);
    assert.equal(jobs[0]?.jobId, hash("8"));
    const request = indexer.calls[0]?.params[0] as {
      filter: { script: { args: string } };
    };
    assert.equal(request.filter.script.args, loaded.manifest.contracts.jobLock.codeHash);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

function fallbackClaimFixture(
  manifest: OperatorManifest,
  manifestSha256: string,
  privateKey = `0x${"1".repeat(64)}`,
) {
  const owner = script("a");
  const preparer = script("b");
  const operatorOwner: ScriptIdentity = {
    codeHash: manifest.secp256k1Blake160.codeHash,
    hashType: "type",
    args: `0x${blake160(new ECPair(privateKey).publicKey, "hex")}`,
  };
  const policyScript = {
    codeHash: manifest.contracts.policy.codeHash as Hash32,
    hashType: "data1" as const,
    args: manifest.contracts.jobLock.codeHash as `0x${string}`,
  };
  const policyHash = scriptToHash(policyScript) as Hash32;
  const claimant: ScriptIdentity = {
    codeHash: manifest.contracts.compensationLock.codeHash,
    hashType: "data1",
    args: bytesToHex(
      Uint8Array.from([...bytes(scriptToHash(operatorOwner) as Hash32), ...bytes(policyHash)]),
    ) as `0x${string}`,
  };
  const fallbackSet = deriveDaoHarvestV2FallbackOperatorSetHash([
    bytes(scriptToHash(claimant) as Hash32),
  ]);
  const jobId = hash("8");
  const payload = DaoHarvestPayloadV2.pack({
    version: 2,
    owner_lock_hash: [...bytes(scriptToHash(owner) as Hash32)],
    payout_lock_hash: [...bytes(scriptToHash(owner) as Hash32)],
    vault_lock_code_hash: [...bytes(manifest.contracts.vaultLock.codeHash as Hash32)],
    compensation_lock_code_hash: [...bytes(manifest.contracts.compensationLock.codeHash as Hash32)],
    dao_type_hash: [...bytes(hash("d"))],
    principal_capacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY.toString(),
    preferred_prepare_operator_lock_hash: [...bytes(scriptToHash(preparer) as Hash32)],
    fallback_prepare_executor_set_hash: [...fallbackSet],
    prepare_service_fee: "10",
    claim_service_fee: "20",
    compensation_seed_capacity: "201",
    prepare_buffer_epochs: relative(4),
    takeover_delay_epochs: relative(1),
    confirmation_margin_epochs: relative(1),
    total_cycles: 3,
    end_epoch_since: absolute(500),
  });
  const payloadHash = deriveDaoHarvestV2PayloadHash(bytes(policyHash), payload);
  const credit = DaoHarvestPrepareCreditV2.pack({
    version: 2,
    job_id: [...bytes(jobId)],
    cycle_index: 1,
    preparer_lock_hash: [...bytes(scriptToHash(preparer) as Hash32)],
    prepared_vault_output_index: 1,
    job_output_index: 0,
  });
  const creditHash = deriveDaoHarvestV2PrepareCreditHash(credit);
  const progress = DaoHarvestProgressV2.pack({
    version: 2,
    state: 1,
    cycle_index: 1,
    prepare_credit_hash: [...creditHash],
  });
  const progressHash = deriveDaoHarvestV2ProgressHash(progress);
  const witness = DaoHarvestWitnessV2.pack({
    version: 2,
    operation: DAO_HARVEST_V2_OPERATIONS.FALLBACK_CLAIM,
    flags: 0,
    job_input_index: 0,
    vault_input_index: 1,
    compensation_input_index: 2,
    identity_input_index: 3,
    prepare_accumulator_input_index: 4,
    claim_accumulator_input_index: 5,
    job_output_index: 0,
    vault_output_index: 1,
    compensation_output_index: 2,
    prepare_accumulator_output_index: 3,
    claim_accumulator_output_index: 4,
    payload_hash: [...payloadHash],
    progress_hash: [...progressHash],
    prepare_credit_hash: [...creditHash],
  });
  const envelope = DaoHarvestEnvelopeV2.pack({
    payload: [...payload],
    progress: [...progress],
    prepare_credit: [...credit],
    operator_proof: [],
    successor_payload: [],
  });
  const jobData = JobDataV1.pack({
    version: 1,
    flags: 0,
    job_id: [...bytes(jobId)],
    sequence: 2,
    state: 0,
    trigger_kind: 2,
    trigger_params_hash: [...progressHash],
    policy_script_hash: [...bytes(policyHash)],
    payload_hash: [...payloadHash],
    reward: 0,
    remaining_budget: 0,
    not_before: absolute(100),
    not_after: absolute(500),
    remaining_runs: 2,
    cancel_lock_hash: [...bytes(scriptToHash(owner) as Hash32)],
  });
  const inputLocks = [
    { ...script("1"), codeHash: manifest.contracts.jobLock.codeHash as Hash32 },
    script("2"),
    script("3"),
    claimant,
    preparer,
    claimant,
    operatorOwner,
  ];
  const inputCapacities = [
    100n,
    DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
    300n,
    1_000n,
    100n,
    100n,
    1_000n,
  ];
  const transaction: UnsignedDeadlineTransaction = {
    version: "0x0",
    cellDeps: Object.values(manifest.contracts).map((contract) => ({
      depType: contract.cellDep.depType,
      outPoint: {
        txHash: contract.cellDep.outPoint.txHash as Hash32,
        index: contract.cellDep.outPoint.index as `0x${string}`,
      },
    })),
    headerDeps: [hash("e"), hash("f")],
    inputs: inputLocks.map((_, index) => ({
      since: index === 1 ? absoluteHex(101) : "0x0",
      previousOutput: {
        txHash: hash(String(index + 1)),
        index: "0x0" as const,
      },
    })),
    outputs: [
      { capacity: "0x64", lock: inputLocks[0]!, type: policyScript },
      {
        capacity: `0x${DAO_HARVEST_VAULT_OCCUPIED_CAPACITY.toString(16)}`,
        lock: inputLocks[1]!,
        type: script("d"),
      },
      { capacity: "0x104", lock: inputLocks[2]!, type: null },
      { capacity: "0x6e", lock: preparer, type: null },
      { capacity: "0x78", lock: claimant, type: null },
      { capacity: "0x3e8", lock: claimant, type: null },
      { capacity: "0x3e8", lock: operatorOwner, type: null },
    ],
    outputsData: [bytesToHex(jobData) as `0x${string}`, "0x", "0x", "0x", "0x", "0x", "0x"],
    witnesses: [
      serializeWitnessArgs({
        lock: "",
        inputType: bytesToHex(witness),
        outputType: bytesToHex(envelope),
      }) as `0x${string}`,
    ],
  };
  const bundle: OperatorExecutionBundle = {
    schemaVersion: 1,
    manifestSha256,
    operation: "fallback_claim",
    jobId,
    transaction,
  };
  return {
    bundle,
    inputLocks,
    inputCapacities,
    jobData,
    payload,
    progress,
    credit,
    policyScript,
    preparer,
    claimant,
    operatorOwner,
  };
}

test("fallback claim dry-run derives authority, payments, limits, and margin from live data", async () => {
  const fixture = await manifestFixture();
  try {
    const loaded = await loadOperatorManifest(fixture.path);
    const privateKey = `0x${"1".repeat(64)}`;
    const claim = fallbackClaimFixture(loaded.manifest, loaded.sha256, privateKey);
    const rpc = new RpcFixture({
      get_live_cell: (params: readonly unknown[]) => {
        const outPoint = params[0] as { tx_hash: string };
        const index = Number.parseInt(outPoint.tx_hash.slice(2, 3), 16) - 1;
        return {
          status: "live",
          cell: {
            output: {
              capacity: `0x${claim.inputCapacities[index]!.toString(16)}`,
              lock: {
                code_hash: claim.inputLocks[index]!.codeHash,
                hash_type: claim.inputLocks[index]!.hashType,
                args: claim.inputLocks[index]!.args,
              },
            },
            data: { content: index === 0 ? bytesToHex(claim.jobData) : "0x" },
          },
        };
      },
      dry_run_transaction: { cycles: "0x3e8" },
      get_header: { dao: { c: "0", ar: "100", s: "0", u: "0" } },
      get_tip_header: { epoch: `0x${packEpoch(epoch(102)).toString(16)}` },
    });
    const config = parseOperatorConfiguration({
      CKB_RPC_URL: "https://rpc.example/",
      CKB_INDEXER_URL: "https://indexer.example/",
      OPERATOR_MANIFEST_PATH: fixture.path,
      OPERATOR_PRIVATE_KEY: privateKey,
      OPERATOR_MINIMUM_PROFIT_MARGIN: "5",
    });
    const result = await dryRunFallbackClaim(claim.bundle, loaded, config, rpc);
    assert.equal(result.status, "ready");
    assert.equal(result.claimPayment, "20");
    assert.equal(result.networkFee, "10");
    assert.equal(result.expectedMargin, "10");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("submission signs the complete operator lock group and broadcasts the reviewed hash", async () => {
  const fixture = await manifestFixture();
  try {
    const loaded = await loadOperatorManifest(fixture.path);
    const privateKey = `0x${"1".repeat(64)}`;
    const claim = fallbackClaimFixture(loaded.manifest, loaded.sha256, privateKey);
    const transactionHash = rawTransactionToHash(
      claim.bundle.transaction as unknown as Parameters<typeof rawTransactionToHash>[0],
    );
    let broadcast: Record<string, unknown> | undefined;
    const rpc = new RpcFixture({
      get_live_cell: (params: readonly unknown[]) => {
        const outPoint = params[0] as { tx_hash: string };
        const index = Number.parseInt(outPoint.tx_hash.slice(2, 3), 16) - 1;
        return {
          status: "live",
          cell: {
            output: {
              capacity: `0x${claim.inputCapacities[index]!.toString(16)}`,
              lock: {
                code_hash: claim.inputLocks[index]!.codeHash,
                hash_type: claim.inputLocks[index]!.hashType,
                args: claim.inputLocks[index]!.args,
              },
            },
            data: { content: index === 0 ? bytesToHex(claim.jobData) : "0x" },
          },
        };
      },
      dry_run_transaction: { cycles: "0x3e8" },
      get_header: { dao: { c: "0", ar: "100", s: "0", u: "0" } },
      get_tip_header: { epoch: `0x${packEpoch(epoch(102)).toString(16)}` },
      send_transaction: (params: readonly unknown[]) => {
        broadcast = params[0] as Record<string, unknown>;
        return transactionHash;
      },
    });
    const config = parseOperatorConfiguration({
      CKB_RPC_URL: "https://rpc.example/",
      CKB_INDEXER_URL: "https://indexer.example/",
      OPERATOR_MANIFEST_PATH: fixture.path,
      OPERATOR_PRIVATE_KEY: privateKey,
      OPERATOR_MINIMUM_PROFIT_MARGIN: "5",
    });
    const result = await submitFallbackClaim(claim.bundle, loaded, config, rpc);
    assert.equal(result.status, "submitted");
    assert.equal(result.transactionHash, transactionHash);
    const witnesses = broadcast?.["witnesses"] as string[];
    assert.notEqual(witnesses[6], "0x");
    assert.equal(witnesses[3], "0x");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("operator setup provisions a contract-bound accumulator from a signed fee cell", async () => {
  const fixture = await manifestFixture();
  try {
    const loaded = await loadOperatorManifest(fixture.path);
    const privateKey = `0x${"2".repeat(64)}`;
    const ownerArgs = `0x${blake160(new ECPair(privateKey).publicKey, "hex")}`;
    const fundingHash = hash("7");
    let broadcast: Record<string, unknown> | undefined;
    const indexer = new RpcFixture({
      get_cells: (params: readonly unknown[]) => {
        const search = params[0] as { script: { code_hash: string } };
        return {
          objects:
            search.script.code_hash === loaded.manifest.secp256k1Blake160.codeHash
              ? [
                  {
                    out_point: { tx_hash: fundingHash, index: "0x0" },
                    output_data: "0x",
                  },
                ]
              : [],
        };
      },
    });
    const rpc = new RpcFixture({
      get_live_cell: {
        status: "live",
        cell: {
          output: {
            capacity: "0x4a817c8500",
            lock: {
              code_hash: loaded.manifest.secp256k1Blake160.codeHash,
              hash_type: "type",
              args: ownerArgs,
            },
            type: null,
          },
          data: { content: "0x" },
        },
      },
      dry_run_transaction: { cycles: "0x3e8" },
      send_transaction: (params: readonly unknown[]) => {
        broadcast = params[0] as Record<string, unknown>;
        return hash("9");
      },
    });
    const config = parseOperatorConfiguration({
      CKB_RPC_URL: "https://rpc.example/",
      CKB_INDEXER_URL: "https://indexer.example/",
      OPERATOR_MANIFEST_PATH: fixture.path,
      OPERATOR_PRIVATE_KEY: privateKey,
    });
    const result = await provisionOperatorAccumulator(loaded, config, rpc, indexer);
    assert.equal(result.status, "submitted");
    const outputs = broadcast?.["outputs"] as Array<{ lock: { args: string } }>;
    const witnesses = broadcast?.["witnesses"] as string[];
    assert.equal(outputs[0]?.lock.args.length, 130);
    assert.notEqual(witnesses[0], "0x");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("operator builds a fallback claim from public chain and indexer state", async () => {
  const fixture = await manifestFixture();
  try {
    const loaded = await loadOperatorManifest(fixture.path);
    const privateKey = `0x${"1".repeat(64)}`;
    const claim = fallbackClaimFixture(loaded.manifest, loaded.sha256, privateKey);
    const sourceHash = hash("9");
    const claimAccumulatorHash = hash("c");
    const feeHash = hash("f");
    const prepareWitness = DaoHarvestWitnessV2.pack({
      version: 2,
      operation: 1,
      flags: 0,
      job_input_index: 0,
      vault_input_index: 1,
      compensation_input_index: 2,
      identity_input_index: 3,
      prepare_accumulator_input_index: 3,
      claim_accumulator_input_index: DAO_HARVEST_V2_ABSENT_INDEX,
      job_output_index: 0,
      vault_output_index: 1,
      compensation_output_index: 2,
      prepare_accumulator_output_index: 3,
      claim_accumulator_output_index: DAO_HARVEST_V2_ABSENT_INDEX,
      payload_hash: [
        ...deriveDaoHarvestV2PayloadHash(
          bytes(scriptToHash(claim.policyScript) as Hash32),
          claim.payload,
        ),
      ],
      progress_hash: [...deriveDaoHarvestV2ProgressHash(claim.progress)],
      prepare_credit_hash: [...deriveDaoHarvestV2PrepareCreditHash(claim.credit)],
    });
    const prepareEnvelope = DaoHarvestEnvelopeV2.pack({
      payload: [...claim.payload],
      progress: [...claim.progress],
      prepare_credit: [...claim.credit],
      operator_proof: [],
      successor_payload: [],
    });
    const vaultData = new Uint8Array(8);
    new DataView(vaultData.buffer).setBigUint64(0, 10n, true);
    const sourceCells = [
      {
        capacity: "0x4a817c800",
        lock: {
          code_hash: loaded.manifest.contracts.jobLock.codeHash,
          hash_type: "data1",
          args: "0x",
        },
        type: {
          code_hash: claim.policyScript.codeHash,
          hash_type: claim.policyScript.hashType,
          args: claim.policyScript.args,
        },
        data: bytesToHex(claim.jobData),
      },
      {
        capacity: `0x${DAO_HARVEST_VAULT_OCCUPIED_CAPACITY.toString(16)}`,
        lock: {
          code_hash: loaded.manifest.contracts.vaultLock.codeHash,
          hash_type: "data1",
          args: "0x",
        },
        type: { code_hash: loaded.manifest.nervosDao.codeHash, hash_type: "type", args: "0x" },
        data: bytesToHex(vaultData),
      },
      {
        capacity: "0x4a817c800",
        lock: {
          code_hash: loaded.manifest.contracts.compensationLock.codeHash,
          hash_type: "data1",
          args: `0x${"1".repeat(320)}`,
        },
        type: null,
        data: "0x",
      },
      {
        capacity: "0x4a817c800",
        lock: {
          code_hash: claim.preparer.codeHash,
          hash_type: claim.preparer.hashType,
          args: claim.preparer.args,
        },
        type: null,
        data: "0x",
      },
    ];
    const plainCells = new Map([
      [claimAccumulatorHash, { capacity: "0x4a817c800", lock: claim.claimant }],
      [feeHash, { capacity: "0x2540be400", lock: claim.operatorOwner }],
    ]);
    const rpc = new RpcFixture({
      get_live_cell: (params: readonly unknown[]) => {
        const point = params[0] as { tx_hash: string; index: string };
        const source =
          point.tx_hash === sourceHash
            ? sourceCells[Number(BigInt(point.index))]
            : plainCells.get(parseHash32(point.tx_hash));
        assert.ok(source);
        const lock = source.lock as ScriptIdentity;
        return {
          status: "live",
          cell: {
            output: {
              capacity: source.capacity,
              lock: {
                code_hash: lock.codeHash ?? (source.lock as { code_hash: string }).code_hash,
                hash_type: lock.hashType ?? (source.lock as { hash_type: string }).hash_type,
                args: lock.args,
              },
              type: "type" in source ? source.type : null,
            },
            data: { content: "data" in source ? source.data : "0x" },
          },
        };
      },
      get_transaction: {
        tx_status: { status: "committed", block_hash: hash("e") },
        transaction: {
          witnesses: [
            serializeWitnessArgs({
              lock: "",
              inputType: bytesToHex(prepareWitness),
              outputType: bytesToHex(prepareEnvelope),
            }),
          ],
        },
      },
      get_header: { number: "0x14" },
      get_block_by_number: (params: readonly unknown[]) => ({
        header: {
          hash: BigInt(params[0] as string) === 10n ? hash("a") : hash("b"),
          dao: { c: "0", ar: "100", s: "0", u: "0" },
        },
      }),
      get_tip_header: { epoch: `0x${packEpoch(epoch(102)).toString(16)}` },
    });
    const indexer = new RpcFixture({
      get_cells: (params: readonly unknown[]) => {
        const search = params[0] as { script: { code_hash: string } };
        return {
          objects: [
            {
              out_point: {
                tx_hash:
                  search.script.code_hash === loaded.manifest.contracts.compensationLock.codeHash
                    ? claimAccumulatorHash
                    : feeHash,
                index: "0x0",
              },
            },
          ],
        };
      },
    });
    const config = parseOperatorConfiguration({
      CKB_RPC_URL: "https://rpc.example/",
      CKB_INDEXER_URL: "https://indexer.example/",
      OPERATOR_MANIFEST_PATH: fixture.path,
      OPERATOR_PRIVATE_KEY: privateKey,
    });
    const bundle = await buildFallbackClaimBundle(
      { txHash: sourceHash, index: parseOutputIndex(0n) },
      loaded,
      config,
      rpc,
      indexer,
    );
    assert.equal(bundle.operation, "fallback_claim");
    assert.equal(bundle.jobId, claim.bundle.jobId);
    const decoded = DaoHarvestWitnessV2.unpack(
      witnessInputType(bundle.transaction.witnesses[0] as `0x${string}`),
    );
    assert.equal(Number(decoded.operation), DAO_HARVEST_V2_OPERATIONS.FALLBACK_CLAIM);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("health server reports manifest readiness and Prometheus metrics", async () => {
  const fixture = await manifestFixture();
  try {
    const loaded = await loadOperatorManifest(fixture.path);
    const byOutPoint = new Map<string, Uint8Array>(
      Object.values(fixture.contracts).map((item) => [
        item.value.cellDep.outPoint.txHash,
        item.binary,
      ]),
    );
    const rpc = new RpcFixture({
      get_block_hash: hash("a"),
      get_live_cell: (params: readonly unknown[]) => {
        const outPoint = params[0] as { tx_hash: string };
        const binary = byOutPoint.get(outPoint.tx_hash)!;
        return { status: "live", cell: { data: { content: bytesToHex(binary) } } };
      },
    });
    const config = {
      ...parseOperatorConfiguration({
        CKB_RPC_URL: "https://rpc.example/",
        CKB_INDEXER_URL: "https://indexer.example/",
        OPERATOR_MANIFEST_PATH: fixture.path,
      }),
      healthPort: 0,
    };
    const server = await startOperatorServer({ config, manifest: loaded, rpc });
    try {
      const ready = await fetch(`http://127.0.0.1:${server.port}/health/ready`);
      assert.equal(ready.status, 200);
      assert.equal(((await ready.json()) as { status: string }).status, "ready");
      const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      assert.equal(metrics.status, 200);
      assert.match(await metrics.text(), /automata_rpc_errors_total/);
    } finally {
      await server.close();
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
