import { and, eq, sql } from "drizzle-orm";

import type { ClientBlock } from "@ckb-ccc/shell";

import {
  inspectJobData,
  parseBlockNumber,
  parseHash32,
  parseOutputIndex,
  parseShannons,
  type BlockNumber,
  type Hash32,
  type OutputIndex,
  type OperatorAutomationDeployment,
  type RegisteredDeployment,
  type Sequence,
  type Shannons,
} from "@ckb-automata/core";

import type { AutomataDatabase } from "../database/client.ts";
import { jobEvents, jobs, jobVersions } from "../database/schema.ts";
import type { CkbReadClient } from "../ckb-client.ts";

export type SupportedJobPolicyKind = "deadline" | "recurring" | "dao_harvest";

export interface DiscoveredJobCell {
  readonly networkId: string;
  readonly jobId: Hash32;
  readonly sequence: Sequence;
  readonly ownerLockHash: Hash32;
  readonly policyScriptHash: Hash32;
  readonly policyKind: SupportedJobPolicyKind;
  readonly capacity: Shannons;
  readonly data: `0x${string}`;
  readonly outPoint: {
    readonly txHash: Hash32;
    readonly index: OutputIndex;
  };
  readonly provenance: {
    readonly blockNumber: BlockNumber;
    readonly blockHash: Hash32;
    readonly transactionIndex: OutputIndex;
    readonly timestamp: bigint;
  };
}

export interface JobCellExtraction {
  readonly cells: readonly DiscoveredJobCell[];
  readonly jobLockOutputs: number;
  readonly malformedOrInvalid: number;
  readonly unsupportedVersions: number;
  readonly unsupportedPolicies: number;
}

export interface JobDiscoveryResult extends JobCellExtraction {
  readonly insertedJobs: number;
  readonly existingJobs: number;
}

function exactJobLock(
  output: ClientBlock["transactions"][number]["outputs"][number],
  deployment: RegisteredDeployment,
  operatorDeployment?: OperatorAutomationDeployment,
): boolean {
  const expected = [
    deployment.contracts["job-lock"].script,
    ...(operatorDeployment === undefined ? [] : [operatorDeployment.contracts.jobLock.script]),
  ];
  return expected.some(
    (script) =>
      output.lock.codeHash === script.codeHash &&
      output.lock.hashType === script.hashType &&
      output.lock.args === "0x",
  );
}

function eventDate(timestamp: bigint): Date {
  if (timestamp < 0n || timestamp > 8_640_000_000_000_000n) {
    throw new RangeError("block timestamp is outside the JavaScript date range");
  }
  return new Date(Number(timestamp));
}

function dataBuffer(value: `0x${string}`): Buffer {
  const body = value.slice(2);
  if (body.length % 2 !== 0 || !/^[0-9a-f]*$/.test(body)) {
    throw new TypeError("job data must be canonical lowercase hexadecimal bytes");
  }
  return Buffer.from(body, "hex");
}

export function extractSupportedJobCells(
  block: ClientBlock,
  deployment: RegisteredDeployment,
  operatorDeployment?: OperatorAutomationDeployment,
): JobCellExtraction {
  const cells: DiscoveredJobCell[] = [];
  let jobLockOutputs = 0;
  let malformedOrInvalid = 0;
  let unsupportedVersions = 0;
  let unsupportedPolicies = 0;
  const blockNumber = parseBlockNumber(block.header.number.toString());
  const blockHash = parseHash32(block.header.hash);
  const timestamp = BigInt(block.header.timestamp);

  for (const [transactionIndexValue, transaction] of block.transactions.entries()) {
    const txHash = parseHash32(transaction.hash());
    const transactionIndex = parseOutputIndex(BigInt(transactionIndexValue));
    for (const [outputIndexValue, output] of transaction.outputs.entries()) {
      if (!exactJobLock(output, deployment, operatorDeployment)) continue;
      jobLockOutputs += 1;
      const data = transaction.outputsData[outputIndexValue] ?? "0x";
      const inspection = inspectJobData(data, {
        manifest: deployment.manifest,
        expectedGenesisHash: deployment.genesisHash,
        ...(output.type ? { policyScript: output.type } : {}),
        ...(operatorDeployment === undefined ? {} : { operatorDeployment }),
      });
      if (inspection.status === "unsupported_version") {
        unsupportedVersions += 1;
        continue;
      }
      if (inspection.status !== "ok") {
        malformedOrInvalid += 1;
        continue;
      }
      if (
        inspection.policy.kind !== "deadline" &&
        inspection.policy.kind !== "recurring" &&
        inspection.policy.kind !== "dao_harvest"
      ) {
        unsupportedPolicies += 1;
        continue;
      }
      const outputIndex = parseOutputIndex(BigInt(outputIndexValue));
      cells.push(
        Object.freeze({
          networkId: deployment.network,
          jobId: inspection.job.jobId,
          sequence: inspection.job.sequence,
          ownerLockHash: inspection.job.cancelLockHash,
          policyScriptHash: inspection.job.policyScriptHash,
          policyKind: inspection.policy.kind,
          capacity: parseShannons(output.capacity.toString()),
          data,
          outPoint: Object.freeze({ txHash, index: outputIndex }),
          provenance: Object.freeze({
            blockNumber,
            blockHash,
            transactionIndex,
            timestamp,
          }),
        }),
      );
    }
  }

  return Object.freeze({
    cells: Object.freeze(cells),
    jobLockOutputs,
    malformedOrInvalid,
    unsupportedVersions,
    unsupportedPolicies,
  });
}

export class JobCellDiscovery {
  readonly #database: AutomataDatabase;
  readonly #ckbClient: Pick<CkbReadClient, "getBlockByNumber">;
  readonly #operatorDeployment: OperatorAutomationDeployment | undefined;

  constructor(
    database: AutomataDatabase,
    ckbClient: Pick<CkbReadClient, "getBlockByNumber">,
    operatorDeployment?: OperatorAutomationDeployment,
  ) {
    this.#database = database;
    this.#ckbClient = ckbClient;
    this.#operatorDeployment = operatorDeployment;
  }

  async scanBlock(
    blockNumberValue: bigint,
    deployment: RegisteredDeployment,
  ): Promise<JobDiscoveryResult> {
    const blockNumber = parseBlockNumber(blockNumberValue);
    const block = await this.#ckbClient.getBlockByNumber(blockNumber);
    if (!block) throw new Error("canonical block is unavailable");
    if (BigInt(block.header.number) !== blockNumber) {
      throw new Error("CKB client returned a block at the wrong height");
    }
    return this.projectBlock(block, deployment);
  }

  async projectBlock(
    block: ClientBlock,
    deployment: RegisteredDeployment,
  ): Promise<JobDiscoveryResult> {
    const extraction = extractSupportedJobCells(block, deployment, this.#operatorDeployment);
    let insertedJobs = 0;
    let existingJobs = 0;

    if (extraction.cells.length === 0) {
      return Object.freeze({ ...extraction, insertedJobs, existingJobs });
    }

    await this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${deployment.network}, 0))`,
      );
      const persistEvidence = async (cell: DiscoveredJobCell): Promise<void> => {
        const rawData = dataBuffer(cell.data);
        const [existingVersion] = await transaction
          .select({ id: jobVersions.id, status: jobVersions.status })
          .from(jobVersions)
          .where(
            and(
              eq(jobVersions.networkId, cell.networkId),
              eq(jobVersions.outpointTxHash, cell.outPoint.txHash),
              eq(jobVersions.outpointIndex, cell.outPoint.index.toString()),
            ),
          )
          .limit(1);
        if (existingVersion) {
          if (existingVersion.status !== "orphaned") {
            throw new Error("canonical Job Cell version already exists for a revived job");
          }
          await transaction
            .update(jobVersions)
            .set({
              status: "live",
              sequence: cell.sequence.toString(),
              capacity: cell.capacity.toString(),
              data: rawData,
              observedBlockNumber: cell.provenance.blockNumber.toString(),
              observedBlockHash: cell.provenance.blockHash,
              transactionIndex: cell.provenance.transactionIndex.toString(),
              spentTxHash: null,
            })
            .where(eq(jobVersions.id, existingVersion.id));
        } else {
          await transaction.insert(jobVersions).values({
            networkId: cell.networkId,
            jobId: cell.jobId,
            sequence: cell.sequence.toString(),
            outpointTxHash: cell.outPoint.txHash,
            outpointIndex: cell.outPoint.index.toString(),
            status: "live",
            capacity: cell.capacity.toString(),
            data: rawData,
            observedBlockNumber: cell.provenance.blockNumber.toString(),
            observedBlockHash: cell.provenance.blockHash,
            transactionIndex: cell.provenance.transactionIndex.toString(),
          });
        }
        await transaction.insert(jobEvents).values({
          networkId: cell.networkId,
          jobId: cell.jobId,
          eventType: "job_discovered",
          source: "indexed",
          blockNumber: cell.provenance.blockNumber.toString(),
          blockHash: cell.provenance.blockHash,
          txHash: cell.outPoint.txHash,
          payload: {
            outputIndex: cell.outPoint.index.toString(),
            policyKind: cell.policyKind,
            sequence: cell.sequence.toString(),
            transactionIndex: cell.provenance.transactionIndex.toString(),
          },
          occurredAt: eventDate(cell.provenance.timestamp),
        });
      };

      for (const cell of extraction.cells) {
        const [inserted] = await transaction
          .insert(jobs)
          .values({
            networkId: cell.networkId,
            jobId: cell.jobId,
            outpointTxHash: cell.outPoint.txHash,
            outpointIndex: cell.outPoint.index.toString(),
            sequence: cell.sequence.toString(),
            ownerLockHash: cell.ownerLockHash,
            policyScriptHash: cell.policyScriptHash,
            policyKind: cell.policyKind,
            state: "live",
            capacity: cell.capacity.toString(),
            data: dataBuffer(cell.data),
            blockNumber: cell.provenance.blockNumber.toString(),
            blockHash: cell.provenance.blockHash,
            transactionIndex: cell.provenance.transactionIndex.toString(),
          })
          .onConflictDoNothing()
          .returning({ jobId: jobs.jobId });

        if (!inserted) {
          const [knownJob] = await transaction
            .select({ jobId: jobs.jobId, state: jobs.state })
            .from(jobs)
            .where(and(eq(jobs.networkId, cell.networkId), eq(jobs.jobId, cell.jobId)))
            .limit(1);
          if (!knownJob) {
            throw new Error("job source outpoint is already assigned to another job");
          }
          if (knownJob.state === "orphaned") {
            await transaction
              .update(jobs)
              .set({
                outpointTxHash: cell.outPoint.txHash,
                outpointIndex: cell.outPoint.index.toString(),
                sequence: cell.sequence.toString(),
                ownerLockHash: cell.ownerLockHash,
                policyScriptHash: cell.policyScriptHash,
                policyKind: cell.policyKind,
                state: "live",
                capacity: cell.capacity.toString(),
                data: dataBuffer(cell.data),
                blockNumber: cell.provenance.blockNumber.toString(),
                blockHash: cell.provenance.blockHash,
                transactionIndex: cell.provenance.transactionIndex.toString(),
                updatedAt: new Date(),
              })
              .where(and(eq(jobs.networkId, cell.networkId), eq(jobs.jobId, cell.jobId)));
            await persistEvidence(cell);
            insertedJobs += 1;
            continue;
          }
          existingJobs += 1;
          continue;
        }

        insertedJobs += 1;
        await persistEvidence(cell);
      }
    });

    return Object.freeze({ ...extraction, insertedJobs, existingJobs });
  }
}
