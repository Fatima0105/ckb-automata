import { and, asc, eq, inArray } from "drizzle-orm";

import type { AutomataDatabase } from "../database/client.ts";
import { daoHarvestV2Events, daoHarvestV2Jobs } from "../database/schema.ts";
import {
  rebuildDaoHarvestV2Snapshot,
  type DaoHarvestV2ProjectionEvent,
  type DaoHarvestV2Snapshot,
} from "./dao-harvest-v2-projection.ts";

function eventFromRow(row: typeof daoHarvestV2Events.$inferSelect): DaoHarvestV2ProjectionEvent {
  if (
    typeof row.projection !== "object" ||
    row.projection === null ||
    Array.isArray(row.projection)
  ) {
    throw new Error("stored V2 projection event is invalid");
  }
  const event = row.projection as unknown as DaoHarvestV2ProjectionEvent;
  if (
    event.eventId !== row.eventId ||
    event.networkId !== row.networkId ||
    event.jobId !== row.jobId ||
    event.operation !== row.operation ||
    event.transactionHash !== row.transactionHash ||
    event.transactionIndex !== row.transactionIndex ||
    event.blockNumber !== row.blockNumber ||
    event.blockHash !== row.blockHash
  ) {
    throw new Error("stored V2 projection provenance contradicts its event row");
  }
  return Object.freeze({ ...event, canonical: row.canonical });
}

function snapshotValues(snapshot: DaoHarvestV2Snapshot) {
  return {
    networkId: snapshot.networkId,
    jobId: snapshot.jobId,
    ownerLockHash: snapshot.ownerLockHash,
    payoutLockHash: snapshot.payoutLockHash,
    payloadHash: snapshot.payloadHash,
    jobOutpoint: snapshot.jobOutPoint,
    vaultOutpoint: snapshot.vaultOutPoint,
    compensationOutpoint: snapshot.compensationOutPoint,
    lifecycleState: snapshot.lifecycleState,
    cycleIndex: snapshot.cycleIndex,
    totalCycles: snapshot.totalCycles,
    principalCapacity: snapshot.principalCapacity,
    compensationCapacity: snapshot.compensationCapacity,
    accumulatedCompensation: snapshot.accumulatedCompensation,
    prepareCredit: snapshot.prepareCredit,
    operatorWindow: snapshot.operatorWindow,
    serviceSettlement: snapshot.serviceSettlement,
    canonicalTxStatus: snapshot.canonicalTxStatus,
    projectionCompleteness: snapshot.projectionCompleteness,
    observedBlockNumber: snapshot.source.blockNumber,
    observedBlockHash: snapshot.source.blockHash,
    observedTransactionHash: snapshot.source.transactionHash,
    canonical: true,
    updatedAt: new Date(),
  } as const;
}

function storedOutPointKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item["txHash"] !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(item["txHash"]) ||
    typeof item["index"] !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(item["index"])
  ) {
    throw new Error("stored V2 state contains an invalid outpoint");
  }
  return `${item["txHash"]}:${BigInt(item["index"]).toString()}`;
}

export class DaoHarvestV2ProjectionStore {
  readonly #database: AutomataDatabase;

  constructor(database: AutomataDatabase) {
    this.#database = database;
  }

  async trackedOutPoints(networkId: string): Promise<ReadonlySet<string>> {
    const rows = await this.#database
      .select({
        job: daoHarvestV2Jobs.jobOutpoint,
        vault: daoHarvestV2Jobs.vaultOutpoint,
        compensation: daoHarvestV2Jobs.compensationOutpoint,
      })
      .from(daoHarvestV2Jobs)
      .where(and(eq(daoHarvestV2Jobs.networkId, networkId), eq(daoHarvestV2Jobs.canonical, true)));
    return new Set(
      rows.flatMap((row) =>
        [row.job, row.vault, row.compensation]
          .map(storedOutPointKey)
          .filter((key): key is string => key !== undefined),
      ),
    );
  }

  async append(
    events: readonly DaoHarvestV2ProjectionEvent[],
  ): Promise<readonly DaoHarvestV2Snapshot[]> {
    if (events.length === 0) return Object.freeze([]);
    const network = events[0]!.networkId;
    if (events.some((event) => event.networkId !== network || !event.canonical)) {
      throw new Error("V2 projection append requires one network of canonical events");
    }
    return this.#database.transaction(async (transaction) => {
      const existingRows = await transaction
        .select()
        .from(daoHarvestV2Events)
        .where(
          and(
            eq(daoHarvestV2Events.networkId, network),
            inArray(
              daoHarvestV2Events.eventId,
              events.map(({ eventId }) => eventId),
            ),
          ),
        );
      const existingById = new Map(existingRows.map((row) => [row.eventId, eventFromRow(row)]));
      for (const event of events) {
        const existing = existingById.get(event.eventId);
        if (existing) {
          const enrichesPartial =
            existing.projectionCompleteness === "partial" &&
            event.projectionCompleteness === "complete";
          const comparableExisting = {
            ...existing,
            canonical: event.canonical,
            ...(enrichesPartial
              ? {
                  serviceSettlement: event.serviceSettlement,
                  projectionCompleteness: event.projectionCompleteness,
                }
              : {}),
          };
          if (JSON.stringify(comparableExisting) !== JSON.stringify(event)) {
            throw new Error("duplicate V2 event contradicts stored chain evidence");
          }
        }
        await transaction
          .insert(daoHarvestV2Events)
          .values({
            networkId: event.networkId,
            eventId: event.eventId,
            jobId: event.jobId,
            operation: event.operation,
            transactionHash: event.transactionHash,
            transactionIndex: event.transactionIndex,
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            canonical: true,
            projection: event,
          })
          .onConflictDoUpdate({
            target: [daoHarvestV2Events.networkId, daoHarvestV2Events.eventId],
            set: {
              projection: event,
              canonical: true,
              orphanedAt: null,
            },
          });
      }
      const jobIds = [...new Set(events.map(({ jobId }) => jobId))];
      return this.#rebuild(transaction as AutomataDatabase, network, jobIds);
    });
  }

  async rollback(
    networkId: string,
    orphanedBlockHashes: readonly string[],
  ): Promise<readonly DaoHarvestV2Snapshot[]> {
    if (orphanedBlockHashes.length === 0) return Object.freeze([]);
    return this.#database.transaction(async (transaction) => {
      const affected = await transaction
        .select({ jobId: daoHarvestV2Events.jobId })
        .from(daoHarvestV2Events)
        .where(
          and(
            eq(daoHarvestV2Events.networkId, networkId),
            inArray(daoHarvestV2Events.blockHash, [...orphanedBlockHashes]),
            eq(daoHarvestV2Events.canonical, true),
          ),
        );
      await transaction
        .update(daoHarvestV2Events)
        .set({ canonical: false, orphanedAt: new Date() })
        .where(
          and(
            eq(daoHarvestV2Events.networkId, networkId),
            inArray(daoHarvestV2Events.blockHash, [...orphanedBlockHashes]),
          ),
        );
      return this.#rebuild(transaction as AutomataDatabase, networkId, [
        ...new Set(affected.map(({ jobId }) => jobId)),
      ]);
    });
  }

  async reset(networkId: string): Promise<readonly DaoHarvestV2Snapshot[]> {
    return this.#database.transaction(async (transaction) => {
      await transaction.delete(daoHarvestV2Jobs).where(eq(daoHarvestV2Jobs.networkId, networkId));
      const rows = await transaction
        .select({ jobId: daoHarvestV2Events.jobId })
        .from(daoHarvestV2Events)
        .where(
          and(eq(daoHarvestV2Events.networkId, networkId), eq(daoHarvestV2Events.canonical, true)),
        );
      return this.#rebuild(transaction as AutomataDatabase, networkId, [
        ...new Set(rows.map(({ jobId }) => jobId)),
      ]);
    });
  }

  async #rebuild(
    database: AutomataDatabase,
    networkId: string,
    jobIds: readonly string[],
  ): Promise<readonly DaoHarvestV2Snapshot[]> {
    const snapshots: DaoHarvestV2Snapshot[] = [];
    for (const jobId of jobIds) {
      const rows = await database
        .select()
        .from(daoHarvestV2Events)
        .where(
          and(
            eq(daoHarvestV2Events.networkId, networkId),
            eq(daoHarvestV2Events.jobId, jobId),
            eq(daoHarvestV2Events.canonical, true),
          ),
        )
        .orderBy(
          asc(daoHarvestV2Events.blockNumber),
          asc(daoHarvestV2Events.transactionIndex),
          asc(daoHarvestV2Events.eventId),
        );
      const snapshot = rebuildDaoHarvestV2Snapshot(rows.map(eventFromRow));
      if (!snapshot) {
        await database
          .delete(daoHarvestV2Jobs)
          .where(and(eq(daoHarvestV2Jobs.networkId, networkId), eq(daoHarvestV2Jobs.jobId, jobId)));
        continue;
      }
      const values = snapshotValues(snapshot);
      await database
        .insert(daoHarvestV2Jobs)
        .values(values)
        .onConflictDoUpdate({
          target: [daoHarvestV2Jobs.networkId, daoHarvestV2Jobs.jobId],
          set: values,
        });
      snapshots.push(snapshot);
    }
    return Object.freeze(snapshots);
  }
}
