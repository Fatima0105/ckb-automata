"use client";

import { WalletCards } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Button, InlineNotice, TextField } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { shortenCkbAddress } from "../ccc/wallet-display.ts";
import {
  RECURRING_INITIAL_DRAFT,
  validateRecurringStep,
  type RecurringValidationContext,
} from "./recurring-form.ts";
import { RECURRING_SETUP_STEPS } from "./setup-flow.ts";
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

function RecurringDetails(context: SetupStepRenderContext) {
  return (
    <div className="setup-step__group">
      <div>
        <h2>Payment details</h2>
        <p>Choose who receives every payment and how much they receive.</p>
      </div>
      <div className="setup-form-grid">
        <TextField
          {...error(context, "title")}
          hint="Optional. This name is shown on this browser's dashboard."
          label="Automation title"
          maxLength={80}
          name="title"
          onChange={(event) => context.setField("title", event.target.value)}
          placeholder="Monthly operations payment"
          value={context.draft["title"] ?? ""}
        />
        <TextField
          {...error(context, "recipientAddress")}
          autoComplete="off"
          hint="This address receives every scheduled payment."
          label="Recipient address"
          name="recipientAddress"
          onChange={(event) => context.setField("recipientAddress", event.target.value)}
          placeholder="ckt1..."
          required
          value={context.draft["recipientAddress"] ?? ""}
        />
        <TextField
          {...error(context, "amountCkb")}
          hint="The app checks the minimum required by the recipient address."
          inputMode="decimal"
          label="Amount per payment (CKB)"
          name="amountCkb"
          onChange={(event) => context.setField("amountCkb", event.target.value)}
          placeholder="100"
          required
          value={context.draft["amountCkb"] ?? ""}
        />
      </div>
      <OperatorSelectionFields context={context} />
    </div>
  );
}

function RecurringTiming(context: SetupStepRenderContext) {
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
        <h2>Payment schedule</h2>
        <p>Choose the first payment time and how often the payment should repeat.</p>
      </div>
      <div className="setup-form-grid setup-form-grid--three">
        <TextField
          {...error(context, "firstExecutionAt")}
          hint="Past dates and times are not allowed."
          label="First payment date and time"
          min={minimum || undefined}
          name="firstExecutionAt"
          onChange={(event) => context.setField("firstExecutionAt", event.target.value)}
          required
          type="datetime-local"
          value={context.draft["firstExecutionAt"] ?? ""}
        />
        <TextField
          {...error(context, "intervalMinutes")}
          hint="For example, 60 means once every hour."
          inputMode="numeric"
          label="Repeat every (minutes)"
          min="1"
          name="intervalMinutes"
          onChange={(event) => context.setField("intervalMinutes", event.target.value)}
          placeholder="60"
          required
          value={context.draft["intervalMinutes"] ?? ""}
        />
        <TextField
          {...error(context, "runCount")}
          hint="The total number of payments to send."
          inputMode="numeric"
          label="Number of payments"
          name="runCount"
          onChange={(event) => context.setField("runCount", event.target.value)}
          placeholder="3"
          required
          value={context.draft["runCount"] ?? ""}
        />
      </div>
      {session.status === "ready" ? (
        <div
          data-field-name="ownerAddress"
          tabIndex={context.errors["ownerAddress"] === undefined ? undefined : -1}
        >
          <InlineNotice
            title={
              context.errors["ownerAddress"] === undefined
                ? "Payment wallet confirmed"
                : "Wallet cannot cover this schedule"
            }
            tone={context.errors["ownerAddress"] === undefined ? "success" : "danger"}
          >
            <p>
              {context.errors["ownerAddress"] ??
                `${session.walletName ?? "Connected wallet"}: ${shortenCkbAddress(session.address ?? "")}. All charges are added automatically and shown on the next review.`}
            </p>
          </InlineNotice>
        </div>
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

function RecurringStep({
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
  if (context.step === "details") return <RecurringDetails {...context} />;
  if (context.step === "timing") return <RecurringTiming {...context} />;
  if (context.step === "review") {
    return (
      <CreationReview
        draft={context.draft}
        onStateChange={onReviewStateChange}
        template="recurring"
      />
    );
  }
  if (context.step === "approval") {
    return (
      <CreationApproval
        draft={context.draft}
        onStateChange={onSubmissionStateChange}
        reviewState={reviewState}
        template="recurring"
      />
    );
  }
  return <CreationSubmissionResult template="recurring" />;
}

export function RecurringSetup() {
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
  const validationContext: RecurringValidationContext = {
    balanceShannons: session.balanceShannons,
    ownerLockHash: session.ownerLockHash,
    resolveLock: session.resolveLock,
    resolveLockHash: session.resolveLockHash,
    walletReady: session.status === "ready",
  };
  return (
    <SetupStepper
      initialDraft={RECURRING_INITIAL_DRAFT}
      isContinueDisabled={(step, draft) =>
        step === "review" &&
        reviewStateError(
          reviewState,
          creationReviewKey("recurring", draft, session.ownerLockHash),
        ) !== undefined
      }
      renderStep={(context) => (
        <RecurringStep
          context={context}
          onReviewStateChange={onReviewStateChange}
          onSubmissionStateChange={onSubmissionStateChange}
          reviewState={reviewState}
        />
      )}
      template="recurring"
      steps={RECURRING_SETUP_STEPS}
      validateStep={(step, draft) => {
        if (step === "review") {
          const message = reviewStateError(
            reviewState,
            creationReviewKey("recurring", draft, session.ownerLockHash),
          );
          return message === undefined ? {} : { review: message };
        }
        if (step === "approval") {
          const message = submissionStateError(
            submissionState,
            creationReviewKey("recurring", draft, session.ownerLockHash),
          );
          return message === undefined ? {} : { approval: message };
        }
        return validateRecurringStep(step, draft, validationContext);
      }}
    />
  );
}
