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
  DAO_HARVEST_V2_OPERATIONS,
  createEpoch,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  encodeAbsoluteEpochSince,
  encodeRelativeEpochSince,
  packEpoch,
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
import { discoverHarvestV2Jobs } from "./discovery.ts";
import { loadOperatorManifest, verifyOperatorManifest, type OperatorManifest } from "./manifest.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { startOperatorServer } from "./server.ts";
import {
  dryRunFallbackClaim,
  submitFallbackClaim,
  type OperatorExecutionBundle,
} from "./transaction.ts";

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
    releaseVersion: "0.1.0",
    network: "ckb_testnet",
    genesisHash: hash("a"),
    sourceRevision: "b".repeat(40),
    contracts: Object.fromEntries(
      Object.entries(contracts).map(([name, item]) => [name, item.value]),
    ),
  };
  const directory = await mkdtemp(join(tmpdir(), "ckautomata-operator-"));
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
  claimant = script("c"),
) {
  const owner = script("a");
  const preparer = script("b");
  const fallbackSet = deriveDaoHarvestV2FallbackOperatorSetHash([
    bytes(scriptToHash(claimant) as Hash32),
  ]);
  const policyScript = {
    codeHash: manifest.contracts.policy.codeHash as Hash32,
    hashType: "data1" as const,
    args: manifest.contracts.jobLock.codeHash as `0x${string}`,
  };
  const policyHash = scriptToHash(policyScript) as Hash32;
  const jobId = hash("8");
  const payload = DaoHarvestPayloadV2.pack({
    version: 2,
    owner_lock_hash: [...bytes(scriptToHash(owner) as Hash32)],
    payout_lock_hash: [...bytes(scriptToHash(owner) as Hash32)],
    vault_lock_code_hash: [...bytes(manifest.contracts.vaultLock.codeHash as Hash32)],
    compensation_lock_code_hash: [...bytes(manifest.contracts.compensationLock.codeHash as Hash32)],
    dao_type_hash: [...bytes(hash("d"))],
    principal_capacity: "1000",
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
  ];
  const inputCapacities = [100n, 1_000n, 300n, 1_000n, 100n, 100n];
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
      { capacity: "0x3e8", lock: inputLocks[1]!, type: script("d") },
      { capacity: "0x104", lock: inputLocks[2]!, type: null },
      { capacity: "0x6e", lock: preparer, type: null },
      { capacity: "0x78", lock: claimant, type: null },
      { capacity: "0x3e8", lock: claimant, type: null },
    ],
    outputsData: [bytesToHex(jobData) as `0x${string}`, "0x", "0x", "0x", "0x", "0x"],
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
  return { bundle, inputLocks, inputCapacities, jobData };
}

test("fallback claim dry-run derives authority, payments, limits, and margin from live data", async () => {
  const fixture = await manifestFixture();
  try {
    const loaded = await loadOperatorManifest(fixture.path);
    const claim = fallbackClaimFixture(loaded.manifest, loaded.sha256);
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
      get_tip_header: { epoch: `0x${packEpoch(epoch(102)).toString(16)}` },
    });
    const config = parseOperatorConfiguration({
      CKB_RPC_URL: "https://rpc.example/",
      CKB_INDEXER_URL: "https://indexer.example/",
      OPERATOR_MANIFEST_PATH: fixture.path,
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
    const claimant: ScriptIdentity = {
      codeHash: hash("c"),
      hashType: "data1",
      args: `0x${blake160(new ECPair(privateKey).publicKey, "hex")}`,
    };
    const claim = fallbackClaimFixture(loaded.manifest, loaded.sha256, claimant);
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
    assert.notEqual(witnesses[3], "0x");
    assert.equal(witnesses[5], "0x");
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
