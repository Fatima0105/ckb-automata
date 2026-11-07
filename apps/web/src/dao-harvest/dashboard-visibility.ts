import type { DashboardMode } from "../dashboard/dashboard-view.tsx";

interface OwnedDaoAutomation {
  readonly ownerLockHash: string;
}

export function visibleDaoAutomations<Item extends OwnedDaoAutomation>(
  items: readonly Item[],
  mode: DashboardMode,
  ownerLockHash: string | undefined,
): readonly Item[] {
  if (mode === "public") return items;
  if (ownerLockHash === undefined) return [];
  return items.filter((item) => item.ownerLockHash === ownerLockHash);
}

export function publicOnlyDaoAutomations<Item>(
  items: readonly Item[],
  mode: DashboardMode,
): readonly Item[] {
  return mode === "public" ? items : [];
}
