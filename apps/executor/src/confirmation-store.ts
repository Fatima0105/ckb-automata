import postgres from "postgres";

import { parseBlockNumber, parseHash32, parseOutputIndex, type Hash32 } from "@ckb-automata/core";

import type {
  ConfirmationAttempt,
  ConfirmationEvidence,
  ConfirmationInclusion,
  ConfirmationQueuePayload,
  ConfirmationStore,
  ConfirmationTransition,
  RpcTransactionObservation,
} from "./confirmation.ts";
import { verifyExecutorReceipt, type ExecutorReceipt } from "./receipt.ts";

export const MAX_CONFIRMATION_ATTEMPTS = 500;

interface AttemptRow {
  readonly id: string;
  readonly job_id: string;
  readonly sequence: string;
  readonly tx_hash: string;
  readonly state: ConfirmationAttempt["state"];
  readonly submitted_at: Date;
  readonly committed_block_number: string | null;
}

interface EvidenceRow {
  readonly block_number: string;
  readonly block_hash: string;
  readonly tx_hash: string;
  readonly executor_lock_hash?: string | null;
  readonly successor_tx_hash?: string | null;
  readonly successor_index?: string | null;
}

interface ReorgRow extends EvidenceRow {
  readonly original_tx_hash: string;
  readonly original_index: string;
  readonly original_input_live: boolean;
}

function inclusion(
  row: EvidenceRow,
  source: ConfirmationInclusion["source"],
): ConfirmationInclusion {
  return Object.freeze({
    blockNumber: parseBlockNumber(row.block_number).toString(),
    blockHash: parseHash32(row.block_hash),
    source,
  });
}

function contentionEvidence(row: EvidenceRow) {
  const successorFields = [row.successor_tx_hash, row.successor_index];
  if (successorFields.filter((value) => value != null).length === 1) {
    throw new Error("canonical contention evidence has an incomplete successor outpoint");
  }
  return Object.freeze({
    ...inclusion(row, "indexed_event"),
    transactionHash: parseHash32(row.tx_hash),
    ...(row.executor_lock_hash == null
      ? {}
      : { executorLockHash: parseHash32(row.executor_lock_hash) }),
    ...(row.successor_tx_hash == null || row.successor_index == null
      ? {}
      : {
          successorOutPoint: Object.freeze({
            txHash: parseHash32(row.successor_tx_hash),
            index: parseOutputIndex(row.successor_index).toString(),
          }),
        }),
  });
}

export class PostgresConfirmationStore implements ConfirmationStore {
  readonly #network: string;
  readonly #sql: postgres.Sql;
  readonly #now: () => Date;
  #closed = false;

  constructor(connectionString: string, network: string, now: () => Date = () => new Date()) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgresql:") {
      throw new TypeError("confirmation database must use postgresql://");
    }
    this.#network = network;
    this.#now = now;
    this.#sql = postgres(connectionString, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: 1,
      onnotice: () => undefined,
    });
  }

  async listPending(
    options: { readonly afterAttemptId?: string; readonly limit?: number } = {},
  ): Promise<readonly ConfirmationQueuePayload[]> {
    const limit = options.limit ?? MAX_CONFIRMATION_ATTEMPTS;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CONFIRMATION_ATTEMPTS) {
      throw new RangeError(
        `confirmation scan limit must be between 1 and ${MAX_CONFIRMATION_ATTEMPTS}`,
      );
    }
    const after = options.afterAttemptId;
    const rows = await this.#sql<{ readonly id: string; readonly tx_hash: string }[]>`
      SELECT id, tx_hash
      FROM transaction_attempts
      WHERE network_id = ${this.#network}
        AND job_id IS NOT NULL
        AND state IN ('submitted', 'proposed', 'committed')
        AND tx_hash IS NOT NULL
        ${after === undefined ? this.#sql`` : this.#sql`AND id > ${after}`}
      ORDER BY id
      LIMIT ${limit}
    `;
    return Object.freeze(
      rows.map((row) =>
        Object.freeze({ attemptId: row.id, transactionHash: parseHash32(row.tx_hash) }),
      ),
    );
  }

  async load(attemptId: string, transactionHash: Hash32): Promise<ConfirmationAttempt | undefined> {
    const rows = await this.#sql<AttemptRow[]>`
      SELECT id, job_id, sequence::text, tx_hash, state, submitted_at,
             committed_block_number::text
      FROM transaction_attempts
      WHERE network_id = ${this.#network}
        AND id = ${attemptId}
        AND tx_hash = ${transactionHash}
        AND state IN ('submitted', 'proposed', 'committed', 'reorged')
        AND submitted_at IS NOT NULL
      LIMIT 1
    `;
    const row = rows[0];
    return row
      ? Object.freeze({
          attemptId: row.id,
          jobId: parseHash32(row.job_id),
          sequence: row.sequence,
          transactionHash: parseHash32(row.tx_hash),
          state: row.state,
          submittedAt: row.submitted_at,
          ...(row.committed_block_number === null
            ? {}
            : {
                committedBlockNumber: parseBlockNumber(row.committed_block_number).toString(),
              }),
        })
      : undefined;
  }

  async evidence(
    attempt: ConfirmationAttempt,
    rpc: RpcTransactionObservation | undefined,
  ): Promise<ConfirmationEvidence> {
    const [network] = await this.#sql<
      { readonly confirmation_depth: number; readonly checkpoint: string | null }[]
    >`
      SELECT network.confirmation_depth,
             checkpoint.block_number::text AS checkpoint
      FROM networks AS network
      LEFT JOIN indexer_checkpoints AS checkpoint ON checkpoint.network_id = network.id
      WHERE network.id = ${this.#network}
      LIMIT 1
    `;
    if (!network) throw new Error("confirmation network is unavailable");
    const exact = await this.#sql<EvidenceRow[]>`
      SELECT event.block_number::text, event.block_hash, event.tx_hash
      FROM job_events AS event
      JOIN transaction_attempts AS attempt
        ON attempt.network_id = event.network_id AND attempt.job_id = event.job_id
      JOIN indexer_checkpoints AS checkpoint ON checkpoint.network_id = event.network_id
      WHERE attempt.id = ${attempt.attemptId}
        AND event.source = 'indexed'
        AND event.canonical = true
        AND event.tx_hash = ${attempt.transactionHash}
        AND event.block_number <= checkpoint.block_number
      ORDER BY event.block_number DESC, event.id DESC
      LIMIT 1
    `;
    let exactInclusion = exact[0] ? inclusion(exact[0], "indexed_event") : undefined;
    if (
      exactInclusion === undefined &&
      rpc?.status === "committed" &&
      rpc.blockNumber !== undefined &&
      rpc.blockHash !== undefined
    ) {
      const canonical = await this.#sql<EvidenceRow[]>`
        SELECT block.block_number::text, block.block_hash, ${attempt.transactionHash}::text AS tx_hash
        FROM canonical_blocks AS block
        JOIN indexer_checkpoints AS checkpoint ON checkpoint.network_id = block.network_id
        WHERE block.network_id = ${this.#network}
          AND block.block_number = ${rpc.blockNumber}
          AND block.block_hash = ${rpc.blockHash}
          AND block.block_number <= checkpoint.block_number
        LIMIT 1
      `;
      if (canonical[0]) exactInclusion = inclusion(canonical[0], "rpc_canonical_block");
    }
    const conflicts = await this.#sql<EvidenceRow[]>`
      SELECT event.block_number::text, event.block_hash, event.tx_hash,
             event.payload->>'executorLockHash' AS executor_lock_hash,
             event.payload->'successorOutpoint'->>'txHash' AS successor_tx_hash,
             event.payload->'successorOutpoint'->>'index' AS successor_index
      FROM job_events AS event
      JOIN transaction_attempts AS attempt
        ON attempt.network_id = event.network_id AND attempt.job_id = event.job_id
      JOIN indexer_checkpoints AS checkpoint ON checkpoint.network_id = event.network_id
      WHERE attempt.id = ${attempt.attemptId}
        AND event.source = 'indexed'
        AND event.canonical = true
        AND event.tx_hash IS NOT NULL
        AND event.tx_hash <> ${attempt.transactionHash}
        AND event.block_number <= checkpoint.block_number
        AND event.payload->'previousOutpoint'->>'txHash' =
            attempt.chain_snapshot->'job'->'outPoint'->>'txHash'
        AND event.payload->'previousOutpoint'->>'index' =
            attempt.chain_snapshot->'job'->'outPoint'->>'index'
      ORDER BY event.block_number DESC, event.id DESC
      LIMIT 1
    `;
    const reorgs = await this.#sql<ReorgRow[]>`
      SELECT event.block_number::text, event.block_hash, event.tx_hash,
             attempt.chain_snapshot->'job'->'outPoint'->>'txHash' AS original_tx_hash,
             attempt.chain_snapshot->'job'->'outPoint'->>'index' AS original_index,
             EXISTS (
               SELECT 1
               FROM jobs AS restored
               WHERE restored.network_id = attempt.network_id
                 AND restored.job_id = attempt.job_id
                 AND restored.state = 'live'
                 AND restored.outpoint_tx_hash =
                     attempt.chain_snapshot->'job'->'outPoint'->>'txHash'
                 AND restored.outpoint_index::text =
                     attempt.chain_snapshot->'job'->'outPoint'->>'index'
             ) AS original_input_live
      FROM job_events AS event
      JOIN transaction_attempts AS attempt
        ON attempt.network_id = event.network_id AND attempt.job_id = event.job_id
      WHERE attempt.id = ${attempt.attemptId}
        AND event.source = 'indexed'
        AND event.canonical = false
        AND event.tx_hash = ${attempt.transactionHash}
        AND event.block_number IS NOT NULL
        AND event.block_hash IS NOT NULL
        AND attempt.chain_snapshot->'job'->'outPoint'->>'txHash' IS NOT NULL
        AND attempt.chain_snapshot->'job'->'outPoint'->>'index' IS NOT NULL
      ORDER BY event.block_number DESC, event.id DESC
      LIMIT 1
    `;
    const conflict = conflicts[0];
    const reorg = reorgs[0];
    return Object.freeze({
      requiredDepth: network.confirmation_depth,
      ...(network.checkpoint === null ? {} : { checkpointBlockNumber: network.checkpoint }),
      ...(exactInclusion === undefined ? {} : { inclusion: exactInclusion }),
      ...(conflict === undefined
        ? {}
        : {
            conflict: contentionEvidence(conflict),
          }),
      ...(reorg === undefined
        ? {}
        : {
            reorg: Object.freeze({
              orphanedBlock: inclusion(reorg, "orphaned_indexed_event"),
              originalOutPoint: Object.freeze({
                txHash: parseHash32(reorg.original_tx_hash),
                index: parseOutputIndex(reorg.original_index).toString(),
              }),
              originalInputLive: reorg.original_input_live,
            }),
          }),
    });
  }

  async apply(
    attempt: ConfirmationAttempt,
    transition: ConfirmationTransition,
    receipt?: ExecutorReceipt,
  ): Promise<boolean> {
    const requiresReceipt = ["confirmed", "conflicted", "dropped"].includes(transition.state);
    if (requiresReceipt !== (receipt !== undefined)) {
      throw new Error("terminal confirmation transitions require exactly one executor receipt");
    }
    if (
      receipt !== undefined &&
      (receipt.attemptId !== attempt.attemptId ||
        receipt.payload.transactionHash !== attempt.transactionHash ||
        receipt.payload.outcome.state !== transition.state)
    ) {
      throw new Error("executor receipt does not match its confirmation transition");
    }
    if (receipt !== undefined && !verifyExecutorReceipt(receipt)) {
      throw new Error("executor receipt signature or identity is invalid");
    }
    const now = this.#now();
    return this.#sql.begin(async (sql) => {
      const rows = await sql<{ readonly network_id: string; readonly job_id: string }[]>`
        UPDATE transaction_attempts
        SET state = ${transition.state},
            committed_block_number = ${transition.state === "committed" || transition.state === "confirmed" ? (transition.block?.blockNumber ?? null) : null},
            confirmed_at = ${transition.state === "confirmed" ? now : null},
            error_code = ${transition.errorCode ?? null},
            error_detail = ${
              transition.state === "conflicted"
                ? sql.json({
                    winningTransactionHash: transition.relatedTransactionHash,
                    ...(transition.winningExecutorLockHash === undefined
                      ? {}
                      : { winningExecutorLockHash: transition.winningExecutorLockHash }),
                    ...(transition.successorOutPoint === undefined
                      ? {}
                      : { successorOutPoint: transition.successorOutPoint }),
                  })
                : transition.state === "reorged"
                  ? sql.json({
                      orphanedBlock: transition.orphanedBlock,
                      originalOutPoint: transition.originalOutPoint,
                    } as unknown as postgres.JSONValue)
                  : null
            },
            updated_at = ${now}
        WHERE network_id = ${this.#network}
          AND id = ${attempt.attemptId}
          AND tx_hash = ${attempt.transactionHash}
          AND state = ${attempt.state}
          AND job_id IS NOT NULL
        RETURNING network_id, job_id
      `;
      const updated = rows[0];
      if (!updated) return false;
      if (receipt !== undefined) {
        await sql`
          INSERT INTO executor_receipts (
            id, attempt_id, executor_lock_hash, payload, signature, key_id, created_at
          ) VALUES (
            ${receipt.receiptId}, ${receipt.attemptId}, ${receipt.executorLockHash},
            ${sql.json(receipt.payload as unknown as postgres.JSONValue)},
            ${receipt.signature}, ${receipt.keyId}, ${receipt.createdAt}
          )
        `;
      }
      await sql`
        INSERT INTO job_events (
          network_id, job_id, event_type, source, block_number, block_hash,
          tx_hash, payload, occurred_at
        ) VALUES (
          ${updated.network_id}, ${updated.job_id}, ${transition.eventType},
          ${transition.block === undefined ? "operational" : "indexed"},
          ${transition.block?.blockNumber ?? null}, ${transition.block?.blockHash ?? null},
          ${transition.relatedTransactionHash ?? attempt.transactionHash},
          ${sql.json({
            attemptId: attempt.attemptId,
            observedStatus: transition.observedStatus,
            ...(transition.errorCode === undefined ? {} : { errorCode: transition.errorCode }),
            ...(transition.relatedTransactionHash === undefined
              ? {}
              : { relatedTransactionHash: transition.relatedTransactionHash }),
            ...(transition.winningExecutorLockHash === undefined
              ? {}
              : { winningExecutorLockHash: transition.winningExecutorLockHash }),
            ...(transition.successorOutPoint === undefined
              ? {}
              : { successorOutPoint: transition.successorOutPoint }),
            ...(transition.orphanedBlock === undefined
              ? {}
              : { orphanedBlock: transition.orphanedBlock }),
            ...(transition.originalOutPoint === undefined
              ? {}
              : { originalOutPoint: transition.originalOutPoint }),
            ...(transition.confirmations === undefined
              ? {}
              : {
                  confirmations: transition.confirmations,
                  requiredDepth: transition.requiredDepth,
                  evidenceSource: transition.block?.source,
                }),
          } as unknown as postgres.JSONValue)},
          ${now}
        )
      `;
      return true;
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#sql.end({ timeout: 5 });
  }
}
