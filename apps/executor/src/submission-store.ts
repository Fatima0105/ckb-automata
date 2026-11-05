import postgres from "postgres";

import { parseHash32, type Hash32 } from "@ckb-automata/core";

import type { SubmissionAcceptance, SubmissionAttempt, SubmissionStore } from "./submission.ts";

interface SubmissionRow {
  readonly id: string;
  readonly intent_hash: string;
  readonly state: "awaiting_signature" | "submitted";
  readonly tx_hash: string | null;
  readonly unsigned_transaction: postgres.JSONValue;
  readonly simulation: postgres.JSONValue;
}

function jsonRecord(value: postgres.JSONValue): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("submission transaction is not a JSON object");
  }
  return Object.freeze(value as Record<string, unknown>);
}

function feeInputIndex(value: postgres.JSONValue): number {
  const simulation = jsonRecord(value);
  const index = simulation["feeInputIndex"];
  if (!Number.isSafeInteger(index) || (index as number) < 0) {
    throw new Error("approved simulation is missing its verified fee input index");
  }
  return index as number;
}

export class PostgresSubmissionStore implements SubmissionStore {
  readonly #sql: postgres.Sql;
  readonly #now: () => Date;
  #closed = false;

  constructor(connectionString: string, now: () => Date = () => new Date()) {
    const url = new URL(connectionString);
    if (url.protocol !== "postgresql:") {
      throw new TypeError("submission database must use postgresql://");
    }
    this.#now = now;
    this.#sql = postgres(connectionString, {
      connect_timeout: 5,
      idle_timeout: 20,
      max: 1,
      onnotice: () => undefined,
    });
  }

  async load(attemptId: string, intentHash: Hash32): Promise<SubmissionAttempt | undefined> {
    const rows = await this.#sql<SubmissionRow[]>`
      SELECT id, intent_hash, state, tx_hash, unsigned_transaction, simulation
      FROM transaction_attempts
      WHERE id = ${attemptId}
        AND intent_hash = ${intentHash}
        AND operation = 'execute'
        AND state IN ('awaiting_signature', 'submitted')
        AND unsigned_transaction IS NOT NULL
      LIMIT 1
    `;
    const row = rows[0];
    if (!row) return undefined;
    if (row.state === "submitted") {
      if (row.tx_hash === null)
        throw new Error("submitted attempt is missing its transaction hash");
      return Object.freeze({
        attemptId: row.id,
        intentHash: parseHash32(row.intent_hash),
        state: "submitted",
        transactionHash: parseHash32(row.tx_hash),
      });
    }
    return Object.freeze({
      attemptId: row.id,
      intentHash: parseHash32(row.intent_hash),
      state: "awaiting_signature",
      transaction: jsonRecord(row.unsigned_transaction),
      feeInputIndex: feeInputIndex(row.simulation),
    });
  }

  async markSubmitted(
    attempt: SubmissionAttempt,
    transactionHash: Hash32,
    acceptance: SubmissionAcceptance,
  ): Promise<boolean> {
    const now = this.#now();
    return this.#sql.begin(async (sql) => {
      const rows = await sql<{ readonly network_id: string; readonly job_id: string }[]>`
        UPDATE transaction_attempts
        SET state = 'submitted',
            tx_hash = ${transactionHash},
            submitted_at = ${now},
            error_code = NULL,
            error_detail = NULL,
            updated_at = ${now}
        WHERE id = ${attempt.attemptId}
          AND intent_hash = ${attempt.intentHash}
          AND operation = 'execute'
          AND state = 'awaiting_signature'
          AND job_id IS NOT NULL
        RETURNING network_id, job_id
      `;
      const updated = rows[0];
      if (!updated) return false;
      await sql`
        INSERT INTO job_events (
          network_id, job_id, event_type, source, tx_hash, payload, occurred_at
        ) VALUES (
          ${updated.network_id}, ${updated.job_id}, 'transaction_submitted', 'operational',
          ${transactionHash},
          ${sql.json({ attemptId: attempt.attemptId, intentHash: attempt.intentHash, acceptance })},
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
