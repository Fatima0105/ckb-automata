import { rawTransactionToHash } from "@nervosnetwork/ckb-sdk-utils";
import { ErrorClientDuplicatedTransaction } from "@ckb-ccc/shell";

import { parseHash32, type Hash32, type UnsignedDeadlineTransaction } from "@ckb-automata/core";

import { signOperatorFeeInput } from "./signing.ts";
import { parseStoredTransaction, type SimulationQueuePayload } from "./simulation.ts";

export type SubmissionAcceptance = "broadcast" | "duplicate_known" | "hash_lookup";

export interface SubmissionAttempt {
  readonly attemptId: string;
  readonly intentHash: Hash32;
  readonly state: "awaiting_signature" | "submitted";
  readonly transaction?: Readonly<Record<string, unknown>>;
  readonly transactionHash?: Hash32;
  readonly feeInputIndex?: number;
}

export interface SubmissionStore {
  load(attemptId: string, intentHash: Hash32): Promise<SubmissionAttempt | undefined>;
  markSubmitted(
    attempt: SubmissionAttempt,
    transactionHash: Hash32,
    acceptance: SubmissionAcceptance,
  ): Promise<boolean>;
}

export interface SubmissionChain {
  send(transaction: UnsignedDeadlineTransaction): Promise<string>;
  getTransactionStatus(transactionHash: Hash32): Promise<
    | {
        readonly status: string;
        readonly transaction: { hash(): string };
      }
    | undefined
  >;
}

export type SubmissionResult =
  | {
      readonly status: "submitted";
      readonly attemptId: string;
      readonly transactionHash: Hash32;
      readonly acceptance: SubmissionAcceptance;
    }
  | {
      readonly status: "already_submitted";
      readonly attemptId: string;
      readonly transactionHash: Hash32;
    }
  | { readonly status: "stale" };

export class SubmissionError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SubmissionError";
    this.code = code;
  }
}

function duplicateTransactionHash(error: unknown, depth = 0): Hash32 | undefined {
  if (depth > 4 || !(error instanceof Error)) return undefined;
  if (error instanceof ErrorClientDuplicatedTransaction) {
    return parseHash32(error.txHash);
  }
  return duplicateTransactionHash(error.cause, depth + 1);
}

function acceptedStatus(status: string): boolean {
  return (
    status === "sent" || status === "pending" || status === "proposed" || status === "committed"
  );
}

export class SubmissionService {
  readonly #store: SubmissionStore;
  readonly #chain: SubmissionChain;
  readonly #privateKey: string;

  constructor(options: {
    readonly store: SubmissionStore;
    readonly chain: SubmissionChain;
    readonly privateKey: string;
  }) {
    this.#store = options.store;
    this.#chain = options.chain;
    this.#privateKey = options.privateKey;
  }

  async submit(payload: SimulationQueuePayload): Promise<SubmissionResult> {
    const intentHash = parseHash32(payload.intentHash);
    const attempt = await this.#store.load(payload.attemptId, intentHash);
    if (!attempt) return Object.freeze({ status: "stale" });
    if (attempt.state === "submitted") {
      if (attempt.transactionHash !== intentHash) {
        throw new SubmissionError(
          "EXECUTOR_SUBMISSION_RECORD_INVALID",
          "submitted transaction hash does not match its execution intent",
        );
      }
      return Object.freeze({
        status: "already_submitted",
        attemptId: attempt.attemptId,
        transactionHash: intentHash,
      });
    }
    if (!attempt.transaction) {
      throw new SubmissionError(
        "EXECUTOR_SUBMISSION_RECORD_INVALID",
        "approved execution is missing its transaction",
      );
    }

    const unsigned = parseStoredTransaction(attempt.transaction);
    const actualIntentHash = parseHash32(
      rawTransactionToHash(unsigned as unknown as Parameters<typeof rawTransactionToHash>[0]),
    );
    if (actualIntentHash !== intentHash) {
      throw new SubmissionError(
        "EXECUTOR_SUBMISSION_RECORD_INVALID",
        "approved transaction no longer matches its execution intent",
      );
    }
    if (
      attempt.feeInputIndex === undefined ||
      !Number.isSafeInteger(attempt.feeInputIndex) ||
      attempt.feeInputIndex < 0 ||
      attempt.feeInputIndex >= unsigned.inputs.length
    ) {
      throw new SubmissionError(
        "EXECUTOR_SUBMISSION_RECORD_INVALID",
        "approved execution is missing its verified fee input index",
      );
    }
    const signed = signOperatorFeeInput(unsigned, this.#privateKey, attempt.feeInputIndex);
    let acceptance: SubmissionAcceptance;
    try {
      const returnedHash = parseHash32(await this.#chain.send(signed));
      if (returnedHash !== intentHash) {
        throw new SubmissionError(
          "EXECUTOR_SUBMISSION_HASH_MISMATCH",
          "CKB node returned a different transaction hash",
        );
      }
      acceptance = "broadcast";
    } catch (error) {
      if (error instanceof SubmissionError) throw error;
      const duplicateHash = duplicateTransactionHash(error);
      if (duplicateHash !== undefined) {
        if (duplicateHash !== intentHash) {
          throw new SubmissionError(
            "EXECUTOR_SUBMISSION_HASH_MISMATCH",
            "CKB node reported a different duplicate transaction",
            { cause: error },
          );
        }
        acceptance = "duplicate_known";
      } else {
        const known = await this.#chain.getTransactionStatus(intentHash);
        if (
          !known ||
          parseHash32(known.transaction.hash()) !== intentHash ||
          !acceptedStatus(known.status)
        ) {
          throw error;
        }
        acceptance = "hash_lookup";
      }
    }

    if (!(await this.#store.markSubmitted(attempt, intentHash, acceptance))) {
      const current = await this.#store.load(attempt.attemptId, intentHash);
      if (current?.state !== "submitted" || current.transactionHash !== intentHash) {
        return Object.freeze({ status: "stale" });
      }
    }
    return Object.freeze({
      status: "submitted",
      attemptId: attempt.attemptId,
      transactionHash: intentHash,
      acceptance,
    });
  }
}
