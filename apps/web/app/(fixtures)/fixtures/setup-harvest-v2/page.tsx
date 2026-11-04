import { Suspense } from "react";

import { DaoHarvestV2Setup } from "../../../../src/setup/dao-harvest-v2-setup.tsx";

export default function DaoHarvestV2SetupFixturePage() {
  return (
    <Suspense fallback={null}>
      <DaoHarvestV2Setup />
    </Suspense>
  );
}
