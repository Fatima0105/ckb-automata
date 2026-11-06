import {
  CONTRACT_CAPACITY,
  MAX_UINT32,
  calculateRecurringQuote,
  minimumPlainCellCapacity,
  parseBlockNumber,
  parseHash32,
  parseRecurringCreationRequest,
  parseRunCount,
  type ScriptIdentity,
} from "@ckb-automata/core";

import { ckbToShannons, shannonsToCkb } from "./ckb-amount.ts";
import { validateAutomationTitle } from "./automation-title.ts";
import { scheduleToBlock } from "./deadline-form.ts";
import type { SetupDraft, SetupErrors, SetupStepId } from "./setup-flow.ts";
import { DEFAULT_OPERATOR_DRAFT } from "./operator-directory.ts";

const MAX_ABSOLUTE_BLOCK = (1n << 56n) - 1n;
const PREVIEW_FEE = Object.freeze({
  transactionBytes: Object.freeze({ minimum: "1", maximum: "1" }),
  feeRatePerKilobyte: Object.freeze({ minimum: "0", maximum: "0" }),
});

export const RECURRING_INITIAL_DRAFT: SetupDraft = Object.freeze({
  ...DEFAULT_OPERATOR_DRAFT,
  amountCkb: "",
  firstExecutionAt: "",
  intervalMinutes: "",
  recipientAddress: "",
  runCount: "",
  title: "",
});

export const RECURRING_SERVICE_CHARGE_CKB = "61";

export interface RecurringValidationContext {
  readonly balanceShannons: bigint | undefined;
  readonly ownerLockHash: string | undefined;
  readonly resolveLock: (address: string) => Promise<ScriptIdentity>;
  readonly resolveLockHash: (address: string) => Promise<string>;
  readonly walletReady: boolean;
}

export interface RecurringFundingPreview {
  readonly amountPerRun: bigint;
  readonly payoutTotal: bigint;
  readonly rewardPerRun: bigint;
  readonly rewardTotal: bigint;
  readonly occupiedCapacity: bigint;
  readonly totalLocked: bigint;
  readonly totalLockedCkb: string;
}

export function clientAcceptsRecurringRequest(input: unknown): boolean {
  try {
    parseRecurringCreationRequest(input);
    return true;
  } catch {
    return false;
  }
}

function canonicalDecimal(value: string, name: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value.trim())) {
    throw new TypeError(`${name} must be a whole number without separators.`);
  }
  return BigInt(value);
}

export function intervalMinutesToBlocks(value: string): string {
  const minutes = canonicalDecimal(value, "Repeat interval");
  if (minutes === 0n) throw new RangeError("Repeat interval must be at least 1 minute.");
  return (minutes * 6n).toString();
}

function ckbAmount(value: string, label: string): bigint {
  const parsed = BigInt(ckbToShannons(value));
  if (parsed < CONTRACT_CAPACITY.plainWalletCell) {
    throw new RangeError(`${label} must be at least 61 CKB.`);
  }
  return parsed;
}

export function recurringFundingPreview(draft: SetupDraft): RecurringFundingPreview {
  const amountPerRun = ckbAmount(draft["amountCkb"] ?? "", "Payment amount");
  const rewardPerRun = ckbAmount(RECURRING_SERVICE_CHARGE_CKB, "Service charge");
  const runs = parseRunCount(canonicalDecimal(draft["runCount"] ?? "", "Run count"));
  const quote = calculateRecurringQuote({
    amountPerExecution: amountPerRun,
    rewardPerExecution: rewardPerRun,
    executions: runs,
    creationFee: PREVIEW_FEE,
  });
  return Object.freeze({
    amountPerRun,
    payoutTotal: quote.applicationAmount.total,
    rewardPerRun,
    rewardTotal: quote.rewards.total,
    occupiedCapacity: quote.occupiedCapacity.jobCell,
    totalLocked: quote.maximumLockedTotal,
    totalLockedCkb: shannonsToCkb(quote.maximumLockedTotal),
  });
}

function required(
  draft: SetupDraft,
  name: string,
  message: string,
  errors: Record<string, string>,
) {
  const value = draft[name]?.trim();
  if (!value) errors[name] = message;
  return value ?? "";
}

async function recipient(
  draft: SetupDraft,
  context: RecurringValidationContext,
  errors: Record<string, string>,
): Promise<{ readonly lockHash: string; readonly minimumCapacity: bigint } | undefined> {
  const value = required(draft, "recipientAddress", "Enter the payment recipient.", errors);
  if (!value) return undefined;
  try {
    const [lockHash, lock] = await Promise.all([
      context.resolveLockHash(value),
      context.resolveLock(value),
    ]);
    return Object.freeze({
      lockHash: parseHash32(lockHash),
      minimumCapacity: minimumPlainCellCapacity(lock),
    });
  } catch {
    errors["recipientAddress"] = "Enter a valid CKB testnet recipient address.";
    return undefined;
  }
}

function validateAmount(
  draft: SetupDraft,
  name: string,
  label: string,
  errors: Record<string, string>,
) {
  const value = required(draft, name, `Enter the ${label}.`, errors);
  if (!value) return undefined;
  try {
    return ckbAmount(value, label);
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : `Enter a valid ${label}.`;
    return undefined;
  }
}

function timingValues(draft: SetupDraft, errors: Record<string, string>) {
  let interval: bigint | undefined;
  let runs: bigint | undefined;
  const firstExecutionAt = required(
    draft,
    "firstExecutionAt",
    "Choose the first payment date and time.",
    errors,
  );
  if (firstExecutionAt) {
    try {
      scheduleToBlock(firstExecutionAt, "1");
    } catch {
      errors["firstExecutionAt"] = "Choose a date and time in the future.";
    }
  }
  try {
    interval = parseBlockNumber(
      BigInt(
        intervalMinutesToBlocks(
          required(draft, "intervalMinutes", "Enter the repeat interval.", errors),
        ),
      ),
    );
  } catch {
    errors["intervalMinutes"] = "Enter at least 1 minute between payments.";
  }
  try {
    runs = parseRunCount(
      canonicalDecimal(required(draft, "runCount", "Enter the run count.", errors), "Run count"),
    );
    if (runs === 0n || runs > MAX_UINT32) throw new RangeError();
  } catch {
    errors["runCount"] = "Enter between 1 and 4,294,967,295 runs.";
  }
  if (interval !== undefined && runs !== undefined) {
    const last = 1n + (runs - 1n) * interval;
    if (last > MAX_ABSOLUTE_BLOCK) {
      errors["runCount"] = "The final payment exceeds the supported schedule range.";
      runs = undefined;
    }
  }
  return { interval, runs };
}

export async function validateRecurringStep(
  step: SetupStepId,
  draft: SetupDraft,
  context: RecurringValidationContext,
): Promise<SetupErrors> {
  const errors: Record<string, string> = {};
  if (step === "details") {
    const titleError = validateAutomationTitle(draft);
    if (titleError !== undefined) errors["title"] = titleError;
    const resolvedRecipient = await recipient(draft, context, errors);
    const amount = validateAmount(draft, "amountCkb", "payment amount", errors);
    if (
      resolvedRecipient !== undefined &&
      amount !== undefined &&
      amount < resolvedRecipient.minimumCapacity
    ) {
      errors["amountCkb"] =
        `Payment amount must be at least ${shannonsToCkb(resolvedRecipient.minimumCapacity)} CKB for this recipient address.`;
    }
    if (draft["operatorMode"] === "custom") {
      const operatorAddress = required(
        draft,
        "preferredOperatorAddress",
        "Enter the preferred operator address.",
        errors,
      );
      if (operatorAddress) {
        try {
          await context.resolveLockHash(operatorAddress);
        } catch {
          errors["preferredOperatorAddress"] = "Enter a valid CKB testnet operator address.";
        }
      }
    }
  }
  if (step === "timing") {
    const amount = validateAmount(draft, "amountCkb", "payment amount", errors);
    const reward = ckbAmount(RECURRING_SERVICE_CHARGE_CKB, "Service charge");
    const { interval, runs } = timingValues(draft, errors);
    const resolvedRecipient = await recipient(draft, context, errors);
    if (
      resolvedRecipient !== undefined &&
      amount !== undefined &&
      amount < resolvedRecipient.minimumCapacity
    ) {
      errors["amountCkb"] =
        `Payment amount must be at least ${shannonsToCkb(resolvedRecipient.minimumCapacity)} CKB for this recipient address.`;
    }
    if (!context.walletReady || context.ownerLockHash === undefined) {
      errors["ownerAddress"] = "Connect a supported CKB testnet wallet to pay and manage refunds.";
    }
    let preview: RecurringFundingPreview | undefined;
    if (amount !== undefined && runs !== undefined) {
      try {
        preview = recurringFundingPreview(draft);
      } catch {
        errors["runCount"] = "The complete payment schedule exceeds CKB funding limits.";
      }
    }
    if (context.walletReady && context.balanceShannons === undefined) {
      errors["ownerAddress"] = "Wait for the connected wallet balance to finish loading.";
    } else if (
      preview !== undefined &&
      context.balanceShannons !== undefined &&
      context.balanceShannons < preview.totalLocked
    ) {
      errors["ownerAddress"] =
        `Wallet needs at least ${preview.totalLockedCkb} CKB to cover all payments and charges.`;
    }
    if (
      amount !== undefined &&
      reward !== undefined &&
      interval !== undefined &&
      runs !== undefined &&
      resolvedRecipient !== undefined &&
      context.ownerLockHash !== undefined
    ) {
      try {
        parseRecurringCreationRequest({
          ownerLockHash: context.ownerLockHash,
          recipientLockHash: resolvedRecipient.lockHash,
          amount: amount.toString(),
          intervalBlocks: interval.toString(),
          firstNotBefore: "1",
          totalRuns: runs.toString(),
          reward: reward.toString(),
          creatorNonce: "0",
        });
      } catch {
        errors["runCount"] = "These values cannot create a valid recurring payment schedule.";
      }
    }
  }
  return Object.freeze(errors);
}
