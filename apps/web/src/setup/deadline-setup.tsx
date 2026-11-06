"use client";

import { CheckCircle2, RotateCcw, WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button, InlineNotice, TextField } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { shortenCkbAddress } from "../ccc/wallet-display.ts";
import {
  DEADLINE_INITIAL_DRAFT,
  validateDeadlineStep,
  type DeadlineValidationContext,
} from "./deadline-form.ts";
import { DEADLINE_SETUP_STEPS } from "./setup-flow.ts";
import type { SetupStepRenderContext } from "./setup-stepper.tsx";
import { OperatorSelectionFields } from "./operator-selection-fields.tsx";
import { SetupStepper } from "./setup-stepper.tsx";
import {
  CreationReview,
  creationReviewKey,
  reviewStateError,
  type CreationReviewState,
} from "./creation-review.tsx";
import {
  CreationApproval,
  CreationSubmissionResult,
  submissionStateError,
  type CreationSubmissionState,
} from "./creation-submission.tsx";

function error(context: SetupStepRenderContext, name: string) {
  const message = context.errors[name];
  return message === undefined ? {} : { error: message };
}

function DeadlineDetails(context: SetupStepRenderContext) {
  const session = useWalletSession();
  return (
    <div className="setup-step__group">
      <div>
        <h2>Recipient payment</h2>
        <p>Name this automation and choose where the payment or refund should go.</p>
      </div>
      <div className="setup-form-grid">
        <TextField
          {...error(context, "title")}
          hint="Optional. This name is shown on this browser's dashboard."
          label="Automation title"
          maxLength={80}
          name="title"
          onChange={(event) => context.setField("title", event.target.value)}
          placeholder="September supplier payment"
          value={context.draft["title"] ?? ""}
        />
        <TextField
          {...error(context, "pledgeCkb")}
          hint="This is the amount the recipient can receive. The app checks the minimum required by both addresses."
          inputMode="decimal"
          label="Recipient amount (CKB)"
          name="pledgeCkb"
          onChange={(event) => context.setField("pledgeCkb", event.target.value)}
          placeholder="80"
          required
          value={context.draft["pledgeCkb"] ?? ""}
        />
        <TextField
          {...error(context, "successAddress")}
          autoComplete="off"
          hint="Receives the amount when Pay recipient is selected."
          label="Recipient address"
          name="successAddress"
          onChange={(event) => context.setField("successAddress", event.target.value)}
          placeholder="ckt1..."
          required
          value={context.draft["successAddress"] ?? ""}
        />
        <TextField
          {...error(context, "refundAddress")}
          autoComplete="off"
          hint="Receives the amount when Refund amount is selected."
          label="Refund address"
          name="refundAddress"
          onChange={(event) => context.setField("refundAddress", event.target.value)}
          placeholder="ckt1..."
          required
          endAction={{
            disabled: session.address === undefined,
            label: "Use mine",
            onClick: () => {
              if (session.address !== undefined) context.setField("refundAddress", session.address);
            },
          }}
          value={context.draft["refundAddress"] ?? ""}
        />
      </div>
      <fieldset
        className="setup-outcome"
        data-field-name="outcome"
        data-invalid={context.errors["outcome"] === undefined ? undefined : "true"}
        tabIndex={context.errors["outcome"] === undefined ? undefined : -1}
      >
        <legend>At the scheduled time</legend>
        <div aria-label="Scheduled outcome" role="radiogroup">
          <button
            aria-checked={context.draft["outcome"] === "success"}
            onClick={() => context.setField("outcome", "success")}
            role="radio"
            type="button"
          >
            <CheckCircle2 aria-hidden="true" size={17} />
            Pay recipient
          </button>
          <button
            aria-checked={context.draft["outcome"] === "refund"}
            onClick={() => context.setField("outcome", "refund")}
            role="radio"
            type="button"
          >
            <RotateCcw aria-hidden="true" size={17} />
            Refund amount
          </button>
        </div>
        {context.errors["outcome"] === undefined ? null : (
          <span className="ui-field__error" role="alert">
            {context.errors["outcome"]}
          </span>
        )}
      </fieldset>
      <OperatorSelectionFields context={context} />
    </div>
  );
}

function DeadlineTiming(context: SetupStepRenderContext) {
  const session = useWalletSession();
  const [minimum, setMinimum] = useState("");
  useEffect(() => {
    const now = new Date();
    now.setMinutes(now.getMinutes() - now.getTimezoneOffset() + 1, 0, 0);
    setMinimum(now.toISOString().slice(0, 16));
  }, []);
  return (
    <div className="setup-step__group">
      <div>
        <h2>Schedule date</h2>
        <p>Choose when the automation should process the selected outcome.</p>
      </div>
      <TextField
        {...error(context, "scheduleAt")}
        hint="Times in the past are not allowed. Network timing can vary slightly."
        label="Date and time"
        min={minimum || undefined}
        name="scheduleAt"
        onChange={(event) => context.setField("scheduleAt", event.target.value)}
        required
        type="datetime-local"
        value={context.draft["scheduleAt"] ?? ""}
      />
      {session.status === "ready" ? (
        <InlineNotice title="Refund wallet confirmed" tone="success">
          <p>
            {session.walletName ?? "Connected wallet"}: {shortenCkbAddress(session.address ?? "")}.
            This wallet can cancel or recover the automation.
          </p>
        </InlineNotice>
      ) : (
        <InlineNotice title="Wallet required" tone="warning">
          <p>Connect a CKB testnet wallet to pay and retain recovery control.</p>
          <Button
            icon={<WalletCards aria-hidden="true" size={17} />}
            name="ownerAddress"
            onClick={session.open}
            tone="secondary"
          >
            Connect wallet
          </Button>
        </InlineNotice>
      )}
    </div>
  );
}

function DeadlineStep({
  context,
  onReviewStateChange,
  onSubmissionStateChange,
  reviewState,
}: Readonly<{
  context: SetupStepRenderContext;
  onReviewStateChange: (state: CreationReviewState) => void;
  onSubmissionStateChange: (state: CreationSubmissionState) => void;
  reviewState: CreationReviewState;
}>) {
  if (context.step === "details") return <DeadlineDetails {...context} />;
  if (context.step === "timing") return <DeadlineTiming {...context} />;
  if (context.step === "review") {
    return (
      <CreationReview
        draft={context.draft}
        onStateChange={onReviewStateChange}
        template="deadline"
      />
    );
  }
  if (context.step === "approval") {
    return (
      <CreationApproval
        draft={context.draft}
        onStateChange={onSubmissionStateChange}
        reviewState={reviewState}
        template="deadline"
      />
    );
  }
  return <CreationSubmissionResult template="deadline" />;
}

export function DeadlineSetup() {
  const session = useWalletSession();
  const [reviewState, setReviewState] = useState<CreationReviewState>({ key: "", status: "idle" });
  const [submissionState, setSubmissionState] = useState<CreationSubmissionState>({
    key: "",
    status: "idle",
  });
  const onReviewStateChange = useCallback(
    (state: CreationReviewState) => setReviewState(state),
    [],
  );
  const onSubmissionStateChange = useCallback(
    (state: CreationSubmissionState) => setSubmissionState(state),
    [],
  );
  const validationContext: DeadlineValidationContext = {
    ownerLockHash: session.ownerLockHash,
    resolveLock: session.resolveLock,
    resolveLockHash: session.resolveLockHash,
    walletReady: session.status === "ready",
  };

  return (
    <SetupStepper
      initialDraft={DEADLINE_INITIAL_DRAFT}
      isContinueDisabled={(step, draft) =>
        step === "review" &&
        reviewStateError(
          reviewState,
          creationReviewKey("deadline", draft, session.ownerLockHash),
        ) !== undefined
      }
      renderStep={(context) => (
        <DeadlineStep
          context={context}
          onReviewStateChange={onReviewStateChange}
          onSubmissionStateChange={onSubmissionStateChange}
          reviewState={reviewState}
        />
      )}
      template="deadline"
      steps={DEADLINE_SETUP_STEPS}
      validateStep={(step, draft) => {
        if (step === "review") {
          const message = reviewStateError(
            reviewState,
            creationReviewKey("deadline", draft, session.ownerLockHash),
          );
          return message === undefined ? {} : { review: message };
        }
        if (step === "approval") {
          const message = submissionStateError(
            submissionState,
            creationReviewKey("deadline", draft, session.ownerLockHash),
          );
          return message === undefined ? {} : { approval: message };
        }
        return validateDeadlineStep(step, draft, validationContext);
      }}
    />
  );
}
