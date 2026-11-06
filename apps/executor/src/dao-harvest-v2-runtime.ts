import { clearInterval, setInterval } from "node:timers";

import { WitnessArgs, type ClientTransactionResponse } from "@ckb-ccc/shell";
import { bytesToHex, hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";
import type { OnApplicationBootstrap, OnModuleDestroy } from "@nestjs/common";
import postgres from "postgres";

import { clientDaoAccumulatedRate, packClientEpoch } from "@ckb-automata/ccc";
import {
  DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
  HARVEST_V2_TRANSACTION_LIMITS,
  addEpochFractions,
  addEpochs,
  assertHarvestV2TransactionWithinLimits,
  buildDaoHarvestV2ClaimTransition,
  buildDaoHarvestV2PrepareTransition,
  calculateDaoMaximumWithdraw,
  decodeAbsoluteEpochSince,
  decodeDaoHarvestV2CompensationLockArgs,
  decodeDaoHarvestV2FallbackOperatorProof,
  decodeRelativeEpochSince,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  encodeAbsoluteEpochSince,
  hash32FromBytes,
  minimumPlainCellCapacity,
  parseHash32,
  parseOutPoint,
  parseEpoch,
  parseShannons,
  selectDaoPrepareWindow,
  serializedTransactionBytes,
  subtractEpochFractions,
  type DaoHarvestV2TransitionCell,
  type Hash32,
  type OutPoint,
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

import { chainScriptIdentity } from "./build-snapshot.ts";
import {
  DAO_HARVEST_V2_ADAPTER_ID,
  createDaoHarvestV2ExecutionPlan,
  evaluateDaoHarvestV2Schedule,
  validateDaoHarvestV2Reload,
  type DaoHarvestV2OperatorIdentity,
  type DaoHarvestV2ScheduleRecord,
} from "./dao-harvest-v2-safety.ts";
import {
  loadVerifiedDaoHarvestV2ExecutorDeployments,
  type VerifiedDaoHarvestV2ExecutorDeployment,
} from "./dao-harvest-v2-manifest.ts";
import type { ExecutorEventLogger, ExecutorRuntime } from "./runtime.ts";
import { signOperatorFeeInput } from "./signing.ts";

type Hex = `0x${string}`;
const POLL_INTERVAL_MS = 10_000;
const MAX_LINEAGE_DEPTH = 128;
const MAX_CELLS = 32;
const V2_NETWORK_FEE_CAP = 50_000n;

interface ProjectionRow {
  readonly jobId: string;
  readonly jobOutpoint: unknown;
  readonly vaultOutpoint: unknown;
  readonly compensationOutpoint: unknown;
  readonly lifecycleState: string;
  readonly prepareCredit: unknown;
  readonly operatorWindow: unknown;
  readonly observedTransactionHash: string;
}

interface CurrentState {
  readonly deployment: VerifiedDaoHarvestV2ExecutorDeployment;
  readonly payloadBytes: Uint8Array;
  readonly payload: ReturnType<typeof DaoHarvestPayloadV2.unpack>;
  readonly progressBytes: Uint8Array;
  readonly progress: ReturnType<typeof DaoHarvestProgressV2.unpack>;
  readonly prepareCreditBytes?: Uint8Array;
  readonly proof: Uint8Array;
  readonly job: ReturnType<typeof JobDataV1.unpack>;
  readonly jobCell: DaoHarvestV2TransitionCell;
  readonly vaultCell: DaoHarvestV2TransitionCell;
  readonly compensationCell: DaoHarvestV2TransitionCell;
  readonly source: ClientTransactionResponse;
  readonly sourceWitness: ReturnType<typeof DaoHarvestWitnessV2.unpack>;
  readonly policyScriptHash: Hash32;
  readonly schedule: DaoHarvestV2ScheduleRecord;
}

interface SubmittedAttempt {
  readonly transactionHash: Hash32;
  readonly jobId: Hash32;
  readonly operation: string;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function outPoint(value: unknown, name: string): OutPoint {
  const item = object(value, name);
  return parseOutPoint({
    txHash: String(item["txHash"]),
    index: String(item["index"]),
  });
}

function chainCell(
  live: NonNullable<Awaited<ReturnType<ExecutorRuntime["getCellLive"]>>>,
): DaoHarvestV2TransitionCell {
  return Object.freeze({
    outPoint: parseOutPoint({
      txHash: live.outPoint.txHash.toString(),
      index: live.outPoint.index.toString(),
    }),
    capacity: parseShannons(live.cellOutput.capacity.toString()),
    lock: chainScriptIdentity(live.cellOutput.lock),
    type: live.cellOutput.type === undefined ? null : chainScriptIdentity(live.cellOutput.type),
    data: live.outputData.toString() as Hex,
  });
}

function outputType(response: ClientTransactionResponse) {
  const bytes = response.transaction.witnesses[0];
  if (!bytes) throw new Error("V2 source transaction has no protocol witness");
  const args = WitnessArgs.fromBytes(bytes);
  if (!args.inputType || !args.outputType) {
    throw new Error("V2 source transaction has incomplete protocol witness fields");
  }
  return Object.freeze({
    witness: DaoHarvestWitnessV2.unpack(hexToBytes(args.inputType)),
    envelope: DaoHarvestEnvelopeV2.unpack(hexToBytes(args.outputType)),
  });
}

function operation(value: ReturnType<typeof DaoHarvestWitnessV2.unpack>): number {
  const parsed = Number(value.operation);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 9) {
    throw new Error("V2 source transaction operation is invalid");
  }
  return parsed;
}

function activeState(source: ClientTransactionResponse) {
  const decoded = outputType(source);
  const inputPayload = Uint8Array.from(decoded.envelope.payload);
  const inputProgress = Uint8Array.from(decoded.envelope.progress);
  const credit = Uint8Array.from(decoded.envelope.prepare_credit);
  const operationValue = operation(decoded.witness);
  const payloadBytes =
    operationValue === 8 ? Uint8Array.from(decoded.envelope.successor_payload) : inputPayload;
  const progressValue = DaoHarvestProgressV2.unpack(inputProgress);
  const progressBytes = [1, 2].includes(operationValue)
    ? DaoHarvestProgressV2.pack({
        version: 2,
        state: 1,
        cycle_index: progressValue.cycle_index,
        prepare_credit_hash: [...deriveDaoHarvestV2PrepareCreditHash(credit)],
      })
    : [3, 4, 5].includes(operationValue)
      ? DaoHarvestProgressV2.pack({
          version: 2,
          state: 0,
          cycle_index: Number(progressValue.cycle_index) + 1,
          prepare_credit_hash: Array(32).fill(0),
        })
      : inputProgress;
  return Object.freeze({
    ...decoded,
    operationValue,
    payloadBytes,
    progressBytes,
    ...(credit.length === 0 ? {} : { prepareCreditBytes: credit }),
  });
}

function policyScript(deployment: VerifiedDaoHarvestV2ExecutorDeployment): ScriptIdentity {
  return Object.freeze({
    codeHash: deployment.manifest.contracts.policy.codeHash,
    hashType: "data1" as const,
    args: deployment.manifest.contracts.jobLock.codeHash as Hex,
  });
}

function operatorAccumulatorLock(
  deployment: VerifiedDaoHarvestV2ExecutorDeployment,
  ownerLockHash: Hash32,
  policyScriptHash: Hash32,
): ScriptIdentity {
  return Object.freeze({
    codeHash: deployment.manifest.contracts.compensationLock.codeHash,
    hashType: "data1" as const,
    args: bytesToHex(
      Uint8Array.from([...hexToBytes(ownerLockHash), ...hexToBytes(policyScriptHash)]),
    ) as Hex,
  });
}

function blockNumberFromDaoData(data: Hex): bigint {
  const bytes = hexToBytes(data);
  if (bytes.length !== 8 || bytes.every((byte) => byte === 0)) {
    throw new Error("withdrawing DAO vault data is invalid");
  }
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

export class DaoHarvestV2RuntimeCoordinator implements OnApplicationBootstrap, OnModuleDestroy {
  readonly #runtime: ExecutorRuntime;
  readonly #logger: ExecutorEventLogger;
  readonly #database: ReturnType<typeof postgres>;
  readonly #network: string;
  readonly #manifestPath: string;
  readonly #privateKey: string;
  readonly #ownerLock: ScriptIdentity;
  readonly #transactionFee: bigint;
  readonly #minimumMargin: bigint;
  readonly #maximumCycles: bigint;
  readonly #identity: DaoHarvestV2OperatorIdentity;
  readonly #attempts = new Map<Hash32, SubmittedAttempt>();
  readonly #provisions = new Map<Hash32, Hash32>();
  #deployments: readonly VerifiedDaoHarvestV2ExecutorDeployment[] | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running = false;
  #stopped = false;

  constructor(options: {
    readonly runtime: ExecutorRuntime;
    readonly logger: ExecutorEventLogger;
    readonly databaseUrl: string;
    readonly network: string;
    readonly manifestPath: string;
    readonly privateKey: string;
    readonly ownerLock: ScriptIdentity;
    readonly transactionFee: bigint;
    readonly minimumMargin: bigint;
    readonly maximumCycles: bigint;
  }) {
    this.#runtime = options.runtime;
    this.#logger = options.logger;
    this.#database = postgres(options.databaseUrl, { max: 1, prepare: false });
    this.#network = options.network;
    this.#manifestPath = options.manifestPath;
    this.#privateKey = options.privateKey;
    this.#ownerLock = options.ownerLock;
    if (options.transactionFee <= 0n) throw new RangeError("V2 transaction fee must be positive");
    this.#transactionFee =
      options.transactionFee < V2_NETWORK_FEE_CAP ? options.transactionFee : V2_NETWORK_FEE_CAP;
    this.#minimumMargin = options.minimumMargin;
    this.#maximumCycles = options.maximumCycles;
    const ownerLockHash = parseHash32(scriptToHash(options.ownerLock));
    this.#identity = Object.freeze({
      ownerLockHash,
      accumulatorLockHash: ownerLockHash,
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.#runtime.readiness().status !== "ready") {
      throw new Error("V2 harvest runtime requires a ready executor runtime");
    }
    await this.#loadedDeployments();
    this.#timer = setInterval(() => void this.runOnce(), POLL_INTERVAL_MS);
    void this.runOnce();
  }

  async onModuleDestroy(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    while (this.#running) await new Promise((resolve) => setTimeout(resolve, 10));
    await this.#database.end({ timeout: 5 });
  }

  async runOnce(): Promise<void> {
    if (this.#running || this.#stopped || this.#runtime.readiness().status !== "ready") return;
    this.#running = true;
    try {
      await this.#runtime.run(async () => {
        await this.#reconcile();
        const deployments = await this.#loadedDeployments();
        const rows = await this.#rows();
        for (const row of rows) {
          if (this.#stopped) break;
          try {
            const state = await this.#reload(row, deployments);
            const tip = await this.#runtime.getTipHeader();
            const tipEpoch = packClientEpoch(tip.epoch);
            const accumulatorLock = operatorAccumulatorLock(
              state.deployment,
              this.#identity.ownerLockHash,
              state.policyScriptHash,
            );
            const identity = Object.freeze({
              ...this.#identity,
              accumulatorLockHash: parseHash32(scriptToHash(accumulatorLock)),
            });
            const decision = evaluateDaoHarvestV2Schedule(state.schedule, tipEpoch, identity);
            if (decision.status !== "ready") continue;
            if (this.#attempts.has(state.schedule.jobId)) continue;
            await this.#execute(state, decision.operation, identity, tipEpoch, accumulatorLock);
          } catch (error) {
            this.#logger.error(
              "executor.dao_harvest_v2.job_failed",
              "V2 harvest job was not submitted",
              {
                jobId: row.jobId,
                reason: error instanceof Error ? error.message : "unknown failure",
              },
            );
          }
        }
      });
    } catch (error) {
      this.#logger.error("executor.dao_harvest_v2.poll_failed", "V2 harvest polling failed", {
        reason: error instanceof Error ? error.message : "unknown failure",
      });
    } finally {
      this.#running = false;
    }
  }

  async #loadedDeployments(): Promise<readonly VerifiedDaoHarvestV2ExecutorDeployment[]> {
    if (this.#deployments === undefined) {
      this.#deployments = await loadVerifiedDaoHarvestV2ExecutorDeployments(
        this.#manifestPath,
        this.#runtime,
        this.#runtime.readiness().chain.genesisHash ?? "",
      );
      this.#logger.info("executor.dao_harvest_v2.ready", "V2 harvest runtime is enabled", {
        revisions: this.#deployments.map(({ manifest }) => manifest.releaseVersion),
      });
    }
    return this.#deployments;
  }

  async #rows(): Promise<readonly ProjectionRow[]> {
    const rows = await this.#database<ProjectionRow[]>`
      select
        job_id as "jobId",
        job_outpoint as "jobOutpoint",
        vault_outpoint as "vaultOutpoint",
        compensation_outpoint as "compensationOutpoint",
        lifecycle_state as "lifecycleState",
        prepare_credit as "prepareCredit",
        operator_window as "operatorWindow",
        observed_transaction_hash as "observedTransactionHash"
      from dao_harvest_v2_jobs
      where network_id = ${this.#network}
        and canonical = true
        and canonical_tx_status = 'committed'
        and projection_completeness = 'complete'
        and lifecycle_state in ('deposited', 'withdrawing')
      order by observed_block_number asc
    `;
    return Object.freeze([...rows]);
  }

  async #committed(hash: string): Promise<ClientTransactionResponse> {
    const response = await this.#runtime.getTransactionStatus(parseHash32(hash));
    if (!response || response.status !== "committed" || !response.blockHash) {
      throw new Error("V2 source transaction is not canonical and committed");
    }
    return response;
  }

  async #proof(source: ClientTransactionResponse): Promise<Uint8Array> {
    let current = source;
    const seen = new Set<string>();
    for (let depth = 0; depth < MAX_LINEAGE_DEPTH; depth += 1) {
      const hash = parseHash32(current.transaction.hash());
      if (seen.has(hash)) throw new Error("V2 job lineage contains a cycle");
      seen.add(hash);
      const decoded = outputType(current);
      const proof = Uint8Array.from(decoded.envelope.operator_proof);
      if (proof.length > 0) return proof;
      const jobInput = Number(decoded.witness.job_input_index);
      if (jobInput === 0xffff_ffff) break;
      const previous = current.transaction.inputs[jobInput]?.previousOutput.txHash.toString();
      if (!previous) break;
      current = await this.#committed(previous);
    }
    throw new Error("V2 fallback operator proof is unavailable from canonical lineage");
  }

  async #reload(
    row: ProjectionRow,
    deployments: readonly VerifiedDaoHarvestV2ExecutorDeployment[],
  ): Promise<CurrentState> {
    if (!row.jobOutpoint || !row.vaultOutpoint || !row.compensationOutpoint) {
      throw new Error("V2 projection is missing a live state outpoint");
    }
    const [jobLive, vaultLive, compensationLive, source] = await Promise.all([
      this.#runtime.getCellLive(outPoint(row.jobOutpoint, "job outpoint")),
      this.#runtime.getCellLive(outPoint(row.vaultOutpoint, "vault outpoint")),
      this.#runtime.getCellLive(outPoint(row.compensationOutpoint, "compensation outpoint")),
      this.#committed(row.observedTransactionHash),
    ]);
    if (!jobLive || !vaultLive || !compensationLive) {
      throw new Error("V2 projected state has already been consumed");
    }
    const jobCell = chainCell(jobLive);
    const vaultCell = chainCell(vaultLive);
    const compensationCell = chainCell(compensationLive);
    const deployment = deployments.find(
      ({ manifest }) =>
        jobCell.lock.codeHash === manifest.contracts.jobLock.codeHash &&
        jobCell.type?.codeHash === manifest.contracts.policy.codeHash,
    );
    if (!deployment) throw new Error("V2 projected state uses an unavailable contract revision");
    const policy = policyScript(deployment);
    const policyScriptHash = parseHash32(scriptToHash(policy));
    if (jobCell.type === null || scriptToHash(jobCell.type) !== policyScriptHash) {
      throw new Error("V2 Job Cell policy script is invalid");
    }
    const active = activeState(source);
    const payload = DaoHarvestPayloadV2.unpack(active.payloadBytes);
    const progress = DaoHarvestProgressV2.unpack(active.progressBytes);
    const job = JobDataV1.unpack(hexToBytes(jobCell.data));
    const jobId = hash32FromBytes(Uint8Array.from(job.job_id));
    const sourceHash = parseHash32(source.transaction.hash());
    if (
      jobCell.outPoint.txHash !== sourceHash ||
      BigInt(jobCell.outPoint.index) !== BigInt(active.witness.job_output_index) ||
      jobCell.lock.args !== "0x"
    ) {
      throw new Error("V2 source transaction does not produce the projected Job Cell");
    }
    if (jobId !== parseHash32(row.jobId)) throw new Error("V2 projection Job identity changed");
    if (
      hash32FromBytes(
        deriveDaoHarvestV2PayloadHash(hexToBytes(policyScriptHash), active.payloadBytes),
      ) !== hash32FromBytes(Uint8Array.from(job.payload_hash)) ||
      hash32FromBytes(deriveDaoHarvestV2ProgressHash(active.progressBytes)) !==
        hash32FromBytes(Uint8Array.from(job.trigger_params_hash))
    ) {
      throw new Error("V2 live state does not match its immutable commitments");
    }
    const proof = await this.#proof(source);
    const fallback = decodeDaoHarvestV2FallbackOperatorProof(
      proof,
      Uint8Array.from(payload.fallback_prepare_executor_set_hash),
    ).map(hash32FromBytes);
    const window = object(row.operatorWindow, "operator window");
    const credited =
      row.prepareCredit === null
        ? null
        : parseHash32(String(object(row.prepareCredit, "prepare credit")["preparerLockHash"]));
    const state = Number(progress.state) === 0 ? "deposited" : "withdrawing";
    if (state !== row.lifecycleState) throw new Error("V2 projection lifecycle state changed");
    if (
      vaultCell.lock.codeHash !== deployment.manifest.contracts.vaultLock.codeHash ||
      compensationCell.lock.codeHash !== deployment.manifest.contracts.compensationLock.codeHash
    ) {
      throw new Error("V2 projected application cells use another contract revision");
    }
    const compensationArgs = decodeDaoHarvestV2CompensationLockArgs(
      hexToBytes(compensationCell.lock.args),
    );
    if (
      hash32FromBytes(compensationArgs.jobId) !== jobId ||
      hash32FromBytes(compensationArgs.payloadHash) !==
        hash32FromBytes(Uint8Array.from(job.payload_hash))
    ) {
      throw new Error("V2 Compensation Cell does not match the live Job Cell");
    }
    const notBefore = decodeAbsoluteEpochSince(job.not_before.toString());
    const takeover = addEpochFractions(
      notBefore,
      decodeRelativeEpochSince(payload.takeover_delay_epochs.toString()),
    );
    const cutoff =
      state === "deposited"
        ? subtractEpochFractions(
            addEpochFractions(
              notBefore,
              decodeRelativeEpochSince(payload.prepare_buffer_epochs.toString()),
            ),
            decodeRelativeEpochSince(payload.confirmation_margin_epochs.toString()),
          )
        : null;
    if (
      String(window["preferredFromSince"]) !== encodeAbsoluteEpochSince(notBefore).toString() ||
      String(window["fallbackFromSince"]) !== encodeAbsoluteEpochSince(takeover).toString() ||
      (cutoff === null
        ? window["prepareCutoffSince"] !== null
        : String(window["prepareCutoffSince"]) !== encodeAbsoluteEpochSince(cutoff).toString())
    ) {
      throw new Error("V2 indexed operator window contradicts the committed schedule");
    }
    const schedule: DaoHarvestV2ScheduleRecord = Object.freeze({
      jobId,
      sequence: job.sequence.toString(),
      state,
      cycleIndex: progress.cycle_index.toString(),
      totalCycles: payload.total_cycles.toString(),
      live: true,
      canonical: true,
      notBeforeSince: job.not_before.toString(),
      prepareCutoffSince: cutoff === null ? null : encodeAbsoluteEpochSince(cutoff),
      takeoverDelaySince: payload.takeover_delay_epochs.toString(),
      endEpochSince: payload.end_epoch_since.toString(),
      preferredPrepareOperatorLockHash: hash32FromBytes(
        Uint8Array.from(payload.preferred_prepare_operator_lock_hash),
      ),
      creditedPrepareOperatorLockHash: credited,
      fallbackPrepareOperatorLockHashes: Object.freeze(fallback),
    });
    return Object.freeze({
      deployment,
      payloadBytes: active.payloadBytes,
      payload,
      progressBytes: active.progressBytes,
      progress,
      ...(active.prepareCreditBytes === undefined
        ? {}
        : { prepareCreditBytes: active.prepareCreditBytes }),
      proof,
      job,
      jobCell,
      vaultCell,
      compensationCell,
      source,
      sourceWitness: active.witness,
      policyScriptHash,
      schedule,
    });
  }

  async #findPlainCell(
    lock: ScriptIdentity,
    minimumCapacity: bigint,
  ): Promise<DaoHarvestV2TransitionCell | undefined> {
    const page = await this.#runtime.findCellsPaged(
      {
        script: lock,
        scriptType: "lock",
        scriptSearchMode: "exact",
        filter: { outputDataLenRange: [0, 1] },
        withData: true,
      },
      "asc",
      MAX_CELLS,
    );
    for (const candidate of page.cells) {
      const live = await this.#runtime.getCellLive(candidate.outPoint);
      if (!live) continue;
      const cell = chainCell(live);
      if (cell.type === null && cell.data === "0x" && BigInt(cell.capacity) >= minimumCapacity) {
        return cell;
      }
    }
    return undefined;
  }

  async #plainCell(
    lock: ScriptIdentity,
    minimumCapacity: bigint,
  ): Promise<DaoHarvestV2TransitionCell> {
    const cell = await this.#findPlainCell(lock, minimumCapacity);
    if (cell) return cell;
    throw new Error("executor funding cell is unavailable");
  }

  async #ensureAccumulator(
    state: CurrentState,
    lock: ScriptIdentity,
  ): Promise<DaoHarvestV2TransitionCell | undefined> {
    const existing = await this.#findPlainCell(lock, 1n);
    if (existing) return existing;
    const lockHash = parseHash32(scriptToHash(lock));
    const pending = this.#provisions.get(lockHash);
    if (pending !== undefined) {
      const status = await this.#runtime.getTransactionStatus(pending);
      if (!status) return undefined;
      if (status?.status === "committed") {
        const indexed = await this.#findPlainCell(lock, 1n);
        if (indexed) this.#provisions.delete(lockHash);
        return indexed;
      }
      if (status.status !== "rejected") return undefined;
      this.#provisions.delete(lockHash);
    }
    const accumulatorCapacity = minimumPlainCellCapacity(lock);
    const ownerMinimum = minimumPlainCellCapacity(this.#ownerLock);
    const funding = await this.#plainCell(
      this.#ownerLock,
      accumulatorCapacity + ownerMinimum + this.#transactionFee,
    );
    const change = BigInt(funding.capacity) - accumulatorCapacity - this.#transactionFee;
    const transaction: UnsignedDeadlineTransaction = Object.freeze({
      version: "0x0",
      cellDeps: Object.freeze([state.deployment.transition.secp256k1Blake160.cellDep]),
      headerDeps: Object.freeze([]),
      inputs: Object.freeze([
        Object.freeze({
          since: "0x0" as const,
          previousOutput: Object.freeze({
            txHash: funding.outPoint.txHash,
            index: `0x${BigInt(funding.outPoint.index).toString(16)}` as Hex,
          }),
        }),
      ]),
      outputs: Object.freeze([
        Object.freeze({
          capacity: `0x${accumulatorCapacity.toString(16)}` as Hex,
          lock,
          type: null,
        }),
        Object.freeze({
          capacity: `0x${change.toString(16)}` as Hex,
          lock: this.#ownerLock,
          type: null,
        }),
      ]),
      outputsData: Object.freeze(["0x" as const, "0x" as const]),
      witnesses: Object.freeze(["0x" as const]),
    });
    const signed = signOperatorFeeInput(transaction, this.#privateKey, 0);
    if (serializedTransactionBytes(signed) > 2_048n) {
      throw new Error("operator accumulator provisioning transaction is too large");
    }
    const cycles = await this.#runtime.dryRun(signed as never);
    if (BigInt(cycles.toString()) > this.#maximumCycles) {
      throw new Error("operator accumulator provisioning exceeds the cycle limit");
    }
    if (!(await this.#runtime.getCellLive(funding.outPoint))) {
      throw new Error("operator accumulator funding changed after dry-run");
    }
    const transactionHash = parseHash32(await this.#runtime.send(signed as never));
    this.#provisions.set(lockHash, transactionHash);
    this.#logger.info(
      "executor.dao_harvest_v2.accumulator_submitted",
      "V2 operator accumulator provisioning submitted",
      { lockHash, transactionHash, cycles: cycles.toString() },
    );
    return undefined;
  }

  async #prepareAccumulator(state: CurrentState): Promise<DaoHarvestV2TransitionCell> {
    const index = Number(state.sourceWitness.prepare_accumulator_output_index);
    if (index === 0xffff_ffff) throw new Error("credited prepare accumulator index is absent");
    const live = await this.#runtime.getCellLive({
      txHash: state.source.transaction.hash(),
      index,
    });
    if (!live) throw new Error("credited prepare accumulator is no longer live");
    const cell = chainCell(live);
    const credit = state.prepareCreditBytes
      ? DaoHarvestPrepareCreditV2.unpack(state.prepareCreditBytes)
      : undefined;
    if (
      !credit ||
      scriptToHash(cell.lock) !== hash32FromBytes(Uint8Array.from(credit.preparer_lock_hash))
    ) {
      throw new Error("credited prepare accumulator does not match prepare credit");
    }
    return cell;
  }

  async #execute(
    state: CurrentState,
    operationValue: "preferred_prepare" | "fallback_prepare" | "preferred_claim" | "fallback_claim",
    identity: DaoHarvestV2OperatorIdentity,
    tipEpoch: bigint,
    accumulatorLock: ScriptIdentity,
  ): Promise<void> {
    const accumulator = await this.#ensureAccumulator(state, accumulatorLock);
    if (!accumulator) return;
    const feeCell = await this.#plainCell(
      this.#ownerLock,
      this.#transactionFee + minimumPlainCellCapacity(this.#ownerLock),
    );
    const common = {
      deployment: state.deployment.transition,
      policyScriptHash: state.policyScriptHash,
      payload: state.payloadBytes,
      progress: state.progressBytes,
      job: state.jobCell,
      vault: state.vaultCell,
      accumulator,
      feeCell,
      operatorOwnerLock: this.#ownerLock,
      transactionFee: this.#transactionFee,
    } as const;
    const preferredSince = decodeAbsoluteEpochSince(state.job.not_before.toString());
    const executionSince = operationValue.startsWith("fallback")
      ? encodeAbsoluteEpochSince(
          addEpochFractions(
            preferredSince,
            decodeRelativeEpochSince(state.payload.takeover_delay_epochs.toString()),
          ),
        )
      : BigInt(state.job.not_before.toString());
    let built;
    let expectedServicePayment: bigint;
    let servicePaymentCap: bigint;
    if (operationValue === "preferred_prepare" || operationValue === "fallback_prepare") {
      const depositSource = await this.#committed(state.vaultCell.outPoint.txHash);
      if (!depositSource.blockHash || depositSource.blockNumber === undefined) {
        throw new Error("DAO deposit inclusion header is unavailable");
      }
      const depositBlock = await this.#runtime.getBlockByHash(depositSource.blockHash);
      if (!depositBlock) throw new Error("DAO deposit block is unavailable");
      const boundary = addEpochFractions(
        decodeAbsoluteEpochSince(state.job.not_before.toString()),
        decodeRelativeEpochSince(state.payload.prepare_buffer_epochs.toString()),
      );
      built = buildDaoHarvestV2PrepareTransition({
        ...common,
        operation: operationValue,
        ...(operationValue === "fallback_prepare" ? { operatorProof: state.proof } : {}),
        depositHeaderHash: parseHash32(depositBlock.header.hash),
        depositBlockNumber: BigInt(depositBlock.header.number),
        executionSince,
        claimSince: encodeAbsoluteEpochSince(boundary),
      });
      expectedServicePayment = parseShannons(state.payload.prepare_service_fee.toString());
      servicePaymentCap = expectedServicePayment;
    } else {
      if (!state.prepareCreditBytes) throw new Error("claim prepare credit is unavailable");
      const depositBlockNumber = blockNumberFromDaoData(state.vaultCell.data);
      if (state.source.blockNumber === undefined) {
        throw new Error("DAO prepare block number is unavailable");
      }
      const [depositBlock, prepareBlock] = await Promise.all([
        this.#runtime.getBlockByNumber(depositBlockNumber),
        this.#runtime.getBlockByNumber(state.source.blockNumber),
      ]);
      if (!depositBlock || !prepareBlock) throw new Error("DAO claim headers are unavailable");
      const prepareAccumulator = await this.#prepareAccumulator(state);
      const tip = await this.#runtime.getTipHeader();
      const buffer = decodeRelativeEpochSince(state.payload.prepare_buffer_epochs.toString());
      const margin = decodeRelativeEpochSince(state.payload.confirmation_margin_epochs.toString());
      const anticipatedDeposit = addEpochs(parseEpoch(packClientEpoch(tip.epoch)), 1n);
      const next = selectDaoPrepareWindow({
        deposit: anticipatedDeposit,
        tip: anticipatedDeposit,
        bufferEpochs: buffer.number,
        confirmationMarginEpochs: margin.number,
      });
      built = buildDaoHarvestV2ClaimTransition({
        ...common,
        operation: operationValue,
        prepareCredit: state.prepareCreditBytes,
        compensation: state.compensationCell,
        prepareAccumulator,
        ...(scriptToHash(prepareAccumulator.lock) === scriptToHash(accumulator.lock)
          ? {}
          : { claimAccumulator: accumulator }),
        depositHeaderHash: parseHash32(depositBlock.header.hash),
        prepareHeaderHash: parseHash32(prepareBlock.header.hash),
        depositAccumulatedRate: clientDaoAccumulatedRate(depositBlock.header.dao),
        prepareAccumulatedRate: clientDaoAccumulatedRate(prepareBlock.header.dao),
        vaultOccupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
        executionSince,
        ...(BigInt(state.job.remaining_runs.toString()) > 1n
          ? { nextPrepareSince: encodeAbsoluteEpochSince(next.startsAt) }
          : {}),
      });
      const maximum = calculateDaoMaximumWithdraw({
        principal: state.payload.principal_capacity.toString(),
        occupiedCapacity: DAO_HARVEST_VAULT_OCCUPIED_CAPACITY,
        depositAccumulatedRate: clientDaoAccumulatedRate(depositBlock.header.dao),
        withdrawingAccumulatedRate: clientDaoAccumulatedRate(prepareBlock.header.dao),
      });
      const gross = maximum - BigInt(state.payload.principal_capacity.toString());
      const prepareCap = BigInt(state.payload.prepare_service_fee.toString());
      const preparePayment = gross < prepareCap ? gross : prepareCap;
      const afterPrepare = gross - preparePayment;
      const claimCap = BigInt(state.payload.claim_service_fee.toString());
      const claimPayment = afterPrepare < claimCap ? afterPrepare : claimCap;
      expectedServicePayment =
        scriptToHash(prepareAccumulator.lock) === scriptToHash(accumulator.lock)
          ? preparePayment + claimPayment
          : claimPayment;
      servicePaymentCap =
        scriptToHash(prepareAccumulator.lock) === scriptToHash(accumulator.lock)
          ? prepareCap + claimCap
          : claimCap;
    }
    const feeInputIndex = built.transaction.inputs.length - 1;
    const signed = signOperatorFeeInput(built.transaction, this.#privateKey, feeInputIndex);
    const cycles = await this.#runtime.dryRun(signed as never);
    const limitOperation = operationValue.includes("prepare") ? "prepare" : "claim";
    const limit = HARVEST_V2_TRANSACTION_LIMITS[limitOperation];
    const signedBytes = serializedTransactionBytes(signed);
    const feeRate = (this.#transactionFee * 1_000n + signedBytes - 1n) / signedBytes;
    assertHarvestV2TransactionWithinLimits({
      operation: limitOperation,
      transaction: signed,
      dryRunCycles: cycles.toString(),
      feeRatePerKilobyte: feeRate,
      networkFee: this.#transactionFee,
      jobInputCount: 1,
      jobOutputCount:
        BigInt(state.job.remaining_runs.toString()) === 1n && limitOperation === "claim" ? 0 : 1,
    });
    const consumedInputs = built.transaction.inputs.map((input) =>
      parseOutPoint({
        txHash: input.previousOutput.txHash,
        index: input.previousOutput.index,
      }),
    );
    const plan = createDaoHarvestV2ExecutionPlan({
      adapterId: DAO_HARVEST_V2_ADAPTER_ID,
      record: state.schedule,
      tipEpoch,
      operatorLockHash: identity,
      consumedInputs,
      economics: {
        signedTransactionBytes: Number(signedBytes),
        maximumSignedTransactionBytes: Number(limit.maximumBytes),
        feeRatePerKilobyte: feeRate,
        minimumFeeRatePerKilobyte: 1n,
        maximumFeeRatePerKilobyte: limit.maximumFeeRatePerKilobyte,
        maximumNetworkFee: limit.maximumFee,
        expectedServicePayment,
        servicePaymentCap,
        minimumProfitMargin: this.#minimumMargin,
      },
      dryRun: {
        cycles: cycles.toString(),
        maximumCycles:
          this.#maximumCycles < limit.maximumCycles ? this.#maximumCycles : limit.maximumCycles,
      },
    });
    const live = await Promise.all(consumedInputs.map((point) => this.#runtime.getCellLive(point)));
    if (live.some((cell) => cell === undefined))
      throw new Error("V2 execution inputs changed after dry-run");
    const refreshedTip = await this.#runtime.getTipHeader();
    validateDaoHarvestV2Reload(plan, {
      record: state.schedule,
      tipEpoch: packClientEpoch(refreshedTip.epoch),
      operatorLockHash: identity,
      consumedInputs,
    });
    const transactionHash = parseHash32(await this.#runtime.send(signed as never));
    this.#attempts.set(
      state.schedule.jobId,
      Object.freeze({
        transactionHash,
        jobId: state.schedule.jobId,
        operation: operationValue,
      }),
    );
    this.#logger.info("executor.dao_harvest_v2.submitted", "V2 harvest transition submitted", {
      jobId: state.schedule.jobId,
      operation: operationValue,
      transactionHash,
      cycles: cycles.toString(),
    });
  }

  async #reconcile(): Promise<void> {
    for (const [jobId, attempt] of this.#attempts) {
      const response = await this.#runtime.getTransactionStatus(attempt.transactionHash);
      if (!response || response.status === "rejected") {
        this.#attempts.delete(jobId);
        this.#logger.error("executor.dao_harvest_v2.dropped", "V2 harvest transition was dropped", {
          jobId,
          operation: attempt.operation,
          transactionHash: attempt.transactionHash,
        });
      } else if (response.status === "committed") {
        this.#attempts.delete(jobId);
        this.#logger.info("executor.dao_harvest_v2.committed", "V2 harvest transition committed", {
          jobId,
          operation: attempt.operation,
          transactionHash: attempt.transactionHash,
        });
      }
    }
  }
}
