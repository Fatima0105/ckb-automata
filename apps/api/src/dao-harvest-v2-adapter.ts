import { randomUUID } from "node:crypto";

import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import type { CkbReadClient } from "./ckb-client.ts";
import type { AutomataDatabase } from "./database/client.ts";
import { transactionAttempts } from "./database/schema.ts";
import type {
  DaoHarvestV2MutationAdapter,
  DaoHarvestV2PendingReadModel,
  DaoHarvestV2UnsignedBuild,
} from "./dao-harvest-v2.ts";
import { extractDaoHarvestV2ProjectionEvents } from "./indexer/dao-harvest-v2-projection.ts";

import {
  addEpochs,
  absentDaoHarvestV2Indices,
  buildDaoHarvestV2Transaction,
  createEpoch,
  deriveDaoHarvestV2FallbackOperatorSetHash,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2ProgressHash,
  deriveDaoHarvestV2VaultTermsHash,
  deriveJobId,
  encodeAbsoluteEpochSince,
  encodeDaoHarvestV2CompensationLockArgs,
  encodeDaoHarvestV2FallbackOperatorProof,
  encodeDaoHarvestV2VaultLockArgs,
  encodeRelativeEpochSince,
  hash32FromBytes,
  parseHash32,
  parseOutPoint,
  parseEpoch,
  parseSequence,
  parseShannons,
  selectDaoPrepareWindow,
  type CellDepIdentity,
  type Hash32,
  type ScriptIdentity,
} from "@ckb-automata/core";
import { packClientEpoch } from "@ckb-automata/ccc";
import { DaoHarvestPayloadV2, DaoHarvestProgressV2, JobDataV1 } from "@ckb-automata/molecule";

type Hex = `0x${string}`;

const CKB = 100_000_000n;
const JOB_CAPACITY = 400n * CKB;
const COMPENSATION_SEED = 201n * CKB;
const PREPARE_SERVICE_FEE = 2n * CKB;
const CLAIM_SERVICE_FEE = 3n * CKB;
const MAXIMUM_NETWORK_FEE = 1n * CKB;
const PREPARE_BUFFER_EPOCHS = 4n;
const CONFIRMATION_MARGIN_EPOCHS = 1n;
const MINIMUM_PRINCIPAL = 242n * CKB;
const MAXIMUM_CYCLES = 12;

export interface DaoHarvestV2DeploymentContract {
  readonly codeHash: Hash32;
  readonly hashType: "data1";
  readonly cellDep: CellDepIdentity;
}

export interface DaoHarvestV2Deployment {
  readonly genesisHash: Hash32;
  readonly secp256k1Blake160: {
    readonly codeHash: Hash32;
    readonly hashType: "type";
    readonly cellDep: CellDepIdentity;
  };
  readonly nervosDao: {
    readonly codeHash: Hash32;
    readonly hashType: "type";
    readonly cellDep: CellDepIdentity;
  };
  readonly contracts: {
    readonly jobLock: DaoHarvestV2DeploymentContract;
    readonly policy: DaoHarvestV2DeploymentContract;
    readonly vaultLock: DaoHarvestV2DeploymentContract;
    readonly compensationLock: DaoHarvestV2DeploymentContract;
  };
  readonly preferredPrepareOperatorLockHash: Hash32;
  readonly fallbackPrepareOperatorLockHashes: readonly Hash32[];
}

interface SetupRequest {
  readonly creatorNonce: bigint;
  readonly identityOutPoint: ReturnType<typeof parseOutPoint>;
  readonly ownerLock: ScriptIdentity;
  readonly ownerLockHash: Hash32;
  readonly payoutLock: ScriptIdentity;
  readonly payoutLockHash: Hash32;
  readonly principal: bigint;
  readonly totalCycles: number;
}

const SETUP_KEYS = [
  "creatorNonce",
  "identityOutPoint",
  "ownerLock",
  "ownerLockHash",
  "payoutLock",
  "payoutLockHash",
  "principal",
  "totalCycles",
] as const;

function script(value: unknown, name: string): ScriptIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a lock script`);
  }
  const item = value as Record<string, unknown>;
  const keys = Object.keys(item).toSorted().join(",");
  if (
    keys !== "args,codeHash,hashType" ||
    typeof item["codeHash"] !== "string" ||
    typeof item["args"] !== "string" ||
    !/^(?:0x)(?:[0-9a-f]{2})*$/.test(item["args"]) ||
    !["data", "data1", "type"].includes(String(item["hashType"]))
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({
    codeHash: parseHash32(item["codeHash"]),
    hashType: item["hashType"] as ScriptIdentity["hashType"],
    args: item["args"] as Hex,
  });
}

function setupRequest(value: unknown): SetupRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BadRequestException("DAO harvest setup must be an object");
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== SETUP_KEYS.length || SETUP_KEYS.some((key) => !(key in item))) {
    throw new BadRequestException("DAO harvest setup contains unsupported fields");
  }
  try {
    const ownerLock = script(item["ownerLock"], "ownerLock");
    const payoutLock = script(item["payoutLock"], "payoutLock");
    const ownerLockHash = parseHash32(String(item["ownerLockHash"]));
    const payoutLockHash = parseHash32(String(item["payoutLockHash"]));
    if (scriptToHash(ownerLock) !== ownerLockHash || scriptToHash(payoutLock) !== payoutLockHash) {
      throw new TypeError("lock scripts do not match their reviewed hashes");
    }
    if (typeof item["principal"] !== "string" || typeof item["creatorNonce"] !== "string") {
      throw new TypeError("principal and creatorNonce must be decimal strings");
    }
    const principal = parseShannons(item["principal"]);
    const creatorNonce = parseSequence(item["creatorNonce"]);
    const totalCycles = item["totalCycles"];
    if (principal < MINIMUM_PRINCIPAL)
      throw new RangeError("original amount must be at least 242 CKB");
    if (
      !Number.isSafeInteger(totalCycles) ||
      Number(totalCycles) < 1 ||
      Number(totalCycles) > MAXIMUM_CYCLES
    ) {
      throw new RangeError(`number of harvests must be between 1 and ${MAXIMUM_CYCLES}`);
    }
    return Object.freeze({
      creatorNonce,
      identityOutPoint: parseOutPoint(item["identityOutPoint"]),
      ownerLock,
      ownerLockHash,
      payoutLock,
      payoutLockHash,
      principal,
      totalCycles: Number(totalCycles),
    });
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : "invalid setup");
  }
}

function u64(value: bigint): Uint8Array {
  const result = new Uint8Array(8);
  new DataView(result.buffer).setBigUint64(0, value, true);
  return result;
}

function u32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value, true);
  return result;
}

function u16(value: number): Uint8Array {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value, true);
  return result;
}

function chainScript(value: {
  readonly codeHash: unknown;
  readonly hashType: unknown;
  readonly args: unknown;
}): ScriptIdentity {
  return script(
    {
      codeHash: String(value.codeHash),
      hashType: String(value.hashType),
      args: String(value.args),
    },
    "identity cell lock",
  );
}

function output(capacity: bigint, lock: ScriptIdentity, type: ScriptIdentity | null) {
  return Object.freeze({ capacity: `0x${capacity.toString(16)}` as Hex, lock, type });
}

export class DaoHarvestV2TransactionAdapter implements DaoHarvestV2MutationAdapter {
  readonly #chain: Pick<CkbReadClient, "getCellLive" | "getTipHeader"> &
    Partial<Pick<CkbReadClient, "getTransactionStatus">>;
  readonly #database: AutomataDatabase | undefined;
  readonly #deployment: DaoHarvestV2Deployment;
  readonly #network: string | undefined;

  constructor(
    chain: Pick<CkbReadClient, "getCellLive" | "getTipHeader"> &
      Partial<Pick<CkbReadClient, "getTransactionStatus">>,
    deployment: DaoHarvestV2Deployment,
    database?: AutomataDatabase,
    network?: string,
  ) {
    this.#chain = chain;
    this.#deployment = deployment;
    this.#database = database;
    this.#network = network;
  }

  async build(
    operation: "setup" | "sweep" | "close" | "rotate" | "recover",
    body: unknown,
  ): Promise<DaoHarvestV2UnsignedBuild> {
    if (operation !== "setup") {
      throw new ServiceUnavailableException(
        "This owner action is available after the harvest automation is indexed",
      );
    }
    return this.#setup(body);
  }

  async registerSetup(transactionHash: string): Promise<DaoHarvestV2PendingReadModel> {
    if (
      !this.#chain.getTransactionStatus ||
      this.#database === undefined ||
      this.#network === undefined
    ) {
      throw new ServiceUnavailableException(
        "DAO harvest V2 submission registration is not configured",
      );
    }
    const [observed, tip] = await Promise.all([
      this.#chain.getTransactionStatus(transactionHash),
      this.#chain.getTipHeader(),
    ]);
    if (
      !observed ||
      !["sent", "pending", "proposed", "committed"].includes(observed.status) ||
      parseHash32(observed.transaction.hash()) !== transactionHash
    ) {
      throw new BadRequestException("The submitted DAO harvest V2 transaction is not known on CKB");
    }
    const deployment = this.#deployment;
    const extraction = extractDaoHarvestV2ProjectionEvents(
      { header: tip, transactions: [observed.transaction] } as never,
      {
        networkId: this.#network,
        jobLock: { codeHash: deployment.contracts.jobLock.codeHash, hashType: "data1" },
        policy: {
          codeHash: deployment.contracts.policy.codeHash,
          hashType: "data1",
          args: deployment.contracts.jobLock.codeHash as Hex,
        },
        vaultLock: { codeHash: deployment.contracts.vaultLock.codeHash, hashType: "data1" },
        compensationLock: {
          codeHash: deployment.contracts.compensationLock.codeHash,
          hashType: "data1",
        },
        daoTypeHash: parseHash32(
          scriptToHash({ codeHash: deployment.nervosDao.codeHash, hashType: "type", args: "0x" }),
        ),
      },
    );
    const event = extraction.events[0];
    if (
      event === undefined ||
      extraction.events.length !== 1 ||
      extraction.malformed !== 0 ||
      event.operation !== "setup"
    ) {
      throw new BadRequestException(
        "The submitted transaction is not a valid DAO harvest V2 setup",
      );
    }
    const submittedAt = new Date();
    await this.#database
      .insert(transactionAttempts)
      .values({
        id: randomUUID(),
        networkId: this.#network,
        operation: "create",
        simulation: { kind: "pending_dao_harvest_v2", jobId: event.jobId },
        state: "submitted",
        submittedAt,
        txHash: transactionHash,
      })
      .onConflictDoNothing();
    return Object.freeze({
      transactionHash,
      submittedAt: submittedAt.toISOString(),
      status:
        observed.status === "sent" || observed.status === "pending" ? "submitting" : "confirming",
      lastKnownStatus: observed.status,
    });
  }

  async #setup(body: unknown): Promise<DaoHarvestV2UnsignedBuild> {
    const request = setupRequest(body);
    const identity = await this.#chain.getCellLive(request.identityOutPoint);
    if (!identity) throw new BadRequestException("the selected owner cell is no longer live");
    if (
      identity.cellOutput.type !== undefined ||
      identity.outputData.toString() !== "0x" ||
      scriptToHash(chainScript(identity.cellOutput.lock)) !== request.ownerLockHash
    ) {
      throw new BadRequestException("the selected identity cell is not a plain owner cell");
    }

    const deployment = this.#deployment;
    const jobLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.jobLock.codeHash,
      hashType: "data1",
      args: "0x",
    });
    const policy: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.policy.codeHash,
      hashType: "data1",
      args: deployment.contracts.jobLock.codeHash as Hex,
    });
    const daoType: ScriptIdentity = Object.freeze({
      codeHash: deployment.nervosDao.codeHash,
      hashType: "type",
      args: "0x",
    });
    const policyScriptHash = parseHash32(scriptToHash(policy));
    const jobLockHash = parseHash32(scriptToHash(jobLock));
    const daoTypeHash = parseHash32(scriptToHash(daoType));
    const fallback = deployment.fallbackPrepareOperatorLockHashes.map((value) => hexToBytes(value));
    const fallbackSetHash = deriveDaoHarvestV2FallbackOperatorSetHash(fallback);
    const proof = encodeDaoHarvestV2FallbackOperatorProof(fallback);
    const tip = await this.#chain.getTipHeader();
    const anticipatedDeposit = addEpochs(parseEpoch(packClientEpoch(tip.epoch)), 1n);
    const window = selectDaoPrepareWindow({
      deposit: anticipatedDeposit,
      tip: anticipatedDeposit,
      bufferEpochs: PREPARE_BUFFER_EPOCHS,
      confirmationMarginEpochs: CONFIRMATION_MARGIN_EPOCHS,
    });
    const prepareBuffer = encodeRelativeEpochSince(
      createEpoch({ number: PREPARE_BUFFER_EPOCHS, index: 0n, length: 1n }),
    );
    const takeoverDelay = encodeRelativeEpochSince(
      createEpoch({ number: 0n, index: 1n, length: 20n }),
    );
    const confirmationMargin = encodeRelativeEpochSince(
      createEpoch({ number: CONFIRMATION_MARGIN_EPOCHS, index: 0n, length: 1n }),
    );
    const endEpochSince = 0n;
    const payload = DaoHarvestPayloadV2.pack({
      version: 2,
      owner_lock_hash: [...hexToBytes(request.ownerLockHash)],
      payout_lock_hash: [...hexToBytes(request.payoutLockHash)],
      vault_lock_code_hash: [...hexToBytes(deployment.contracts.vaultLock.codeHash)],
      compensation_lock_code_hash: [...hexToBytes(deployment.contracts.compensationLock.codeHash)],
      dao_type_hash: [...hexToBytes(daoTypeHash)],
      principal_capacity: request.principal.toString(),
      preferred_prepare_operator_lock_hash: [
        ...hexToBytes(deployment.preferredPrepareOperatorLockHash),
      ],
      fallback_prepare_executor_set_hash: [...fallbackSetHash],
      prepare_service_fee: PREPARE_SERVICE_FEE.toString(),
      claim_service_fee: CLAIM_SERVICE_FEE.toString(),
      compensation_seed_capacity: COMPENSATION_SEED.toString(),
      prepare_buffer_epochs: prepareBuffer.toString(),
      takeover_delay_epochs: takeoverDelay.toString(),
      confirmation_margin_epochs: confirmationMargin.toString(),
      total_cycles: request.totalCycles,
      end_epoch_since: endEpochSince.toString(),
    });
    const payloadHashBytes = deriveDaoHarvestV2PayloadHash(hexToBytes(policyScriptHash), payload);
    const jobIdBytes = deriveJobId({
      genesisHash: hexToBytes(deployment.genesisHash),
      protocolVersion: 2,
      creationCommitment: payloadHashBytes,
      anchor: { kind: "output_index", outputIndex: 0n },
      creatorNonce: request.creatorNonce,
      policyScriptHash: hexToBytes(policyScriptHash),
    });
    const jobId = hash32FromBytes(jobIdBytes);
    const payloadHash = hash32FromBytes(payloadHashBytes);
    const progress = DaoHarvestProgressV2.pack({
      version: 2,
      state: 0,
      cycle_index: 0,
      prepare_credit_hash: Array(32).fill(0),
    });
    const progressHash = hash32FromBytes(deriveDaoHarvestV2ProgressHash(progress));
    const termsHash = deriveDaoHarvestV2VaultTermsHash([
      u16(2),
      hexToBytes(request.ownerLockHash),
      hexToBytes(request.payoutLockHash),
      hexToBytes(daoTypeHash),
      u64(request.principal),
      u64(PREPARE_SERVICE_FEE),
      u64(CLAIM_SERVICE_FEE),
      u64(COMPENSATION_SEED),
      u64(prepareBuffer),
      u64(takeoverDelay),
      u64(confirmationMargin),
      u32(request.totalCycles),
      u64(endEpochSince),
    ]);
    const vaultLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.vaultLock.codeHash,
      hashType: "data1",
      args: bytesToHex(
        encodeDaoHarvestV2VaultLockArgs({
          jobId: jobIdBytes,
          ownerLockHash: hexToBytes(request.ownerLockHash),
          jobLockHash: hexToBytes(jobLockHash),
          policyScriptHash: hexToBytes(policyScriptHash),
          immutableTermsHash: termsHash,
        }),
      ) as Hex,
    });
    const compensationLock: ScriptIdentity = Object.freeze({
      codeHash: deployment.contracts.compensationLock.codeHash,
      hashType: "data1",
      args: bytesToHex(
        encodeDaoHarvestV2CompensationLockArgs({
          jobId: jobIdBytes,
          ownerLockHash: hexToBytes(request.ownerLockHash),
          payoutLockHash: hexToBytes(request.payoutLockHash),
          policyScriptHash: hexToBytes(policyScriptHash),
          payloadHash: payloadHashBytes,
        }),
      ) as Hex,
    });
    const jobData = JobDataV1.pack({
      version: 1,
      flags: 0,
      job_id: [...jobIdBytes],
      sequence: "0",
      state: 0,
      trigger_kind: 2,
      trigger_params_hash: [...hexToBytes(progressHash)],
      policy_script_hash: [...hexToBytes(policyScriptHash)],
      payload_hash: [...payloadHashBytes],
      reward: "0",
      remaining_budget: "0",
      not_before: encodeAbsoluteEpochSince(window.startsAt).toString(),
      not_after: "0",
      remaining_runs: request.totalCycles,
      cancel_lock_hash: [...hexToBytes(request.ownerLockHash)],
    });
    const totalLockedAmount = JOB_CAPACITY + request.principal + COMPENSATION_SEED;
    const build = buildDaoHarvestV2Transaction({
      operation: 0,
      policyScriptHash,
      payload,
      progress,
      operatorProof: proof,
      indices: {
        ...absentDaoHarvestV2Indices(),
        identityInputIndex: 0,
        jobOutputIndex: 0,
        vaultOutputIndex: 1,
        compensationOutputIndex: 2,
      },
      cellDeps: [
        deployment.secp256k1Blake160.cellDep,
        deployment.contracts.jobLock.cellDep,
        deployment.contracts.policy.cellDep,
        deployment.contracts.vaultLock.cellDep,
        deployment.contracts.compensationLock.cellDep,
        deployment.nervosDao.cellDep,
      ],
      headerDeps: [],
      inputs: [
        {
          since: "0x0",
          previousOutput: {
            txHash: request.identityOutPoint.txHash,
            index: `0x${request.identityOutPoint.index.toString(16)}`,
          },
        },
      ],
      inputCapacities: [parseShannons(identity.cellOutput.capacity.toString())],
      outputs: [
        output(JOB_CAPACITY, jobLock, policy),
        output(request.principal, vaultLock, daoType),
        output(COMPENSATION_SEED, compensationLock, null),
      ],
      outputsData: [bytesToHex(jobData) as Hex, "0x0000000000000000", "0x"],
      allowedFundingLockHashes: [request.ownerLockHash],
      economics: {
        originalAmount: request.principal,
        expectedCompensation: 0n,
        prepareServiceCharge: PREPARE_SERVICE_FEE,
        claimServiceCharge: CLAIM_SERVICE_FEE,
        maximumNetworkFee: MAXIMUM_NETWORK_FEE,
        recoverableReserve: COMPENSATION_SEED,
        accumulatedCompensation: 0n,
        totalLockedAmount,
      },
    });
    return Object.freeze({
      version: 2 as const,
      jobId,
      operation: "setup" as const,
      transaction: build.transaction,
      intentHash: build.intentHash,
      payloadHash,
      progressHash,
      prepareCreditHash: build.prepareCreditHash,
      review: Object.freeze({
        originalAmount: build.review.originalAmount.toString(),
        expectedCompensation: build.review.expectedCompensation.toString(),
        completedWorkCharges: Object.freeze({
          prepare: build.review.completedWorkCharges.prepare.toString(),
          claim: build.review.completedWorkCharges.claim.toString(),
          maximumTotal: build.review.completedWorkCharges.maximumTotal.toString(),
        }),
        maximumNetworkFee: build.review.maximumNetworkFee.toString(),
        recoverableReserve: build.review.recoverableReserve.toString(),
        accumulatedCompensation: build.review.accumulatedCompensation.toString(),
        totalLockedAmount: build.review.totalLockedAmount.toString(),
        notes: build.review.notes,
      }),
      completion: Object.freeze({
        requiredInputCount: build.completion.requiredInputCount,
        requiredOutputCount: build.completion.requiredOutputCount,
        requiredInputCapacity: build.completion.requiredInputCapacity.toString(),
        maximumFee: build.completion.maximumFee.toString(),
        allowedFundingLockHashes: build.completion.allowedFundingLockHashes,
      }),
    });
  }
}
