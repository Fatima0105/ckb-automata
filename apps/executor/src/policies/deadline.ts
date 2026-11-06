import { CampaignDataV1, type CampaignDataV1Value } from "@ckb-automata/molecule";
import {
  bytesToHex,
  hexToBytes,
  scriptToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import {
  CAMPAIGN_STATES,
  CONTRACT_CAPACITY,
  deriveDeadlinePayloadHash,
  deriveOperatorPayloadHash,
  deriveRefundCommitment,
  determineCampaignOutcome,
  hash32FromBytes,
  hash32ToBytes,
  minimumPlainCellCapacity,
  operatorTakeoverBlock,
  parseHash32,
  parseOutPoint,
  parseShannons,
  toRpcHex,
  type Hash32,
  type OutPoint,
  type ScriptIdentity,
  type SinceValue,
  type Shannons,
  type UnsignedDeadlineTransaction,
  unpackOperatorPayload,
} from "@ckb-automata/core";

import {
  defineExecutorAdapter,
  type ExecutorAdapterRegistration,
  type ExecutorBuild,
  type ExecutorCellSnapshot,
  type ExecutorContext,
  type ExecutorEligibilityContext,
  type EligibilityDecision,
} from "../adapter.ts";

type Hex = `0x${string}`;

const PLEDGE_RECORD_BYTES = 76;
const EXECUTION_MODE = 0;

function evaluateDeadlineEligibility(
  context: ExecutorEligibilityContext,
): EligibilityDecision<DeadlineEvidence> {
  const deadline = context.jobInspection.job.notBefore;
  const observedTip = context.snapshot.tip.number;
  const evidence = Object.freeze({ deadline, observedTip });
  return observedTip >= deadline
    ? Object.freeze({ status: "eligible", evidence })
    : Object.freeze({
        status: "ineligible",
        reason: "EXECUTOR_NOT_YET_ELIGIBLE",
        terminal: false,
        evidence,
      });
}

export const DEADLINE_EXECUTOR_REGISTRATION = Object.freeze({
  id: "deadline-v1",
  policy: "deadline",
  supports: (policy) => policy.kind === "deadline",
  evaluateEligibility: evaluateDeadlineEligibility,
} satisfies ExecutorAdapterRegistration);

export type DeadlineAdapterErrorCode =
  | "INVALID_CAMPAIGN"
  | "INVALID_COMMITMENT"
  | "MISSING_RESOLUTION"
  | "INVALID_FEE_CELL"
  | "UNSUPPORTED_CLAIM";

export class DeadlineAdapterError extends Error {
  override readonly name = "DeadlineAdapterError";
  readonly code: DeadlineAdapterErrorCode;

  constructor(code: DeadlineAdapterErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface DeadlineRefundRecord {
  readonly outPoint: OutPoint;
  readonly refundLockHash: Hash32;
  readonly amount: Shannons;
  readonly refundLock: ScriptIdentity;
}

export interface DeadlineInspection {
  readonly campaignCell: ExecutorCellSnapshot;
  readonly campaign: CampaignDataV1Value;
  readonly campaignTypeHash: Hash32;
  readonly outcome: "SUCCEEDED" | "REFUNDING";
  readonly successLock: ScriptIdentity;
  readonly ownerLock: ScriptIdentity;
  readonly refundRecords: readonly DeadlineRefundRecord[];
  readonly refundRecordsHex: Hex;
  readonly feeCell: ExecutorCellSnapshot;
  readonly executorLockHash: Hash32;
  readonly operatorPayloadHex?: Hex;
  readonly operatorSelection?: ReturnType<typeof unpackOperatorPayload>["selection"];
}

export interface DeadlineEvidence {
  readonly deadline: bigint;
  readonly observedTip: bigint;
  readonly executionSince?: SinceValue;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function readUint32(bytes: Uint8Array, offset: number): bigint {
  return BigInt(
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true),
  );
}

function readUint64(bytes: Uint8Array, offset: number): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

function scriptHash(script: ScriptIdentity): Hash32 {
  return parseHash32(scriptToHash(script));
}

function findLock(context: ExecutorContext, hash: Hash32, name: string): ScriptIdentity {
  const matches = context.snapshot.resolvedLocks.filter((lock) => scriptHash(lock) === hash);
  const unique = new Map(matches.map((lock) => [stable(lock), lock]));
  if (unique.size !== 1) {
    throw new DeadlineAdapterError(
      "MISSING_RESOLUTION",
      `${name} requires exactly one resolved lock script matching ${hash}`,
    );
  }
  return unique.values().next().value!;
}

function decodeCampaign(cell: ExecutorCellSnapshot): CampaignDataV1Value {
  try {
    return CampaignDataV1.unpack(hexToBytes(cell.data));
  } catch {
    throw new DeadlineAdapterError("INVALID_CAMPAIGN", "campaign input data is malformed");
  }
}

function findCampaignCell(
  context: ExecutorContext,
  campaignTypeHash: Hash32,
): ExecutorCellSnapshot {
  const matches = context.snapshot.applicationCells.filter(
    (cell) => cell.output.type && scriptHash(cell.output.type) === campaignTypeHash,
  );
  if (matches.length !== 1) {
    throw new DeadlineAdapterError(
      "INVALID_CAMPAIGN",
      "the snapshot must contain exactly one campaign cell committed by the deadline policy",
    );
  }
  return matches[0]!;
}

function decodeRefundRecords(
  context: ExecutorContext,
  campaign: CampaignDataV1Value,
): { readonly records: readonly DeadlineRefundRecord[]; readonly payload: Hex } {
  const pledgeCount = Number(campaign.pledge_count);
  const pledged = parseShannons(campaign.pledged.toString());
  const expectedCommitment = hash32FromBytes(Uint8Array.from(campaign.refund_commitment));
  const valid = [...new Set(context.snapshot.payloads)].filter((payload) => {
    try {
      const bytes = hexToBytes(payload);
      return (
        bytes.length === pledgeCount * PLEDGE_RECORD_BYTES &&
        hash32FromBytes(deriveRefundCommitment(pledgeCount, bytes)) === expectedCommitment
      );
    } catch {
      return false;
    }
  });
  if (valid.length !== 1) {
    throw new DeadlineAdapterError(
      "INVALID_COMMITMENT",
      "the snapshot must resolve exactly one pledge-record payload matching the campaign input",
    );
  }
  const payload = valid[0]!;
  const bytes = hexToBytes(payload);
  const records: DeadlineRefundRecord[] = [];
  let total = 0n;
  let previous: OutPoint | undefined;
  for (let offset = 0; offset < bytes.length; offset += PLEDGE_RECORD_BYTES) {
    const outPoint = parseOutPoint({
      txHash: bytesToHex(bytes.slice(offset, offset + 32)),
      index: readUint32(bytes, offset + 32).toString(),
    });
    if (
      previous &&
      (outPoint.txHash < previous.txHash ||
        (outPoint.txHash === previous.txHash && outPoint.index <= previous.index))
    ) {
      throw new DeadlineAdapterError(
        "INVALID_COMMITMENT",
        "pledge records are not in canonical outpoint order",
      );
    }
    const refundLockHash = hash32FromBytes(bytes.slice(offset + 36, offset + 68));
    if (/^0x0{64}$/.test(refundLockHash)) {
      throw new DeadlineAdapterError("INVALID_COMMITMENT", "pledge refund lock hash is zero");
    }
    const amount = parseShannons(readUint64(bytes, offset + 68).toString());
    if (amount < CONTRACT_CAPACITY.plainWalletCell) {
      throw new DeadlineAdapterError(
        "INVALID_COMMITMENT",
        "pledge refund amount cannot fund a plain output",
      );
    }
    total = parseShannons(total + amount);
    records.push(
      Object.freeze({
        outPoint,
        refundLockHash,
        amount,
        refundLock: findLock(context, refundLockHash, "pledge refund"),
      }),
    );
    previous = outPoint;
  }
  if (total !== pledged) {
    throw new DeadlineAdapterError(
      "INVALID_COMMITMENT",
      "pledge-record amounts do not equal the campaign pledged value",
    );
  }
  return Object.freeze({ records: Object.freeze(records), payload });
}

function compareOutPoints(left: OutPoint, right: OutPoint): number {
  const hashOrder = left.txHash.localeCompare(right.txHash);
  return hashOrder === 0 ? Number(left.index - right.index) : hashOrder;
}

function selectFeeCell(context: ExecutorContext): ExecutorCellSnapshot {
  const fee = parseShannons(context.identity.transactionFee);
  const candidates = context.snapshot.feeCells
    .filter(
      (cell) =>
        stable(cell.output.lock) === stable(context.identity.rewardLock) &&
        cell.output.type === null &&
        cell.data === "0x" &&
        stable(cell.outPoint) !== stable(context.snapshot.job.outPoint) &&
        !context.snapshot.applicationCells.some(
          (application) => stable(application.outPoint) === stable(cell.outPoint),
        ) &&
        parseShannons(cell.output.capacity) >= fee + CONTRACT_CAPACITY.plainWalletCell,
    )
    .toSorted((left, right) => compareOutPoints(left.outPoint, right.outPoint));
  if (candidates.length === 0) {
    throw new DeadlineAdapterError(
      "INVALID_FEE_CELL",
      "no plain executor cell can fund the configured fee and a valid change output",
    );
  }
  return candidates[0]!;
}

function executionWitness(executorLockHash: Hash32, operatorPayload?: Hex): Hex {
  const request = new Uint8Array(46);
  const view = new DataView(request.buffer);
  request[0] = EXECUTION_MODE;
  view.setUint32(1, 0, true);
  request.set(hash32ToBytes(executorLockHash), 5);
  request[37] = 2;
  view.setUint32(38, 0, true);
  view.setUint32(42, 1, true);
  return serializeWitnessArgs({
    lock: "",
    inputType: bytesToHex(request),
    outputType: operatorPayload ?? "",
  }) as Hex;
}

function plainOutput(capacity: Shannons, lock: ScriptIdentity) {
  return Object.freeze({ capacity: toRpcHex(capacity), lock, type: null });
}

function inspectDeadline(context: ExecutorContext): DeadlineInspection {
  if (context.jobInspection.policy.kind !== "deadline") {
    throw new DeadlineAdapterError("INVALID_CAMPAIGN", "deadline adapter received another policy");
  }
  const campaignTypeHash = context.jobInspection.policy.campaignTypeHash;
  const operatorBound = context.jobInspection.policy.contract === "deadline-policy-v2";
  const operatorDeployment = context.snapshot.operatorDeployment;
  if (operatorBound && operatorDeployment === undefined) {
    throw new DeadlineAdapterError("INVALID_CAMPAIGN", "operator deployment is unavailable");
  }
  const expectedJobLock = {
    ...(operatorBound
      ? operatorDeployment!.contracts.jobLock.script
      : context.snapshot.deployment.contracts["job-lock"].script),
    args: "0x" as const,
  };
  if (stable(context.snapshot.job.output.lock) !== stable(expectedJobLock)) {
    throw new DeadlineAdapterError(
      "INVALID_CAMPAIGN",
      "job input is not locked by the registered Job Lock",
    );
  }
  const campaignCell = findCampaignCell(context, campaignTypeHash);
  const campaign = decodeCampaign(campaignCell);
  const pledgeCount = Number(campaign.pledge_count);
  if (
    campaign.version !== 1 ||
    campaign.state !== CAMPAIGN_STATES.OPEN ||
    !Number.isSafeInteger(pledgeCount) ||
    pledgeCount <= 0 ||
    campaign.target.toString() === "0" ||
    BigInt(campaign.deadline_since.toString()) !== context.jobInspection.job.notBefore
  ) {
    throw new DeadlineAdapterError(
      "INVALID_CAMPAIGN",
      "campaign input is not an open version-one state matching the job deadline",
    );
  }
  const campaignId = hash32FromBytes(Uint8Array.from(campaign.campaign_id));
  const expectedCampaignType = {
    ...context.snapshot.deployment.contracts["demo-campaign-type"].script,
    args: campaignId,
  };
  const expectedCampaignLock = {
    ...context.snapshot.deployment.contracts["campaign-lock"].script,
    args: "0x" as const,
  };
  if (
    stable(campaignCell.output.type) !== stable(expectedCampaignType) ||
    stable(campaignCell.output.lock) !== stable(expectedCampaignLock)
  ) {
    throw new DeadlineAdapterError(
      "INVALID_CAMPAIGN",
      "campaign input does not use its identity-bound registered type and lock scripts",
    );
  }
  const operatorCandidates = operatorBound
    ? [...new Set(context.snapshot.payloads)].flatMap((hex) => {
        try {
          const bytes = hexToBytes(hex);
          const unpacked = unpackOperatorPayload(bytes);
          const application = unpacked.applicationPayload;
          return hash32FromBytes(
            deriveOperatorPayloadHash(
              hash32ToBytes(context.jobInspection.job.policyScriptHash),
              bytes,
            ),
          ) === context.jobInspection.job.payloadHash &&
            application.length === 33 &&
            application[0] === 1 &&
            hash32FromBytes(application.slice(1)) === campaignTypeHash
            ? [{ hex, unpacked }]
            : [];
        } catch {
          return [];
        }
      })
    : [];
  if (operatorBound && operatorCandidates.length !== 1) {
    throw new DeadlineAdapterError(
      "INVALID_COMMITMENT",
      "the snapshot must resolve one operator policy matching the deadline job",
    );
  }
  const operatorPayload = operatorCandidates[0];
  const expectedPayload = operatorBound
    ? context.jobInspection.job.payloadHash
    : hash32FromBytes(
        deriveDeadlinePayloadHash(context.jobInspection.job.policyScriptHash, campaignTypeHash),
      );
  if (expectedPayload !== context.jobInspection.job.payloadHash) {
    throw new DeadlineAdapterError(
      "INVALID_COMMITMENT",
      "deadline job payload does not commit to the consumed campaign input",
    );
  }
  const outcome = determineCampaignOutcome(
    parseShannons(campaign.pledged.toString()),
    parseShannons(campaign.target.toString()),
  );
  const claim = context.snapshot.claims["deadlineOutcome"];
  if (claim !== undefined && claim !== outcome) {
    throw new DeadlineAdapterError(
      "UNSUPPORTED_CLAIM",
      `claimed deadline outcome ${String(claim)} is contradicted by the campaign input`,
    );
  }
  const successLockHash = hash32FromBytes(Uint8Array.from(campaign.success_lock_hash));
  const ownerLockHash = context.jobInspection.job.cancelLockHash;
  const executorLockHash = scriptHash(context.identity.rewardLock);
  if (successLockHash === ownerLockHash || successLockHash === executorLockHash) {
    throw new DeadlineAdapterError(
      "INVALID_CAMPAIGN",
      "success recipient must differ from owner and executor output locks",
    );
  }
  const refunds = decodeRefundRecords(context, campaign);
  return Object.freeze({
    campaignCell,
    campaign,
    campaignTypeHash,
    outcome,
    successLock: findLock(context, successLockHash, "campaign success recipient"),
    ownerLock: findLock(context, ownerLockHash, "job owner refund"),
    refundRecords: refunds.records,
    refundRecordsHex: refunds.payload,
    feeCell: selectFeeCell(context),
    executorLockHash,
    ...(operatorPayload === undefined
      ? {}
      : {
          operatorPayloadHex: operatorPayload.hex,
          operatorSelection: operatorPayload.unpacked.selection,
        }),
  });
}

function terminalData(inspection: DeadlineInspection): Hex {
  return bytesToHex(
    CampaignDataV1.pack({
      ...inspection.campaign,
      state:
        inspection.outcome === "SUCCEEDED" ? CAMPAIGN_STATES.SUCCEEDED : CAMPAIGN_STATES.REFUNDING,
    }),
  ) as Hex;
}

function buildDeadline(
  context: ExecutorContext,
  inspection: DeadlineInspection,
  executionSince = context.jobInspection.job.notBefore,
): ExecutorBuild {
  const reward = parseShannons(context.jobInspection.job.reward);
  const jobCapacity = parseShannons(context.snapshot.job.output.capacity);
  const ownerRefund = parseShannons(jobCapacity - reward);
  const pledged = parseShannons(inspection.campaign.pledged.toString());
  const campaignCapacity = parseShannons(inspection.campaignCell.output.capacity);
  const terminalCapacity = parseShannons(campaignCapacity - pledged);
  if (terminalCapacity !== CONTRACT_CAPACITY.campaignCellV1) {
    throw new DeadlineAdapterError(
      "INVALID_CAMPAIGN",
      "campaign input capacity does not equal its occupied capacity plus pledged value",
    );
  }
  const feeCapacity = parseShannons(inspection.feeCell.output.capacity);
  const feeChange = parseShannons(feeCapacity - context.identity.transactionFee);
  const outputs: UnsignedDeadlineTransaction["outputs"][number][] = [
    plainOutput(reward, context.identity.rewardLock),
    plainOutput(ownerRefund, inspection.ownerLock),
  ];
  const outputsData: Hex[] = ["0x", "0x"];
  if (inspection.outcome === "SUCCEEDED") {
    if (pledged < minimumPlainCellCapacity(inspection.successLock)) {
      throw new DeadlineAdapterError(
        "INVALID_CAMPAIGN",
        "campaign pledge cannot fund the resolved recipient output",
      );
    }
    outputs.push(plainOutput(pledged, inspection.successLock));
    outputsData.push("0x");
  } else {
    for (const record of inspection.refundRecords) {
      if (record.amount < minimumPlainCellCapacity(record.refundLock)) {
        throw new DeadlineAdapterError(
          "INVALID_CAMPAIGN",
          "campaign pledge cannot fund a resolved refund output",
        );
      }
      outputs.push(plainOutput(record.amount, record.refundLock));
      outputsData.push("0x");
    }
  }
  outputs.push(
    Object.freeze({
      capacity: toRpcHex(terminalCapacity),
      lock: inspection.campaignCell.output.lock,
      type: inspection.campaignCell.output.type,
    }),
    plainOutput(feeChange, context.identity.rewardLock),
  );
  outputsData.push(terminalData(inspection), "0x");
  const transaction: UnsignedDeadlineTransaction = Object.freeze({
    version: "0x0",
    cellDeps: Object.freeze([
      inspection.operatorSelection === undefined
        ? context.snapshot.deployment.manifest.secp256k1Blake160.cellDep
        : context.snapshot.operatorDeployment!.secp256k1Blake160.cellDep,
      inspection.operatorSelection === undefined
        ? context.snapshot.deployment.contracts["job-lock"].cellDep
        : context.snapshot.operatorDeployment!.contracts.jobLock.cellDep,
      inspection.operatorSelection === undefined
        ? context.snapshot.deployment.contracts["deadline-policy"].cellDep
        : context.snapshot.operatorDeployment!.contracts.deadlinePolicy.cellDep,
      context.snapshot.deployment.contracts["demo-campaign-type"].cellDep,
      context.snapshot.deployment.contracts["campaign-lock"].cellDep,
    ]),
    headerDeps: Object.freeze([]),
    inputs: Object.freeze([
      Object.freeze({
        since: toRpcHex(executionSince),
        previousOutput: Object.freeze({
          txHash: context.snapshot.job.outPoint.txHash,
          index: toRpcHex(context.snapshot.job.outPoint.index),
        }),
      }),
      Object.freeze({
        since: "0x0" as const,
        previousOutput: Object.freeze({
          txHash: inspection.feeCell.outPoint.txHash,
          index: toRpcHex(inspection.feeCell.outPoint.index),
        }),
      }),
      Object.freeze({
        since: "0x0" as const,
        previousOutput: Object.freeze({
          txHash: inspection.campaignCell.outPoint.txHash,
          index: toRpcHex(inspection.campaignCell.outPoint.index),
        }),
      }),
    ]),
    outputs: Object.freeze(outputs),
    outputsData: Object.freeze(outputsData),
    witnesses: Object.freeze([
      executionWitness(inspection.executorLockHash, inspection.operatorPayloadHex),
      "0x" as Hex,
      serializeWitnessArgs({
        lock: "",
        inputType: inspection.refundRecordsHex,
        outputType: "",
      }) as Hex,
    ]),
  });
  return Object.freeze({
    transaction,
    summary: Object.freeze({
      policy: "deadline",
      outcome: inspection.outcome,
      campaignTypeHash: inspection.campaignTypeHash,
      reward: reward.toString(),
      executorLockHash: inspection.executorLockHash,
      controlledOutputIndices: Object.freeze([0, 1]),
    }),
  });
}

export const DEADLINE_EXECUTOR_ADAPTER = defineExecutorAdapter<
  DeadlineInspection,
  DeadlineEvidence
>({
  registration: DEADLINE_EXECUTOR_REGISTRATION,
  inspect: inspectDeadline,
  eligibility: (context, inspection) => {
    const base = evaluateDeadlineEligibility(context);
    if (base.status === "ineligible" || inspection.operatorSelection === undefined) return base;
    const executor = scriptHash(context.identity.rewardLock);
    const preferred = inspection.operatorSelection.preferredExecutorLockHash;
    const executionSince =
      executor === preferred
        ? context.jobInspection.job.notBefore
        : context.jobInspection.job.notAfter;
    if (
      context.jobInspection.job.notAfter !==
      operatorTakeoverBlock(
        context.jobInspection.job.notBefore,
        inspection.operatorSelection.takeoverDelayBlocks,
      )
    ) {
      throw new DeadlineAdapterError("INVALID_COMMITMENT", "deadline takeover block is invalid");
    }
    return context.snapshot.tip.number >= executionSince
      ? Object.freeze({
          status: "eligible" as const,
          evidence: { ...base.evidence, executionSince },
        })
      : Object.freeze({
          status: "ineligible" as const,
          reason: "EXECUTOR_NOT_YET_ELIGIBLE" as const,
          terminal: false,
          evidence: { ...base.evidence, executionSince },
        });
  },
  build: (context, inspection, eligibility) =>
    buildDeadline(context, inspection, eligibility.evidence.executionSince),
  verifyBuilt: (context, inspection, eligibility, build) => {
    const expected = buildDeadline(context, inspection, eligibility.evidence.executionSince);
    return stable(build) === stable(expected)
      ? Object.freeze({ status: "valid" })
      : Object.freeze({
          status: "invalid",
          reason: "EXECUTOR_SIMULATION_REJECTED",
          message: "deadline transaction differs from the transaction reconstructed from inputs",
        });
  },
});
