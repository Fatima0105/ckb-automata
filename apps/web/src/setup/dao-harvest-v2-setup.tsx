"use client";

import { CheckCircle2, ExternalLink, LoaderCircle, ShieldCheck, WalletCards } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiDaoHarvestV2Build,
} from "@ckb-automata/api-client";
import { Button, InlineNotice, TextField } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { ckbTestnetTransactionUrl, shortenCkbAddress } from "../ccc/wallet-display.ts";
import { browserWebEnvironment } from "../environment.ts";
import { harvestV2Amount } from "../dao-harvest/v2-presentation.ts";
import {
  automationTitle,
  validateAutomationTitle,
  writeAutomationTitle,
} from "./automation-title.ts";
import { ckbToShannons } from "./ckb-amount.ts";
import {
  daoHarvestV2ReviewSnapshot,
  normalizeDaoHarvestV2Build,
  verifyCompletedDaoHarvestV2Review,
  verifyRefreshedDaoHarvestV2Build,
} from "./dao-harvest-v2-review.ts";
import { DAO_HARVEST_SETUP_STEPS, type SetupDraft, type SetupErrors } from "./setup-flow.ts";
import { SetupStepper, type SetupStepRenderContext } from "./setup-stepper.tsx";
import { OperatorSelectionFields } from "./operator-selection-fields.tsx";
import { DEFAULT_OPERATOR_DRAFT } from "./operator-directory.ts";

const INITIAL_DRAFT: SetupDraft = Object.freeze({
  ...DEFAULT_OPERATOR_DRAFT,
  cycleCount: "1",
  payoutAddress: "",
  principalCkb: "",
  recurrence: "once",
  title: "",
});
const MAX_CYCLES = 12;
const MINIMUM_CKB = 242n;

interface ReadyReview {
  readonly body: Record<string, unknown>;
  readonly build: ApiDaoHarvestV2Build;
  readonly completed: ReturnType<typeof normalizeDaoHarvestV2Build>["transaction"];
  readonly key: string;
  readonly snapshot: ReturnType<typeof daoHarvestV2ReviewSnapshot>;
  readonly transactionHash: string;
}

type ReviewState =
  | { readonly status: "idle" | "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly value: ReadyReview };

function api() {
  return createApiClient({ baseUrl: browserWebEnvironment().apiUrl });
}

function nonce(): string {
  const words = new Uint32Array(2);
  globalThis.crypto.getRandomValues(words);
  return ((BigInt(words[0] ?? 0) << 32n) | BigInt(words[1] ?? 0)).toString();
}

function reviewKey(draft: SetupDraft, ownerLockHash: string | undefined): string {
  return JSON.stringify({ draft, ownerLockHash });
}

function cycles(draft: SetupDraft): number {
  if (draft["recurrence"] !== "finite") return 1;
  const value = draft["cycleCount"] ?? "";
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error("Choose a whole number of harvests.");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2 || parsed > MAX_CYCLES) {
    throw new Error(`Choose between 2 and ${MAX_CYCLES} harvests.`);
  }
  return parsed;
}

function principal(draft: SetupDraft): string {
  const value = BigInt(ckbToShannons(draft["principalCkb"] ?? ""));
  if (value < MINIMUM_CKB * 100_000_000n)
    throw new Error("Original amount must be at least 242 CKB.");
  return value.toString();
}

function fieldError(context: SetupStepRenderContext, name: string) {
  const message = context.errors[name];
  return message === undefined ? {} : { error: message };
}

function reviewFailure(reason: unknown): string {
  if (reason instanceof ApiClientError && reason.status === 409)
    return "The chain changed. Build a fresh review.";
  if (reason instanceof ApiClientError && reason.status >= 500)
    return "The harvest builder is temporarily unavailable.";
  if (reason instanceof TypeError) return "The testnet service could not be reached.";
  return reason instanceof Error ? reason.message : "These harvest settings could not be prepared.";
}

async function setupBody(
  draft: SetupDraft,
  session: ReturnType<typeof useWalletSession>,
  creatorNonce: string,
) {
  if (!session.ownerLockHash) throw new Error("Connect the owner wallet first.");
  const customOperators = draft["operatorMode"] === "custom";
  const [identityOutPoint, ownerLock, payoutLock, preferredOperatorLock, backupOperatorLock] =
    await Promise.all([
      session.selectDeadlinePledge(),
      session.getOwnerLock(session.ownerLockHash),
      session.resolveLock(draft["payoutAddress"] ?? ""),
      customOperators
        ? session.resolveLock(draft["preferredOperatorAddress"] ?? "")
        : Promise.resolve(undefined),
      customOperators
        ? session.resolveLock(draft["backupOperatorAddress"] ?? "")
        : Promise.resolve(undefined),
    ]);
  return Object.freeze({
    creatorNonce,
    identityOutPoint,
    ownerLock,
    ownerLockHash: session.ownerLockHash,
    payoutLock,
    payoutLockHash: session.reviewLockHash(payoutLock),
    principal: principal(draft),
    totalCycles: cycles(draft),
    ...(preferredOperatorLock === undefined || backupOperatorLock === undefined
      ? {}
      : {
          preferredOperatorLockHash: session.reviewLockHash(preferredOperatorLock),
          backupOperatorLockHashes: [session.reviewLockHash(backupOperatorLock)],
        }),
  });
}

async function validateDetails(
  draft: SetupDraft,
  session: ReturnType<typeof useWalletSession>,
): Promise<SetupErrors> {
  const errors: Record<string, string> = {};
  const titleError = validateAutomationTitle(draft);
  if (titleError) errors["title"] = titleError;
  try {
    principal(draft);
  } catch (reason) {
    errors["principalCkb"] = reason instanceof Error ? reason.message : "Enter a valid amount.";
  }
  if (!(draft["payoutAddress"] ?? "").trim()) {
    errors["payoutAddress"] = "Enter the address that receives earned compensation.";
  } else {
    try {
      await session.resolveLockHash(draft["payoutAddress"]!);
    } catch {
      errors["payoutAddress"] = "Enter a valid CKB testnet address.";
    }
  }
  try {
    cycles(draft);
  } catch (reason) {
    errors["cycleCount"] = reason instanceof Error ? reason.message : "Choose a valid count.";
  }
  if (session.status !== "ready" || !session.ownerLockHash) {
    errors["ownerAddress"] = "Connect a supported CKB testnet wallet.";
  }
  if (draft["operatorMode"] === "custom") {
    for (const [field, label] of [
      ["preferredOperatorAddress", "preferred operator"],
      ["backupOperatorAddress", "backup operator"],
    ] as const) {
      const value = (draft[field] ?? "").trim();
      if (!value) {
        errors[field] = `Enter the ${label} address.`;
        continue;
      }
      try {
        await session.resolveLockHash(value);
      } catch {
        errors[field] = `Enter a valid CKB testnet ${label} address.`;
      }
    }
  }
  return errors;
}

function HarvestV2Details(context: SetupStepRenderContext) {
  const session = useWalletSession();
  const recurrence = context.draft["recurrence"] ?? "once";
  return (
    <div className="setup-step__group">
      <div>
        <h2>Harvest details</h2>
        <p>
          Your original amount is re-deposited after each harvest. Service charges come only from
          earned compensation.
        </p>
      </div>
      <div className="setup-form-grid">
        <TextField
          {...fieldError(context, "title")}
          hint="Optional. Shown only in this browser."
          label="Automation title"
          maxLength={80}
          name="title"
          onChange={(event) => context.setField("title", event.target.value)}
          placeholder="My DAO harvest"
          value={context.draft["title"] ?? ""}
        />
        <TextField
          {...fieldError(context, "principalCkb")}
          hint="This exact amount stays protected. Minimum 242 CKB."
          inputMode="decimal"
          label="Original amount (CKB)"
          name="principalCkb"
          onChange={(event) => context.setField("principalCkb", event.target.value)}
          placeholder="1000"
          required
          value={context.draft["principalCkb"] ?? ""}
        />
        <TextField
          {...fieldError(context, "payoutAddress")}
          autoComplete="off"
          hint="Available compensation is sent here when you withdraw it."
          label="Compensation address"
          name="payoutAddress"
          onChange={(event) => context.setField("payoutAddress", event.target.value)}
          placeholder="ckt1..."
          required
          value={context.draft["payoutAddress"] ?? ""}
        />
      </div>
      <fieldset
        className="setup-outcome"
        data-invalid={context.errors["cycleCount"] ? "true" : undefined}
      >
        <legend>How often?</legend>
        <div>
          <button
            aria-checked={recurrence === "once"}
            onClick={() => context.setField("recurrence", "once")}
            role="radio"
            type="button"
          >
            One harvest
          </button>
          <button
            aria-checked={recurrence === "finite"}
            onClick={() => context.setField("recurrence", "finite")}
            role="radio"
            type="button"
          >
            Several harvests
          </button>
        </div>
      </fieldset>
      {recurrence === "finite" ? (
        <TextField
          {...fieldError(context, "cycleCount")}
          hint="Choose 2 to 12. You can recover or update operators later."
          inputMode="numeric"
          label="Number of harvests"
          max={12}
          min="2"
          name="cycleCount"
          onChange={(event) => context.setField("cycleCount", event.target.value)}
          required
          value={context.draft["cycleCount"] ?? ""}
        />
      ) : null}
      <OperatorSelectionFields context={context} />
      {session.status === "ready" ? (
        <InlineNotice title="Owner wallet connected" tone="success">
          <p>
            {shortenCkbAddress(session.address ?? "")}. Only this wallet can update operators,
            close, or recover.
          </p>
        </InlineNotice>
      ) : (
        <InlineNotice title="Wallet required" tone="warning">
          <p>Connect a supported CKB testnet wallet to continue.</p>
          <Button icon={<WalletCards size={17} />} onClick={session.open} tone="secondary">
            Connect wallet
          </Button>
        </InlineNotice>
      )}
    </div>
  );
}

function HarvestV2Review({
  context,
  onState,
  state,
}: Readonly<{
  context: SetupStepRenderContext;
  onState: (state: ReviewState) => void;
  state: ReviewState;
}>) {
  const session = useWalletSession();
  const key = reviewKey(context.draft, session.ownerLockHash);
  const creatorNonce = useMemo(nonce, [key]);
  useEffect(() => {
    if (session.status !== "ready" || !session.ownerLockHash) {
      onState({ status: "error", message: "Connect a supported CKB testnet wallet first." });
      return;
    }
    let active = true;
    onState({ status: "loading" });
    void setupBody(context.draft, session, creatorNonce)
      .then(async (body) => {
        const [build, network] = await Promise.all([
          api().buildDaoHarvestV2("setup", body),
          api().network() as Promise<{
            readonly tip: { readonly blockHash: string; readonly blockNumber: string };
          }>,
        ]);
        const normalized = normalizeDaoHarvestV2Build(build);
        const completed = await session.completeForReview(normalized.transaction);
        await verifyCompletedDaoHarvestV2Review(build, completed.transaction, session);
        return { body, build, completed, network };
      })
      .then(({ body, build, completed, network }) => {
        if (!active) return;
        onState({
          status: "ready",
          value: {
            body,
            build,
            completed: completed.transaction,
            key,
            snapshot: daoHarvestV2ReviewSnapshot(network.tip),
            transactionHash: completed.hash,
          },
        });
      })
      .catch((reason: unknown) => {
        if (active) onState({ status: "error", message: reviewFailure(reason) });
      });
    return () => {
      active = false;
    };
  }, [context.draft, creatorNonce, key, onState, session]);

  if (state.status === "loading" || state.status === "idle")
    return (
      <div aria-live="polite" className="setup-review-loading">
        <LoaderCircle className="setup-review-loading__icon" />
        <div>
          <h2>Preparing your review</h2>
          <p>Checking the exact deposit, reserve, service charges, and network fee...</p>
        </div>
      </div>
    );
  if (state.status !== "ready")
    return (
      <InlineNotice title="Review unavailable" tone="danger">
        <p>{state.status === "error" ? state.message : "Build a fresh review."}</p>
      </InlineNotice>
    );
  const review = state.value.build.review;
  return (
    <div className="setup-review">
      <div>
        <p className="setup-review__eyebrow">Wallet review</p>
        <h2>Check the full amount</h2>
        <p>
          Service charges are maximums and are paid only from compensation earned by completed work.
        </p>
      </div>
      <dl className="setup-review__values">
        <div>
          <dt>Original amount</dt>
          <dd>{harvestV2Amount(review.originalAmount)}</dd>
        </div>
        <div>
          <dt>Expected compensation</dt>
          <dd>{harvestV2Amount(review.expectedCompensation)}</dd>
        </div>
        <div>
          <dt>Maximum service charges</dt>
          <dd>{harvestV2Amount(review.completedWorkCharges.maximumTotal)}</dd>
        </div>
        <div>
          <dt>Maximum network fee</dt>
          <dd>{harvestV2Amount(review.maximumNetworkFee)}</dd>
        </div>
        <div>
          <dt>Recoverable reserve</dt>
          <dd>{harvestV2Amount(review.recoverableReserve)}</dd>
        </div>
        <div className="setup-review__total">
          <dt>Total amount to deposit</dt>
          <dd>{harvestV2Amount(review.totalLockedAmount)}</dd>
        </div>
      </dl>
      <InlineNotice title="Your original amount is protected" tone="success">
        <p>
          It cannot be used for service charges or network fees. The reserve remains yours and
          returns when you close or recover.
        </p>
      </InlineNotice>
    </div>
  );
}

function HarvestV2Approval({
  context,
  reviewState,
}: Readonly<{ context: SetupStepRenderContext; reviewState: ReviewState }>) {
  const session = useWalletSession();
  const [state, setState] = useState<
    | { status: "idle" | "submitting" }
    | { status: "error"; message: string }
    | {
        status: "submitted";
        registration: "registered" | "retry";
        transactionHash: string;
      }
  >({ status: "idle" });
  if (
    reviewState.status !== "ready" ||
    reviewState.value.key !== reviewKey(context.draft, session.ownerLockHash)
  ) {
    return (
      <InlineNotice title="Fresh review required" tone="warning">
        <p>Return to Review and rebuild the exact transaction.</p>
      </InlineNotice>
    );
  }
  const review = reviewState.value;
  const submit = async () => {
    setState({ status: "submitting" });
    try {
      const refreshed = await api().buildDaoHarvestV2("setup", review.body);
      verifyRefreshedDaoHarvestV2Build(review.build, refreshed);
      const signed = await session.signReviewedTransaction(
        review.completed,
        review.transactionHash,
        review.snapshot,
      );
      const transactionHash = await session.submitSignedTransaction(signed, review.transactionHash);
      writeAutomationTitle(window.localStorage, review.build.jobId, automationTitle(context.draft));
      let registration: "registered" | "retry" = "registered";
      try {
        await api().registerDaoHarvestV2Setup({ transactionHash });
      } catch {
        registration = "retry";
      }
      setState({ status: "submitted", registration, transactionHash });
    } catch (reason) {
      setState({ status: "error", message: reviewFailure(reason) });
    }
  };
  if (state.status === "submitted")
    return (
      <div className="setup-submission-success">
        <span className="setup-submission-success__icon">
          <CheckCircle2 />
        </span>
        <div>
          <p className="setup-submission-success__eyebrow">Submitted</p>
          <h2>Your harvest automation is confirming</h2>
        </div>
        <p>It appears in Automations while CKB testnet confirms it.</p>
        {state.registration === "retry" ? (
          <InlineNotice title="Transaction submitted" tone="warning">
            <p>
              The transaction succeeded, but its temporary list entry still needs to be registered.
            </p>
            <Button
              onClick={() => {
                void api()
                  .registerDaoHarvestV2Setup({ transactionHash: state.transactionHash })
                  .then(() => setState({ ...state, registration: "registered" }))
                  .catch(() => undefined);
              }}
              tone="secondary"
            >
              Retry listing
            </Button>
          </InlineNotice>
        ) : null}
        <div className="setup-submission-success__actions">
          <a className="ui-button ui-button--primary" href="/automations">
            View automations
          </a>
          <a
            className="ui-button ui-button--secondary"
            href={ckbTestnetTransactionUrl(state.transactionHash)}
            rel="noreferrer"
            target="_blank"
          >
            Open transaction <ExternalLink size={15} />
          </a>
        </div>
      </div>
    );
  return (
    <div className="setup-approval">
      <div className="setup-approval__heading">
        <ShieldCheck size={22} />
        <div>
          <h2>Approve in your wallet</h2>
          <p>Your wallet signs only the transaction and limits shown in Review.</p>
        </div>
      </div>
      {state.status === "error" ? (
        <InlineNotice title="Submission stopped" tone="danger">
          <p>{state.message}</p>
        </InlineNotice>
      ) : null}
      <Button
        disabled={state.status === "submitting"}
        icon={
          state.status === "submitting" ? (
            <LoaderCircle className="setup-review-loading__icon" size={17} />
          ) : (
            <WalletCards size={17} />
          )
        }
        onClick={() => void submit()}
      >
        {state.status === "submitting" ? "Waiting for wallet..." : "Approve and submit"}
      </Button>
      <p className="setup-approval__footnote">
        Rejecting or closing the wallet request submits nothing.
      </p>
    </div>
  );
}

export function DaoHarvestV2Setup() {
  const session = useWalletSession();
  const [reviewState, setReviewState] = useState<ReviewState>({ status: "idle" });
  const updateReview = useCallback((value: ReviewState) => setReviewState(value), []);
  const validate = useMemo(
    () => (step: string, draft: SetupDraft) =>
      step === "details" ? validateDetails(draft, session) : {},
    [session],
  );
  return (
    <SetupStepper
      initialDraft={INITIAL_DRAFT}
      isContinueDisabled={(step, draft) =>
        step === "review" &&
        !(
          reviewState.status === "ready" &&
          reviewState.value.key === reviewKey(draft, session.ownerLockHash)
        )
      }
      renderStep={(context) =>
        context.step === "details" ? (
          <HarvestV2Details {...context} />
        ) : context.step === "review" ? (
          <HarvestV2Review context={context} onState={updateReview} state={reviewState} />
        ) : context.step === "approval" ? (
          <HarvestV2Approval context={context} reviewState={reviewState} />
        ) : null
      }
      storageId="v2"
      steps={DAO_HARVEST_SETUP_STEPS}
      template="dao-harvest"
      validateStep={(step, draft) =>
        step === "review"
          ? reviewState.status === "ready" &&
            reviewState.value.key === reviewKey(draft, session.ownerLockHash)
            ? {}
            : { review: "Wait for the transaction review to finish." }
          : validate(step, draft)
      }
    />
  );
}
