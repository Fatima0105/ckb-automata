import { DaoHarvestV2Detail } from "../../../../../src/dao-harvest/dao-harvest-v2-detail.tsx";

export default async function DaoHarvestV2AutomationPage({
  params,
}: Readonly<{ params: Promise<{ jobId: string }> }>) {
  const { jobId } = await params;
  return <DaoHarvestV2Detail jobId={jobId} />;
}
