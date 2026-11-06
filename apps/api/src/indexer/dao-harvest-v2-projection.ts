import type { ClientBlock } from "@ckb-ccc/shell";
import { hexToBytes, scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  DAO_HARVEST_V2_ABSENT_INDEX,
  addEpochFractions,
  assertDaoHarvestV2WitnessLayout,
  decodeAbsoluteEpochSince,
  decodeDaoHarvestV2CompensationLockArgs,
  decodeDaoHarvestV2FallbackOperatorProof,
  decodeRelativeEpochSince,
  deriveDaoHarvestV2PayloadHash,
  deriveDaoHarvestV2PrepareCreditHash,
  deriveDaoHarvestV2ProgressHash,
  encodeAbsoluteEpochSince,
  hash32FromBytes,
  parseHash32,
  parseOutputIndex,
  parseShannons,
  subtractEpochFractions,
  type Hash32,
  type OutPoint,
  type ScriptIdentity,
  type Shannons,
} from "@ckb-automata/core";
import {
  DaoHarvestEnvelopeV2,
  DaoHarvestPayloadV2,
  DaoHarvestPrepareCreditV2,
  DaoHarvestProgressV2,
  DaoHarvestWitnessV2,
  JobDataV1,
} from "@ckb-automata/molecule";

type Hex = `0x${string}`;
interface ProjectedOutPoint {
  readonly txHash: Hash32;
  readonly index: string;
}

export const DAO_HARVEST_V2_OPERATION_NAMES = Object.freeze([
  "setup",
  "preferred_prepare",
  "fallback_prepare",
  "preferred_claim",
  "fallback_claim",
  "owner_complete",
  "sweep",
  "close",
  "rotate",
  "recover",
] as const);
export type DaoHarvestV2ProjectedOperation = (typeof DAO_HARVEST_V2_OPERATION_NAMES)[number];

export interface DaoHarvestV2ProjectionDeployment {
  readonly networkId: string;
  readonly jobLock: Omit<ScriptIdentity, "args">;
  readonly policy: ScriptIdentity;
  readonly vaultLock: Omit<ScriptIdentity, "args">;
  readonly compensationLock: Omit<ScriptIdentity, "args">;
  readonly daoTypeHash: Hash32;
}

export interface DaoHarvestV2ResolvedInput {
  readonly outPoint: OutPoint;
  readonly capacity: Shannons;
  readonly lock: ScriptIdentity;
  readonly type: ScriptIdentity | null;
  readonly data: Hex;
}

export interface DaoHarvestV2ProjectionEvent {
  readonly eventId: string;
  readonly networkId: string;
  readonly jobId: Hash32;
  readonly operation: DaoHarvestV2ProjectedOperation;
  readonly transactionHash: Hash32;
  readonly transactionIndex: string;
  readonly blockNumber: string;
  readonly blockHash: Hash32;
  readonly canonical: boolean;
  readonly payloadHash: Hash32;
  readonly ownerLockHash: Hash32;
  readonly payoutLockHash: Hash32;
  readonly principalCapacity: string;
  readonly compensationSeedCapacity: string;
  readonly cycleIndex: string;
  readonly totalCycles: string;
  readonly lifecycleState: "deposited" | "withdrawing" | "completed" | "recovered" | "closed";
  readonly jobOutPoint?: ProjectedOutPoint | null;
  readonly vaultOutPoint?: ProjectedOutPoint | null;
  readonly compensationOutPoint?: ProjectedOutPoint | null;
  readonly compensationCapacity?: string;
  readonly accumulatedCompensation?: string;
  readonly prepareCredit: {
    readonly cycleIndex: string;
    readonly preparerLockHash: Hash32;
    readonly preparedVaultOutputIndex: string;
    readonly jobOutputIndex: string;
  } | null;
  readonly operatorWindow: {
    readonly preferredFromSince: string;
    readonly fallbackFromSince: string;
    readonly prepareCutoffSince: string | null;
  } | null;
  readonly serviceSettlement: {
    readonly status: "not_applicable" | "complete" | "partial";
    readonly preparePaid: string | null;
    readonly claimPaid: string | null;
  };
  readonly projectionCompleteness: "complete" | "partial";
}

export interface DaoHarvestV2ProjectionExtraction {
  readonly events: readonly DaoHarvestV2ProjectionEvent[];
  readonly malformed: number;
  readonly partial: number;
}

export interface DaoHarvestV2Snapshot {
  readonly networkId: string;
  readonly jobId: Hash32;
  readonly ownerLockHash: Hash32;
  readonly payoutLockHash: Hash32;
  readonly payloadHash: Hash32;
  readonly lifecycleState: DaoHarvestV2ProjectionEvent["lifecycleState"];
  readonly cycleIndex: string;
  readonly totalCycles: string;
  readonly principalCapacity: string;
  readonly compensationCapacity: string | null;
  readonly accumulatedCompensation: string | null;
  readonly jobOutPoint: ProjectedOutPoint | null;
  readonly vaultOutPoint: ProjectedOutPoint | null;
  readonly compensationOutPoint: ProjectedOutPoint | null;
  readonly prepareCredit: DaoHarvestV2ProjectionEvent["prepareCredit"];
  readonly operatorWindow: DaoHarvestV2ProjectionEvent["operatorWindow"];
  readonly serviceSettlement: {
    readonly status: "complete" | "partial";
    readonly preparePaid: string;
    readonly claimPaid: string;
    readonly lastOperation: DaoHarvestV2ProjectedOperation;
  };
  readonly canonicalTxStatus: "committed";
  readonly projectionCompleteness: "complete" | "partial";
  readonly source: {
    readonly blockNumber: string;
    readonly blockHash: Hash32;
    readonly transactionHash: Hash32;
  };
}

function witnessField(witness: string, field: "input" | "output"): Uint8Array | null {
  if (!/^0x(?:[0-9a-f]{2})*$/.test(witness)) return null;
  const bytes = hexToBytes(witness);
  if (bytes.length < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const total = view.getUint32(0, true);
  const inputOffset = view.getUint32(8, true);
  const outputOffset = view.getUint32(12, true);
  if (total !== bytes.length || inputOffset > outputOffset || outputOffset > total) return null;
  const start = field === "input" ? inputOffset : outputOffset;
  const end = field === "input" ? outputOffset : total;
  const encoded = bytes.slice(start, end);
  if (encoded.length < 4) return null;
  const length = new DataView(encoded.buffer, encoded.byteOffset, 4).getUint32(0, true);
  return length === encoded.length - 4 ? encoded.slice(4) : null;
}

function scriptMatches(
  actual:
    | { readonly codeHash: string; readonly hashType: string; readonly args: string }
    | null
    | undefined,
  expected: { readonly codeHash: string; readonly hashType: string },
): boolean {
  return actual?.codeHash === expected.codeHash && actual.hashType === expected.hashType;
}

function outPoint(txHash: Hash32, outputIndex: number): OutPoint {
  return Object.freeze({ txHash, index: parseOutputIndex(BigInt(outputIndex)) });
}

function projectedOutPoint(txHash: Hash32, outputIndex: number): ProjectedOutPoint {
  return Object.freeze({ txHash, index: parseOutputIndex(BigInt(outputIndex)).toString() });
}

function outPointKey(value: OutPoint): string {
  return `${value.txHash}:${value.index.toString()}`;
}

function byteHash(value: readonly number[]): Hash32 {
  return hash32FromBytes(Uint8Array.from(value));
}

function index(value: unknown): number {
  const parsed = Number(String(value));
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new RangeError("V2 witness index is invalid");
  }
  return parsed;
}

function outputCapacity(output: { readonly capacity: { toString(): string } | string }): Shannons {
  return parseShannons(output.capacity.toString());
}

function resolvedMap(
  inputs: readonly DaoHarvestV2ResolvedInput[],
): ReadonlyMap<string, DaoHarvestV2ResolvedInput> {
  const entries = inputs.map((cell) => [outPointKey(cell.outPoint), cell] as const);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    throw new RangeError("resolved V2 inputs contain duplicate outpoints");
  }
  return new Map(entries);
}

function settlementDelta(
  transaction: ClientBlock["transactions"][number],
  resolved: ReadonlyMap<string, DaoHarvestV2ResolvedInput>,
  inputIndex: number,
  outputIndex: number,
): string | null {
  if (inputIndex === DAO_HARVEST_V2_ABSENT_INDEX && outputIndex === DAO_HARVEST_V2_ABSENT_INDEX) {
    return "0";
  }
  if (inputIndex === DAO_HARVEST_V2_ABSENT_INDEX || outputIndex === DAO_HARVEST_V2_ABSENT_INDEX) {
    throw new Error("operator accumulator index pair is incomplete");
  }
  const input = transaction.inputs[inputIndex];
  const output = transaction.outputs[outputIndex];
  if (!input || !output) throw new Error("operator accumulator index is out of bounds");
  const previous = outPoint(
    parseHash32(input.previousOutput.txHash.toString()),
    Number(BigInt(input.previousOutput.index)),
  );
  const resolvedInput = resolved.get(outPointKey(previous));
  if (!resolvedInput) return null;
  const outputValue = outputCapacity(output);
  if (outputValue < resolvedInput.capacity) throw new Error("operator accumulator decreased");
  return (outputValue - resolvedInput.capacity).toString();
}

export function extractDaoHarvestV2ProjectionEvents(
  block: ClientBlock,
  deployment: DaoHarvestV2ProjectionDeployment,
  resolvedInputs: readonly DaoHarvestV2ResolvedInput[] = [],
): DaoHarvestV2ProjectionExtraction {
  const events: DaoHarvestV2ProjectionEvent[] = [];
  const resolved = resolvedMap(resolvedInputs);
  let malformed = 0;
  let partial = 0;
  const blockHash = parseHash32(block.header.hash);
  const blockNumber = BigInt(block.header.number).toString();

  for (const [transactionIndex, transaction] of block.transactions.entries()) {
    const relevantOutput = transaction.outputs.some(
      (output) =>
        scriptMatches(output.type, deployment.policy) ||
        scriptMatches(output.lock, deployment.vaultLock) ||
        scriptMatches(output.lock, deployment.compensationLock),
    );
    const relevantInput = transaction.inputs.some((input) => {
      const previous = outPoint(
        parseHash32(input.previousOutput.txHash.toString()),
        Number(BigInt(input.previousOutput.index)),
      );
      const cell = resolved.get(outPointKey(previous));
      return (
        cell !== undefined &&
        (scriptMatches(cell.type, deployment.policy) ||
          scriptMatches(cell.lock, deployment.vaultLock) ||
          scriptMatches(cell.lock, deployment.compensationLock))
      );
    });
    if (!relevantOutput && !relevantInput) continue;
    const inputType = witnessField(String(transaction.witnesses[0] ?? "0x"), "input");
    const outputType = witnessField(String(transaction.witnesses[0] ?? "0x"), "output");
    if (!inputType || !outputType) {
      malformed += 1;
      continue;
    }
    try {
      const witness = DaoHarvestWitnessV2.unpack(inputType);
      const envelope = DaoHarvestEnvelopeV2.unpack(outputType);
      const operationValue = Number(witness.operation);
      const operation = DAO_HARVEST_V2_OPERATION_NAMES[operationValue];
      if (!operation || Number(witness.version) !== 2) throw new Error("unsupported V2 witness");
      if (Number(witness.flags) !== 0) throw new Error("unsupported V2 witness flags");
      assertDaoHarvestV2WitnessLayout(operationValue as never, Number(witness.flags), {
        jobInputIndex: index(witness.job_input_index),
        vaultInputIndex: index(witness.vault_input_index),
        compensationInputIndex: index(witness.compensation_input_index),
        identityInputIndex: index(witness.identity_input_index),
        prepareAccumulatorInputIndex: index(witness.prepare_accumulator_input_index),
        claimAccumulatorInputIndex: index(witness.claim_accumulator_input_index),
        jobOutputIndex: index(witness.job_output_index),
        vaultOutputIndex: index(witness.vault_output_index),
        compensationOutputIndex: index(witness.compensation_output_index),
        prepareAccumulatorOutputIndex: index(witness.prepare_accumulator_output_index),
        claimAccumulatorOutputIndex: index(witness.claim_accumulator_output_index),
      });
      const payloadBytes = Uint8Array.from(envelope.payload);
      const progressBytes = Uint8Array.from(envelope.progress);
      const creditBytes = Uint8Array.from(envelope.prepare_credit);
      const payload = DaoHarvestPayloadV2.unpack(payloadBytes);
      const inputProgress = DaoHarvestProgressV2.unpack(progressBytes);
      if (Number(payload.version) !== 2 || Number(inputProgress.version) !== 2) {
        throw new Error("unsupported V2 payload");
      }
      const policyScriptHash = parseHash32(scriptToHash(deployment.policy));
      const currentPayloadHash = hash32FromBytes(
        deriveDaoHarvestV2PayloadHash(hexToBytes(policyScriptHash), payloadBytes),
      );
      const progressHash = hash32FromBytes(deriveDaoHarvestV2ProgressHash(progressBytes));
      if (
        byteHash(witness.payload_hash) !== currentPayloadHash ||
        byteHash(witness.progress_hash) !== progressHash
      ) {
        throw new Error("V2 witness commitment mismatch");
      }
      const credit =
        creditBytes.length === 0 ? null : DaoHarvestPrepareCreditV2.unpack(creditBytes);
      const expectedCreditHash =
        credit === null
          ? (`0x${"00".repeat(32)}` as Hash32)
          : hash32FromBytes(deriveDaoHarvestV2PrepareCreditHash(creditBytes));
      if (
        byteHash(witness.prepare_credit_hash) !== expectedCreditHash ||
        (![1, 2].includes(operationValue) &&
          byteHash(inputProgress.prepare_credit_hash) !== expectedCreditHash) ||
        ([1, 2].includes(operationValue) &&
          byteHash(inputProgress.prepare_credit_hash) !== `0x${"00".repeat(32)}`)
      ) {
        throw new Error("V2 prepare credit mismatch");
      }
      const successorBytes = Uint8Array.from(envelope.successor_payload);
      const activePayload =
        operationValue === 8 ? DaoHarvestPayloadV2.unpack(successorBytes) : payload;
      const activePayloadBytes = operationValue === 8 ? successorBytes : payloadBytes;
      const payloadHash = hash32FromBytes(
        deriveDaoHarvestV2PayloadHash(hexToBytes(policyScriptHash), activePayloadBytes),
      );
      const proofRequired = [0, 2, 8].includes(operationValue);
      const operatorProof = Uint8Array.from(envelope.operator_proof);
      if (proofRequired === (operatorProof.length === 0)) {
        throw new Error("V2 operator proof shape is invalid");
      }
      if (proofRequired) {
        decodeDaoHarvestV2FallbackOperatorProof(
          operatorProof,
          Uint8Array.from(activePayload.fallback_prepare_executor_set_hash),
        );
      }

      const txHash = parseHash32(transaction.hash());
      const jobCandidates = transaction.outputs.flatMap((output, outputIndex) =>
        scriptMatches(output.lock, deployment.jobLock) &&
        output.lock.args === "0x" &&
        scriptMatches(output.type, deployment.policy) &&
        output.type?.args === deployment.policy.args
          ? [{ outputIndex, output }]
          : [],
      );
      if (jobCandidates.length > 1) throw new Error("ambiguous V2 Job output");
      const jobCandidate = jobCandidates[0];
      const job = jobCandidate
        ? JobDataV1.unpack(hexToBytes(transaction.outputsData[jobCandidate.outputIndex] ?? "0x"))
        : null;
      const activeProgressBytes = [1, 2].includes(operationValue)
        ? DaoHarvestProgressV2.pack({
            version: 2,
            state: 1,
            cycle_index: inputProgress.cycle_index,
            prepare_credit_hash: [...hexToBytes(expectedCreditHash)],
          })
        : [3, 4, 5].includes(operationValue) && job !== null
          ? DaoHarvestProgressV2.pack({
              version: 2,
              state: 0,
              cycle_index: Number(inputProgress.cycle_index) + 1,
              prepare_credit_hash: Array(32).fill(0),
            })
          : progressBytes;
      const activeProgress = DaoHarvestProgressV2.unpack(activeProgressBytes);
      const activeProgressHash = hash32FromBytes(
        deriveDaoHarvestV2ProgressHash(activeProgressBytes),
      );
      if (
        job &&
        (byteHash(job.payload_hash) !== payloadHash ||
          byteHash(job.trigger_params_hash) !== activeProgressHash ||
          byteHash(job.policy_script_hash) !== policyScriptHash)
      ) {
        throw new Error("V2 Job commitment mismatch");
      }

      let jobId = job ? byteHash(job.job_id) : credit ? byteHash(credit.job_id) : undefined;
      if (!jobId) {
        for (const input of transaction.inputs) {
          const previous = outPoint(
            parseHash32(input.previousOutput.txHash.toString()),
            Number(BigInt(input.previousOutput.index)),
          );
          const cell = resolved.get(outPointKey(previous));
          if (!cell || !scriptMatches(cell.lock, deployment.compensationLock)) continue;
          jobId = hash32FromBytes(
            decodeDaoHarvestV2CompensationLockArgs(hexToBytes(cell.lock.args)).jobId,
          );
          break;
        }
      }
      if (!jobId) throw new Error("V2 Job identity is unavailable");

      const vaultCandidates = transaction.outputs.flatMap((output, outputIndex) => {
        if (
          !scriptMatches(output.lock, deployment.vaultLock) ||
          output.type === undefined ||
          parseHash32(scriptToHash(output.type)) !== deployment.daoTypeHash
        ) {
          return [];
        }
        const args = hexToBytes(output.lock.args);
        return args.length === 160 && hash32FromBytes(args.slice(0, 32)) === jobId
          ? [{ outputIndex, output }]
          : [];
      });
      const compensationCandidates = transaction.outputs.flatMap((output, outputIndex) => {
        if (!scriptMatches(output.lock, deployment.compensationLock)) return [];
        const args = decodeDaoHarvestV2CompensationLockArgs(hexToBytes(output.lock.args));
        return hash32FromBytes(args.jobId) === jobId &&
          hash32FromBytes(args.payloadHash) === payloadHash
          ? [{ outputIndex, output }]
          : [];
      });
      if (vaultCandidates.length > 1 || compensationCandidates.length > 1) {
        throw new Error("ambiguous V2 state output");
      }

      const vault = vaultCandidates[0];
      const compensation = compensationCandidates[0];
      const state = Number(activeProgress.state);
      if (state !== 0 && state !== 1) throw new Error("invalid V2 progress state");
      const terminal = !job;
      const validState =
        (operationValue === 0 && state === 0 && !terminal) ||
        ([1, 2].includes(operationValue) && state === 1 && !terminal) ||
        ([3, 4, 5].includes(operationValue) && (state === 0 || terminal)) ||
        ([6, 8].includes(operationValue) && !terminal) ||
        ([7, 9].includes(operationValue) && terminal);
      if (!validState) throw new Error("V2 operation and progress state disagree");
      const lifecycleState =
        operation === "recover"
          ? "recovered"
          : operation === "close"
            ? "closed"
            : terminal
              ? "completed"
              : state === 0
                ? "deposited"
                : "withdrawing";
      const notBefore = job ? decodeAbsoluteEpochSince(job.not_before.toString()) : null;
      const fallbackFrom =
        notBefore === null
          ? null
          : addEpochFractions(
              notBefore,
              decodeRelativeEpochSince(activePayload.takeover_delay_epochs.toString()),
            );
      const prepareCutoff =
        lifecycleState === "deposited" && notBefore !== null
          ? subtractEpochFractions(
              addEpochFractions(
                notBefore,
                decodeRelativeEpochSince(activePayload.prepare_buffer_epochs.toString()),
              ),
              decodeRelativeEpochSince(activePayload.confirmation_margin_epochs.toString()),
            )
          : null;

      const prepareInputIndex = index(witness.prepare_accumulator_input_index);
      const prepareOutputIndex = index(witness.prepare_accumulator_output_index);
      const claimInputIndex = index(witness.claim_accumulator_input_index);
      const claimOutputIndex = index(witness.claim_accumulator_output_index);
      const settlementApplicable = [3, 4, 5, 9].includes(operationValue);
      const preparePaid = settlementApplicable
        ? settlementDelta(transaction, resolved, prepareInputIndex, prepareOutputIndex)
        : "0";
      const claimPaid = settlementApplicable
        ? settlementDelta(transaction, resolved, claimInputIndex, claimOutputIndex)
        : "0";
      const isPartial = settlementApplicable && (preparePaid === null || claimPaid === null);
      if (isPartial) partial += 1;
      const compensationCapacity = compensation ? outputCapacity(compensation.output) : undefined;
      const seed = parseShannons(activePayload.compensation_seed_capacity.toString());
      if (compensationCapacity !== undefined && compensationCapacity < seed) {
        throw new Error("V2 Compensation Cell is below its reserve");
      }
      const jobOutput = jobCandidate ? projectedOutPoint(txHash, jobCandidate.outputIndex) : null;
      const vaultOutput = vault ? projectedOutPoint(txHash, vault.outputIndex) : undefined;
      const compensationOutput = compensation
        ? projectedOutPoint(txHash, compensation.outputIndex)
        : undefined;
      events.push(
        Object.freeze({
          eventId: `${txHash}:${transactionIndex}:${operation}`,
          networkId: deployment.networkId,
          jobId,
          operation,
          transactionHash: txHash,
          transactionIndex: transactionIndex.toString(),
          blockNumber,
          blockHash,
          canonical: true,
          payloadHash,
          ownerLockHash: byteHash(activePayload.owner_lock_hash),
          payoutLockHash: byteHash(activePayload.payout_lock_hash),
          principalCapacity: activePayload.principal_capacity.toString(),
          compensationSeedCapacity: seed.toString(),
          cycleIndex: activeProgress.cycle_index.toString(),
          totalCycles: activePayload.total_cycles.toString(),
          lifecycleState,
          jobOutPoint: jobOutput,
          ...(vaultOutput === undefined
            ? operation === "recover"
              ? { vaultOutPoint: null }
              : {}
            : { vaultOutPoint: vaultOutput }),
          ...(compensationOutput === undefined
            ? operation === "close" || operation === "recover"
              ? { compensationOutPoint: null }
              : {}
            : { compensationOutPoint: compensationOutput }),
          ...(compensationCapacity === undefined
            ? {}
            : {
                compensationCapacity: compensationCapacity.toString(),
                accumulatedCompensation: (compensationCapacity - seed).toString(),
              }),
          prepareCredit:
            credit === null
              ? null
              : Object.freeze({
                  cycleIndex: credit.cycle_index.toString(),
                  preparerLockHash: byteHash(credit.preparer_lock_hash),
                  preparedVaultOutputIndex: credit.prepared_vault_output_index.toString(),
                  jobOutputIndex: credit.job_output_index.toString(),
                }),
          operatorWindow:
            notBefore === null || fallbackFrom === null
              ? null
              : Object.freeze({
                  preferredFromSince: encodeAbsoluteEpochSince(notBefore).toString(),
                  fallbackFromSince: encodeAbsoluteEpochSince(fallbackFrom).toString(),
                  prepareCutoffSince:
                    prepareCutoff === null
                      ? null
                      : encodeAbsoluteEpochSince(prepareCutoff).toString(),
                }),
          serviceSettlement: Object.freeze({
            status: settlementApplicable ? (isPartial ? "partial" : "complete") : "not_applicable",
            preparePaid,
            claimPaid,
          }),
          projectionCompleteness: isPartial ? "partial" : "complete",
        }),
      );
    } catch {
      malformed += 1;
    }
  }
  return Object.freeze({ events: Object.freeze(events), malformed, partial });
}

function compareEvents(left: DaoHarvestV2ProjectionEvent, right: DaoHarvestV2ProjectionEvent) {
  const block = BigInt(left.blockNumber) - BigInt(right.blockNumber);
  if (block !== 0n) return block < 0n ? -1 : 1;
  const transaction = BigInt(left.transactionIndex) - BigInt(right.transactionIndex);
  if (transaction !== 0n) return transaction < 0n ? -1 : 1;
  return left.eventId.localeCompare(right.eventId);
}

export function rebuildDaoHarvestV2Snapshot(
  sourceEvents: readonly DaoHarvestV2ProjectionEvent[],
): DaoHarvestV2Snapshot | undefined {
  const unique = new Map<string, DaoHarvestV2ProjectionEvent>();
  for (const event of sourceEvents) {
    const existing = unique.get(event.eventId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
      throw new Error("duplicate V2 event contains contradictory chain evidence");
    }
    unique.set(event.eventId, event);
  }
  const events = [...unique.values()].filter(({ canonical }) => canonical).toSorted(compareEvents);
  if (events.length === 0) return undefined;
  const first = events[0]!;
  if (events.some((event) => event.networkId !== first.networkId || event.jobId !== first.jobId)) {
    throw new Error("V2 snapshot rebuild mixed different jobs");
  }
  let snapshot: DaoHarvestV2Snapshot | undefined;
  let preparePaid = 0n;
  let claimPaid = 0n;
  for (const event of events) {
    if (
      snapshot &&
      (event.ownerLockHash !== snapshot.ownerLockHash ||
        event.payoutLockHash !== snapshot.payoutLockHash ||
        (event.operation !== "rotate" && event.payloadHash !== snapshot.payloadHash))
    ) {
      throw new Error("V2 event changes an unrotatable commitment");
    }
    if (event.serviceSettlement.preparePaid !== null) {
      preparePaid += BigInt(event.serviceSettlement.preparePaid);
    }
    if (event.serviceSettlement.claimPaid !== null) {
      claimPaid += BigInt(event.serviceSettlement.claimPaid);
    }
    const priorCompleteness = snapshot?.projectionCompleteness ?? "complete";
    snapshot = Object.freeze({
      networkId: event.networkId,
      jobId: event.jobId,
      ownerLockHash: event.ownerLockHash,
      payoutLockHash: event.payoutLockHash,
      payloadHash: event.payloadHash,
      lifecycleState: event.lifecycleState,
      cycleIndex: event.cycleIndex,
      totalCycles: event.totalCycles,
      principalCapacity: event.principalCapacity,
      compensationCapacity: event.compensationCapacity ?? snapshot?.compensationCapacity ?? null,
      accumulatedCompensation:
        event.accumulatedCompensation ?? snapshot?.accumulatedCompensation ?? null,
      jobOutPoint:
        event.jobOutPoint === undefined ? (snapshot?.jobOutPoint ?? null) : event.jobOutPoint,
      vaultOutPoint:
        event.vaultOutPoint === undefined ? (snapshot?.vaultOutPoint ?? null) : event.vaultOutPoint,
      compensationOutPoint:
        event.compensationOutPoint === undefined
          ? (snapshot?.compensationOutPoint ?? null)
          : event.compensationOutPoint,
      prepareCredit: event.prepareCredit,
      operatorWindow:
        event.operatorWindow ??
        snapshot?.operatorWindow ??
        (() => {
          throw new Error("initial V2 event is missing its operator window");
        })(),
      serviceSettlement: Object.freeze({
        status:
          priorCompleteness === "partial" || event.projectionCompleteness === "partial"
            ? "partial"
            : "complete",
        preparePaid: preparePaid.toString(),
        claimPaid: claimPaid.toString(),
        lastOperation: event.operation,
      }),
      canonicalTxStatus: "committed",
      projectionCompleteness:
        priorCompleteness === "partial" || event.projectionCompleteness === "partial"
          ? "partial"
          : "complete",
      source: Object.freeze({
        blockNumber: event.blockNumber,
        blockHash: event.blockHash,
        transactionHash: event.transactionHash,
      }),
    });
  }
  return snapshot;
}
