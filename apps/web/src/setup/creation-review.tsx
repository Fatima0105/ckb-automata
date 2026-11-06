"use client";

import { CheckCircle2, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiTransactionBuild,
} from "@ckb-automata/api-client";
import {
  deploymentRegistry,
  parseDeadlineCreationRequest,
  parseRecurringCreationRequest,
  type ScriptIdentity,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";
import { Button, InlineNotice } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { browserWebEnvironment } from "../environment.ts";
import { ckbToShannons } from "./ckb-amount.ts";
import { DEADLINE_SERVICE_CHARGE_CKB, deadlineTarget, scheduleToBlock } from "./deadline-form.ts";
import { intervalMinutesToBlocks, RECURRING_SERVICE_CHARGE_CKB } from "./recurring-form.ts";
import { automationTitle } from "./automation-title.ts";
import {
  reviewTechnicalDetailsJson,
  verifyCreationReview,
  type CreationReviewModel,
  type CreationSubmissionRequest,
} from "./review-model.ts";
import type { SetupDraft, SetupTemplateId } from "./setup-flow.ts";

export interface CreationReviewResult {
  readonly artifact: ApiTransactionBuild;
  readonly key: string;
  readonly model: CreationReviewModel;
  readonly request: CreationSubmissionRequest;
  readonly transaction: UnsignedDeadlineTransaction;
}

export type CreationReviewState =
  | { readonly key: string; readonly status: "idle" | "loading" }
  | { readonly error: string; readonly key: string; readonly status: "error" }
  | { readonly key: string; readonly result: CreationReviewResult; readonly status: "ready" };

function canonicalDraft(draft: SetupDraft): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(draft).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

export function creationReviewKey(
  template: SetupTemplateId,
  draft: SetupDraft,
  ownerLockHash: string | undefined,
): string {
  return `${template}:${ownerLockHash ?? "disconnected"}:${canonicalDraft(draft)}`;
}

export function reviewStateError(
  state: CreationReviewState,
  expectedKey: string,
): string | undefined {
  if (state.status === "ready" && state.key === expectedKey) return undefined;
  if (state.status === "error" && state.key === expectedKey) return state.error;
  return "Wait for the exact transaction review to finish before continuing.";
}

function browserApiClient() {
  const environment = browserWebEnvironment();
  return createApiClient({ baseUrl: environment.apiUrl });
}

function nonce(): string {
  const words = new Uint32Array(2);
  globalThis.crypto.getRandomValues(words);
  return ((BigInt(words[0] ?? 0) << 32n) | BigInt(words[1] ?? 0)).toString();
}

export function freezeReviewedTransaction(
  transaction: UnsignedDeadlineTransaction,
): UnsignedDeadlineTransaction {
  return Object.freeze({
    version: transaction.version,
    cellDeps: Object.freeze(
      transaction.cellDeps.map((dependency) =>
        Object.freeze({
          depType: dependency.depType,
          outPoint: Object.freeze({ ...dependency.outPoint }),
        }),
      ),
    ),
    headerDeps: Object.freeze([...transaction.headerDeps]),
    inputs: Object.freeze(
      transaction.inputs.map((input) =>
        Object.freeze({
          previousOutput: Object.freeze({ ...input.previousOutput }),
          since: input.since,
        }),
      ),
    ),
    outputs: Object.freeze(
      transaction.outputs.map((output) =>
        Object.freeze({
          capacity: output.capacity,
          lock: Object.freeze({ ...output.lock }),
          type: output.type === null ? null : Object.freeze({ ...output.type }),
        }),
      ),
    ),
    outputsData: Object.freeze([...transaction.outputsData]),
    witnesses: Object.freeze([...transaction.witnesses]),
  });
}

async function requestFromDraft(
  template: SetupTemplateId,
  draft: SetupDraft,
  ownerLockHash: string,
  resolveLock: (address: string) => Promise<ScriptIdentity>,
  getOwnerLock: (expectedLockHash: string) => Promise<ScriptIdentity>,
  hashLock: (script: ScriptIdentity) => string,
  selectDeadlinePledge: ReturnType<typeof useWalletSession>["selectDeadlinePledge"],
  creatorNonce: string,
  tipBlock?: string,
): Promise<CreationSubmissionRequest> {
  if (template === "recurring") {
    const ownerLock = await getOwnerLock(ownerLockHash);
    const recipientLock = await resolveLock(draft["recipientAddress"] ?? "");
    const preferredOperatorLock =
      draft["operatorMode"] === "custom"
        ? await resolveLock(draft["preferredOperatorAddress"] ?? "")
        : undefined;
    const value = parseRecurringCreationRequest({
      ownerLockHash: hashLock(ownerLock),
      recipientLockHash: hashLock(recipientLock),
      amount: ckbToShannons(draft["amountCkb"] ?? ""),
      intervalBlocks: intervalMinutesToBlocks(draft["intervalMinutes"] ?? ""),
      firstNotBefore: scheduleToBlock(draft["firstExecutionAt"] ?? "", tipBlock ?? ""),
      totalRuns: draft["runCount"] ?? "",
      reward: ckbToShannons(RECURRING_SERVICE_CHARGE_CKB),
      creatorNonce,
      ...(preferredOperatorLock === undefined
        ? {}
        : { preferredExecutorLockHash: hashLock(preferredOperatorLock) }),
    });
    return {
      operation: "create_recurring_job",
      value: {
        ...value,
        lockResolutions: uniqueLockResolutions(
          [ownerLock, recipientLock, ...(preferredOperatorLock ? [preferredOperatorLock] : [])],
          hashLock,
        ),
      },
    };
  }
  const pledge = await selectDeadlinePledge();
  const ownerLock = await getOwnerLock(ownerLockHash);
  const refundLock = await resolveLock(draft["refundAddress"] ?? "");
  const successLock = await resolveLock(draft["successAddress"] ?? "");
  const preferredOperatorLock =
    draft["operatorMode"] === "custom"
      ? await resolveLock(draft["preferredOperatorAddress"] ?? "")
      : undefined;
  const value = parseDeadlineCreationRequest({
    pledges: [
      {
        outPoint: pledge,
        refundLockHash: hashLock(refundLock),
        amount: ckbToShannons(draft["pledgeCkb"] ?? ""),
      },
    ],
    target: deadlineTarget(draft["pledgeCkb"] ?? "", draft["outcome"] ?? ""),
    deadlineBlock: scheduleToBlock(draft["scheduleAt"] ?? "", tipBlock ?? ""),
    successLockHash: hashLock(successLock),
    cancelLockHash: hashLock(ownerLock),
    reward: ckbToShannons(DEADLINE_SERVICE_CHARGE_CKB),
    creatorNonce,
    ...(preferredOperatorLock === undefined
      ? {}
      : { preferredExecutorLockHash: hashLock(preferredOperatorLock) }),
  });
  return {
    operation: "create_deadline_job",
    value: {
      ...value,
      lockResolutions: uniqueLockResolutions(
        [
          ownerLock,
          refundLock,
          successLock,
          ...(preferredOperatorLock ? [preferredOperatorLock] : []),
        ],
        hashLock,
      ),
    },
  };
}

function uniqueLockResolutions(
  locks: readonly ScriptIdentity[],
  hashLock: (script: ScriptIdentity) => string,
): readonly ScriptIdentity[] {
  return Object.freeze([...new Map(locks.map((lock) => [hashLock(lock), lock])).values()]);
}

async function loadReview(
  template: SetupTemplateId,
  draft: SetupDraft,
  key: string,
  session: ReturnType<typeof useWalletSession>,
  creatorNonce: string,
): Promise<CreationReviewResult> {
  if (
    session.status !== "ready" ||
    session.signer === undefined ||
    session.ownerLockHash === undefined
  ) {
    throw new Error("Connect a supported CKB testnet wallet before building the review.");
  }
  const api = browserApiClient();
  const network = (await api.network()) as { readonly tip: { readonly blockNumber: string } };
  const request = await requestFromDraft(
    template,
    draft,
    session.ownerLockHash,
    session.resolveLock,
    session.getOwnerLock,
    session.reviewLockHash,
    session.selectDeadlinePledge,
    creatorNonce,
    network?.tip.blockNumber,
  );
  const artifact = (
    request.operation === "create_recurring_job"
      ? await api.createRecurringJob(request.value)
      : await api.createDeadlineJob({
          ...request.value,
          pledges: request.value.pledges.map((pledge) => ({
            ...pledge,
            outPoint: { txHash: pledge.outPoint.txHash, index: pledge.outPoint.index.toString() },
          })),
        })
  ) as ApiTransactionBuild;
  const genesisHash = artifact.intent["genesisHash"];
  if (typeof genesisHash !== "string") throw new Error("API intent omitted its network identity.");
  const deployment = await deploymentRegistry.load(genesisHash);
  if (deployment.status !== "ok") {
    throw new Error("The transaction references an unverified deployment manifest.");
  }
  if ((await session.getSignerGenesisHash()) !== deployment.deployment.genesisHash) {
    throw new Error("The connected wallet network does not match the reviewed deployment.");
  }
  const completed = await session.completeForReview(
    artifact.transaction as unknown as UnsignedDeadlineTransaction,
  );
  const transaction = freezeReviewedTransaction(completed.transaction);
  const model = await verifyCreationReview(request, artifact, transaction, completed.hash, {
    deployment: deployment.deployment,
    hashLock: session.reviewLockHash,
    ownerInputLockHashes: await session.getSignerLockHashes(),
    resolveInput: session.resolveReviewInput,
  });
  return Object.freeze({ artifact, key, model, request, transaction });
}

function failureMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.status === 409)
      return "The chain snapshot changed. Build and review a fresh transaction.";
    if (error.status >= 500) return "The testnet transaction builder is temporarily unavailable.";
    return "The transaction builder rejected these automation settings.";
  }
  if (error instanceof TypeError) {
    return "The testnet transaction builder could not be reached or returned invalid data.";
  }
  return error instanceof Error
    ? error.message
    : "The exact transaction review could not be built.";
}

export function ReviewSummary({
  draft,
  model,
}: Readonly<{ draft: SetupDraft; model: CreationReviewModel }>) {
  return (
    <div className="setup-review" data-review-status="verified">
      <div className="setup-review__heading">
        <div>
          <h2>{automationTitle(draft) ?? model.title}</h2>
          <p>{model.summary}</p>
        </div>
        <span className="setup-review__verified">
          <CheckCircle2 aria-hidden="true" size={16} />
          Verified
        </span>
      </div>

      <section className="setup-review__section" aria-labelledby="review-timing">
        <h3 id="review-timing">Schedule</h3>
        <p>
          {model.operation === "create_deadline_job" && draft["scheduleAt"]
            ? new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "short" }).format(
                new Date(draft["scheduleAt"]),
              )
            : model.timing}
        </p>
      </section>

      <section className="setup-review__section" aria-labelledby="review-amounts">
        <h3 id="review-amounts">Payment summary</h3>
        <dl className="setup-review__values">
          {model.amounts.map((line) => (
            <div key={line.label}>
              <dt>{line.label}</dt>
              <dd>{line.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="setup-review__section" aria-labelledby="review-recipients">
        <h3 id="review-recipients">Recipients</h3>
        <dl className="setup-review__values">
          {model.operation === "create_recurring_job" ? (
            <div>
              <dt>Payment recipient</dt>
              <dd>
                <code>{draft["recipientAddress"]}</code>
              </dd>
            </div>
          ) : (
            <>
              <div>
                <dt>Recipient address</dt>
                <dd>
                  <code>{draft["successAddress"]}</code>
                </dd>
              </div>
              <div>
                <dt>Refund address</dt>
                <dd>
                  <code>{draft["refundAddress"]}</code>
                </dd>
              </div>
            </>
          )}
        </dl>
      </section>

      <InlineNotice title="Recoverable amount" tone="info">
        <p>{model.recovery}</p>
      </InlineNotice>

      <div className="setup-review__network">
        <ShieldCheck aria-hidden="true" size={18} />
        <div>
          <strong>{model.network}</strong>
          <span>CKB Testnet transaction</span>
        </div>
      </div>

      <details className="setup-review__technical">
        <summary>Technical details</summary>
        <dl>
          <div>
            <dt>Policy intent hash</dt>
            <dd>
              <code>{model.intentHash}</code>
            </dd>
          </div>
          <div>
            <dt>Policy-critical hash</dt>
            <dd>
              <code>{model.policyCriticalHash}</code>
            </dd>
          </div>
          <div>
            <dt>Completed transaction hash</dt>
            <dd>
              <code>{model.transactionHash}</code>
            </dd>
          </div>
          <div>
            <dt>Snapshot hash</dt>
            <dd>
              <code>{model.snapshotHash}</code>
            </dd>
          </div>
          <div>
            <dt>Deployment manifest</dt>
            <dd>
              <code>{model.manifestSha256}</code>
            </dd>
          </div>
        </dl>
        <pre>{reviewTechnicalDetailsJson(model.technicalDetails)}</pre>
      </details>
    </div>
  );
}

export function CreationReview({
  draft,
  onStateChange,
  template,
}: Readonly<{
  draft: SetupDraft;
  onStateChange: (state: CreationReviewState) => void;
  template: SetupTemplateId;
}>) {
  const session = useWalletSession();
  const key = creationReviewKey(template, draft, session.ownerLockHash);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<CreationReviewState>({ key, status: "idle" });
  const creatorNonce = useMemo(nonce, [key, retry]);

  useEffect(() => {
    let active = true;
    const loading = { key, status: "loading" } as const;
    setState(loading);
    onStateChange(loading);
    void loadReview(template, draft, key, session, creatorNonce)
      .then((result) => {
        if (!active) return;
        const ready = { key, result, status: "ready" } as const;
        setState(ready);
        onStateChange(ready);
      })
      .catch((error: unknown) => {
        if (!active) return;
        const failed = { error: failureMessage(error), key, status: "error" } as const;
        setState(failed);
        onStateChange(failed);
      });
    return () => {
      active = false;
    };
  }, [creatorNonce, draft, key, onStateChange, session, template]);

  if (state.status === "ready") {
    return <ReviewSummary draft={draft} model={state.result.model} />;
  }
  if (state.status === "error") {
    return (
      <div className="setup-step__group" data-field-name="review" tabIndex={-1}>
        <InlineNotice title="Transaction review blocked" tone="danger">
          <p>{state.error}</p>
        </InlineNotice>
        <Button
          icon={<RefreshCw aria-hidden="true" size={17} />}
          onClick={() => setRetry((value) => value + 1)}
          tone="secondary"
        >
          Retry review
        </Button>
      </div>
    );
  }
  return (
    <div className="setup-review-loading" data-field-name="review" tabIndex={-1}>
      {state.status === "loading" ? (
        <RefreshCw aria-hidden="true" className="setup-review-loading__icon" size={20} />
      ) : (
        <CheckCircle2 aria-hidden="true" size={20} />
      )}
      <div>
        <h2>Completing exact transaction</h2>
        <p>
          CCC is selecting owner inputs, calculating the fee, and returning change without signing.
        </p>
      </div>
      <TriangleAlert aria-hidden="true" className="setup-review-loading__warning" size={18} />
      <p>No wallet signature is requested during this step.</p>
    </div>
  );
}
