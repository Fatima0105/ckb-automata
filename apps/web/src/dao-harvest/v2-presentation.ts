import type { ApiDaoHarvestV2 } from "@ckb-automata/api-client";

import { formatHarvestPrincipal } from "./presentation.ts";

export type DaoHarvestV2Status = "completed" | "processing" | "recovery" | "waiting";

export interface DaoHarvestV2Presentation {
  readonly action: string;
  readonly completedCycles: number;
  readonly status: DaoHarvestV2Status;
  readonly statusLabel: string;
  readonly totalCycles: number;
}

function count(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

export function daoHarvestV2Presentation(job: ApiDaoHarvestV2): DaoHarvestV2Presentation {
  const completedCycles = count(job.progress.cycle, "completed harvest count");
  const totalCycles = count(job.progress.totalCycles, "total harvest count");
  if (completedCycles > totalCycles) throw new Error("harvest progress exceeds its total");
  if (job.state === "completed" || job.state === "closed") {
    return {
      action:
        job.state === "closed" ? "Automation closed by the owner" : "All harvests are complete",
      completedCycles,
      status: "completed",
      statusLabel: "Completed",
      totalCycles,
    };
  }
  if (job.state === "recovered") {
    return {
      action: "Funds recovered by the owner",
      completedCycles,
      status: "recovery",
      statusLabel: "Recovered",
      totalCycles,
    };
  }
  if (job.state === "withdrawing") {
    return {
      action: "Waiting for the DAO withdrawal to become ready",
      completedCycles,
      status: "processing",
      statusLabel: "Processing",
      totalCycles,
    };
  }
  return {
    action: "Preferred operator is waiting for the safe harvest window",
    completedCycles,
    status: "waiting",
    statusLabel: "Waiting",
    totalCycles,
  };
}

export function harvestV2Amount(value: string | null): string {
  return value === null ? "Not available yet" : formatHarvestPrincipal(value);
}

export function harvestV2Operation(value: string): string {
  const labels: Readonly<Record<string, string>> = {
    setup: "Automation created",
    preferred_prepare: "Preferred operator started the harvest",
    fallback_prepare: "Backup operator started the harvest",
    preferred_claim: "Preferred operator completed the harvest",
    fallback_claim: "Backup operator completed the harvest",
    owner_complete: "Owner completed the harvest",
    sweep: "Earned compensation withdrawn",
    close: "Automation closed",
    rotate: "Operators updated",
    recover: "Owner recovery completed",
  };
  return labels[value] ?? "Automation updated";
}

export function harvestV2OwnerActions(
  job: ApiDaoHarvestV2,
): readonly ("sweep" | "close" | "rotate" | "recover")[] {
  const actions: ("sweep" | "close" | "rotate" | "recover")[] = [];
  if (
    job.compensation.availableToWithdraw !== null &&
    BigInt(job.compensation.availableToWithdraw) > 0n
  ) {
    actions.push("sweep");
  }
  if (job.state === "completed") actions.push("close");
  if (job.state === "deposited" || job.state === "withdrawing") actions.push("rotate", "recover");
  return Object.freeze(actions);
}
