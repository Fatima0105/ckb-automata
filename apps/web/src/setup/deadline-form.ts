import {
  CONTRACT_CAPACITY,
  minimumPlainCellCapacity,
  parseDeadlineCreationRequest,
  parseHash32,
  type ScriptIdentity,
} from "@ckb-automata/core";

import { ckbToShannons, shannonsToCkb } from "./ckb-amount.ts";
import { validateAutomationTitle } from "./automation-title.ts";
import type { SetupDraft, SetupErrors, SetupStepId } from "./setup-flow.ts";
import { DEFAULT_OPERATOR_DRAFT } from "./operator-directory.ts";

export const DEADLINE_INITIAL_DRAFT: SetupDraft = Object.freeze({
  ...DEFAULT_OPERATOR_DRAFT,
  outcome: "success",
  pledgeCkb: "",
  refundAddress: "",
  rewardCkb: "61",
  scheduleAt: "",
  successAddress: "",
  title: "",
});

export const DEADLINE_SERVICE_CHARGE_CKB = "61";

export function deadlineTarget(pledgeCkb: string, outcome: string): string {
  const pledged = BigInt(ckbToShannons(pledgeCkb));
  if (outcome === "success") return pledged.toString();
  if (outcome === "refund") return (pledged + 1n).toString();
  throw new TypeError("Choose whether the recipient is paid or the amount is refunded.");
}

export function scheduleToBlock(scheduleAt: string, tipBlock: string, now = Date.now()): string {
  const scheduled = new Date(scheduleAt).getTime();
  if (!Number.isFinite(scheduled) || scheduled <= now) {
    throw new RangeError("Choose a future date and time.");
  }
  const remainingSeconds = BigInt(Math.ceil((scheduled - now) / 1_000));
  const blocks = (remainingSeconds + 9n) / 10n;
  return (BigInt(tipBlock) + (blocks > 0n ? blocks : 1n)).toString();
}

export interface DeadlineValidationContext {
  readonly ownerLockHash: string | undefined;
  readonly resolveLock: (address: string) => Promise<ScriptIdentity>;
  readonly resolveLockHash: (address: string) => Promise<string>;
  readonly walletReady: boolean;
}

export function clientAcceptsDeadlineRequest(input: unknown): boolean {
  try {
    parseDeadlineCreationRequest(input);
    return true;
  } catch {
    return false;
  }
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

function amount(
  draft: SetupDraft,
  name: string,
  label: string,
  minimum: bigint,
  errors: Record<string, string>,
): string | undefined {
  const value = required(draft, name, `Enter ${label}.`, errors);
  if (!value) return undefined;
  try {
    const parsed = BigInt(ckbToShannons(value));
    if (parsed < minimum) {
      errors[name] = `${label} must be at least ${shannonsToCkb(minimum)} CKB.`;
      return undefined;
    }
    return parsed.toString();
  } catch (error) {
    errors[name] = error instanceof Error ? error.message : `Enter a valid ${label}.`;
    return undefined;
  }
}

async function address(
  draft: SetupDraft,
  name: string,
  label: string,
  context: DeadlineValidationContext,
  errors: Record<string, string>,
): Promise<{ readonly lockHash: string; readonly minimumCapacity: bigint } | undefined> {
  const value = required(draft, name, `Enter the ${label}.`, errors);
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
    errors[name] = `Enter a valid CKB testnet address for the ${label}.`;
    return undefined;
  }
}

export async function validateDeadlineStep(
  step: SetupStepId,
  draft: SetupDraft,
  context: DeadlineValidationContext,
): Promise<SetupErrors> {
  const errors: Record<string, string> = {};
  if (step === "details") {
    const titleError = validateAutomationTitle(draft);
    if (titleError !== undefined) errors["title"] = titleError;
    const pledge = amount(
      draft,
      "pledgeCkb",
      "recipient amount",
      CONTRACT_CAPACITY.plainWalletCell,
      errors,
    );
    if (draft["outcome"] !== "success" && draft["outcome"] !== "refund") {
      errors["outcome"] = "Choose whether to pay the recipient or refund the amount.";
    }
    const [success, refund] = await Promise.all([
      address(draft, "successAddress", "recipient address", context, errors),
      address(draft, "refundAddress", "refund address", context, errors),
    ]);
    if (success !== undefined && success.lockHash === context.ownerLockHash) {
      errors["successAddress"] = "Recipient address must be different from your connected wallet.";
    }
    const requiredCapacity =
      success === undefined || refund === undefined
        ? undefined
        : success.minimumCapacity > refund.minimumCapacity
          ? success.minimumCapacity
          : refund.minimumCapacity;
    if (
      pledge !== undefined &&
      requiredCapacity !== undefined &&
      BigInt(pledge) < requiredCapacity
    ) {
      errors["pledgeCkb"] =
        `Recipient amount must be at least ${shannonsToCkb(requiredCapacity)} CKB for the selected recipient and refund addresses.`;
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
    const value = required(draft, "scheduleAt", "Choose the schedule date and time.", errors);
    if (value) {
      try {
        scheduleToBlock(value, "1");
      } catch {
        errors["scheduleAt"] = "Choose a date and time in the future.";
      }
    }
    if (!context.walletReady || context.ownerLockHash === undefined) {
      errors["ownerAddress"] = "Connect a supported CKB testnet wallet for recovery authority.";
    }
  }
  return Object.freeze(errors);
}
