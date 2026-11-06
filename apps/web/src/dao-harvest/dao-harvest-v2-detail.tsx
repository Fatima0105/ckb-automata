"use client";

import {
  CheckCircle2,
  ExternalLink,
  Landmark,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import {
  ApiClientError,
  createApiClient,
  type ApiDaoHarvestV2,
  type ApiDaoHarvestV2Build,
  type AutomataApiClient,
} from "@ckb-automata/api-client";
import { Button, Dialog, InlineNotice, TextField } from "@ckb-automata/ui";

import { useWalletSession } from "../ccc/session.tsx";
import { ckbTestnetTransactionUrl } from "../ccc/wallet-display.ts";
import { browserWebEnvironment } from "../environment.ts";
import { readAutomationTitles } from "../setup/automation-title.ts";
import {
  normalizeDaoHarvestV2Build,
  verifyCompletedDaoHarvestV2Review,
  verifyRefreshedDaoHarvestV2Build,
} from "../setup/dao-harvest-v2-review.ts";
import {
  daoHarvestV2Presentation,
  harvestV2Amount,
  harvestV2Operation,
  harvestV2OwnerActions,
} from "./v2-presentation.ts";

type OwnerOperation = "sweep" | "close" | "rotate" | "recover";

interface PreparedAction {
  readonly build: ApiDaoHarvestV2Build;
  readonly body: Record<string, unknown>;
  readonly completed: ReturnType<typeof normalizeDaoHarvestV2Build>["transaction"];
  readonly snapshot: { readonly blockHash: string; readonly blockNumber: string };
  readonly transactionHash: string;
}

const ACTION_COPY: Readonly<
  Record<
    OwnerOperation,
    { readonly button: string; readonly description: string; readonly title: string }
  >
> = {
  sweep: {
    title: "Withdraw earned compensation",
    description:
      "Sends the available compensation to your payout address and keeps the recoverable reserve for later harvests.",
    button: "Review withdrawal",
  },
  close: {
    title: "Close automation",
    description:
      "Closes a completed automation and returns the remaining compensation and recoverable reserve.",
    button: "Review closure",
  },
  rotate: {
    title: "Update operators",
    description:
      "Choose who acts first and who may take over later. Your original amount and payout address cannot change.",
    button: "Review operator update",
  },
  recover: {
    title: "Recover without the service",
    description:
      "Uses the owner recovery path. CKAutomata's API and operators are not allowed to replace your approval.",
    button: "Review recovery",
  },
};

function actionError(reason: unknown): string {
  if (reason instanceof ApiClientError && reason.status === 409) {
    return "The chain changed. Build a fresh review.";
  }
  if (reason instanceof ApiClientError && reason.status >= 500) {
    return "This action is temporarily unavailable. Please try again.";
  }
  return "Nothing was submitted. Build a fresh review and try again.";
}

function HarvestV2OwnerAction({
  api,
  job,
  operation,
}: Readonly<{ api: AutomataApiClient; job: ApiDaoHarvestV2; operation: OwnerOperation }>) {
  const session = useWalletSession();
  const copy = ACTION_COPY[operation];
  const [preferredAddress, setPreferredAddress] = useState("");
  const [backupAddress, setBackupAddress] = useState("");
  const [payoutAddress, setPayoutAddress] = useState("");
  const [state, setState] = useState<
    | { readonly status: "idle" | "loading" | "submitting" }
    | { readonly status: "error"; readonly message: string }
    | { readonly status: "ready"; readonly value: PreparedAction }
    | { readonly status: "submitted"; readonly transactionHash: string }
  >({ status: "idle" });

  const requestBody = async (): Promise<Record<string, unknown>> => {
    if (session.ownerLockHash !== job.ownerLockHash) throw new Error("Reconnect the owner wallet.");
    const [ownerLock, identityOutPoint] = await Promise.all([
      session.getOwnerLock(job.ownerLockHash),
      session.selectDeadlinePledge(),
    ]);
    if (operation === "sweep" || operation === "close") {
      const payoutLock =
        job.payoutLockHash === job.ownerLockHash
          ? ownerLock
          : await session.resolveLock(payoutAddress);
      return { jobId: job.jobId, identityOutPoint, ownerLock, payoutLock };
    }
    if (operation !== "rotate") return { jobId: job.jobId, identityOutPoint, ownerLock };
    const [preferredOperatorLock, backupOperatorLock] = await Promise.all([
      session.resolveLock(preferredAddress),
      session.resolveLock(backupAddress),
    ]);
    return {
      jobId: job.jobId,
      identityOutPoint,
      ownerLock,
      preferredOperatorLockHash: session.reviewLockHash(preferredOperatorLock),
      backupOperatorLockHashes: [session.reviewLockHash(backupOperatorLock)],
    };
  };

  const prepare = async () => {
    setState({ status: "loading" });
    try {
      const body = await requestBody();
      const [build, network] = await Promise.all([
        api.buildDaoHarvestV2(operation, body),
        api.network() as Promise<{
          readonly tip: { readonly blockHash: string; readonly blockNumber: string };
        }>,
      ]);
      const normalized = normalizeDaoHarvestV2Build(build);
      const completed = await session.completeForReview(normalized.transaction);
      await verifyCompletedDaoHarvestV2Review(build, completed.transaction, session);
      setState({
        status: "ready",
        value: {
          build,
          body,
          completed: completed.transaction,
          snapshot: network.tip,
          transactionHash: completed.hash,
        },
      });
    } catch (reason) {
      setState({ status: "error", message: actionError(reason) });
    }
  };

  const submit = async (prepared: PreparedAction) => {
    setState({ status: "submitting" });
    try {
      const refreshed = await api.buildDaoHarvestV2(operation, prepared.body);
      verifyRefreshedDaoHarvestV2Build(prepared.build, refreshed);
      const signed = await session.signReviewedTransaction(
        prepared.completed,
        prepared.transactionHash,
        prepared.snapshot,
      );
      const transactionHash = await session.submitSignedTransaction(
        signed,
        prepared.transactionHash,
      );
      setState({ status: "submitted", transactionHash });
    } catch (reason) {
      setState({ status: "error", message: actionError(reason) });
    }
  };

  return (
    <Dialog
      description={copy.description}
      title={copy.title}
      trigger={
        <Button tone={operation === "recover" ? "primary" : "secondary"}>{copy.title}</Button>
      }
    >
      <div className="harvest-action-dialog">
        {operation === "rotate" && state.status === "idle" ? (
          <div className="setup-form-grid">
            <TextField
              autoComplete="off"
              hint="This operator gets the first safe opportunity to act."
              label="Preferred operator address"
              onChange={(event) => setPreferredAddress(event.target.value)}
              required
              value={preferredAddress}
            />
            <TextField
              autoComplete="off"
              hint="This operator may take over only after the waiting period."
              label="Backup operator address"
              onChange={(event) => setBackupAddress(event.target.value)}
              required
              value={backupAddress}
            />
          </div>
        ) : null}
        {(operation === "sweep" || operation === "close") &&
        job.payoutLockHash !== job.ownerLockHash &&
        state.status === "idle" ? (
          <TextField
            autoComplete="off"
            hint="Enter the payout address saved when this automation was created."
            label="Payout address"
            onChange={(event) => setPayoutAddress(event.target.value)}
            required
            value={payoutAddress}
          />
        ) : null}
        {state.status === "idle" ? (
          <Button
            disabled={
              (operation === "rotate" && (!preferredAddress.trim() || !backupAddress.trim())) ||
              ((operation === "sweep" || operation === "close") &&
                job.payoutLockHash !== job.ownerLockHash &&
                !payoutAddress.trim())
            }
            onClick={() => void prepare()}
          >
            {copy.button}
          </Button>
        ) : null}
        {state.status === "loading" || state.status === "submitting" ? (
          <div aria-live="polite" className="harvest-action-dialog__loading">
            <LoaderCircle className="setup-review-loading__icon" size={18} />
            <p>
              {state.status === "loading"
                ? "Checking live chain data..."
                : "Waiting for your wallet..."}
            </p>
          </div>
        ) : null}
        {state.status === "error" ? (
          <InlineNotice title="Action unavailable" tone="danger">
            <p>{state.message}</p>
            <Button onClick={() => setState({ status: "idle" })} tone="secondary">
              Start again
            </Button>
          </InlineNotice>
        ) : null}
        {state.status === "ready" ? (
          <>
            <InlineNotice title="Transaction checked" tone="success">
              <p>
                The original amount, payout address, service charges, and wallet changes match your
                review.
              </p>
            </InlineNotice>
            <dl>
              <div>
                <dt>Maximum network fee</dt>
                <dd>{harvestV2Amount(state.value.build.review.maximumNetworkFee)}</dd>
              </div>
              <div>
                <dt>Recoverable reserve</dt>
                <dd>{harvestV2Amount(state.value.build.review.recoverableReserve)}</dd>
              </div>
            </dl>
            <Button icon={<ShieldCheck size={17} />} onClick={() => void submit(state.value)}>
              Approve in wallet
            </Button>
          </>
        ) : null}
        {state.status === "submitted" ? (
          <InlineNotice title="Submitted" tone="success">
            <p>The owner action is confirming on CKB testnet.</p>
            <a
              href={ckbTestnetTransactionUrl(state.transactionHash)}
              rel="noreferrer"
              target="_blank"
            >
              Open transaction <ExternalLink size={14} />
            </a>
          </InlineNotice>
        ) : null}
      </div>
    </Dialog>
  );
}

export function DaoHarvestV2Detail({ jobId }: Readonly<{ jobId: string }>) {
  const session = useWalletSession();
  const api = useMemo(() => {
    try {
      return createApiClient({ baseUrl: browserWebEnvironment().apiUrl });
    } catch {
      return undefined;
    }
  }, []);
  const [job, setJob] = useState<ApiDaoHarvestV2>();
  const [state, setState] = useState<"error" | "loading" | "not_found" | "ready">("loading");
  const [retry, setRetry] = useState(0);
  const [title, setTitle] = useState("Harvest compensation");

  useEffect(() => {
    setTitle(readAutomationTitles(window.localStorage)[jobId] ?? "Harvest compensation");
  }, [jobId]);
  useEffect(() => {
    if (!api) {
      setState("error");
      return;
    }
    let active = true;
    setState("loading");
    void api
      .getDaoHarvestV2(jobId)
      .then((value) => {
        if (!active) return;
        setJob(value);
        setState("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setState(reason instanceof ApiClientError && reason.status === 404 ? "not_found" : "error");
      });
    return () => {
      active = false;
    };
  }, [api, jobId, retry]);

  if (state === "loading") {
    return (
      <section
        aria-busy="true"
        aria-label="Loading harvest automation"
        className="app-page harvest-detail"
      >
        <div className="harvest-detail__skeleton">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  }
  if (state === "not_found") {
    return (
      <section className="app-page">
        <InlineNotice title="Automation not found" tone="warning">
          <p>This harvest automation is not available on CKB testnet.</p>
          <Link href="/automations">Return to automations</Link>
        </InlineNotice>
      </section>
    );
  }
  if (state === "error" || !job || !api) {
    return (
      <section className="app-page">
        <InlineNotice title="Something went wrong" tone="danger">
          <p>Please try again.</p>
          <Button
            icon={<RefreshCw size={16} />}
            onClick={() => setRetry((value) => value + 1)}
            tone="secondary"
          >
            Try again
          </Button>
        </InlineNotice>
      </section>
    );
  }

  const presentation = daoHarvestV2Presentation(job);
  const owner = session.status === "ready" && session.ownerLockHash === job.ownerLockHash;
  const actions = harvestV2OwnerActions(job);
  const reserve =
    job.compensation.cellAmount === null || job.compensation.availableToWithdraw === null
      ? null
      : (
          BigInt(job.compensation.cellAmount) - BigInt(job.compensation.availableToWithdraw)
        ).toString();
  return (
    <article aria-labelledby="harvest-v2-title" className="app-page harvest-detail">
      <header className="app-page-header harvest-detail__header">
        <div className="app-page-header__copy">
          <p className="setup-flow__eyebrow">DAO harvest</p>
          <h1 id="harvest-v2-title">{title}</h1>
          <p>{presentation.action}</p>
        </div>
        <span
          className={`ui-status ui-status--${presentation.status === "recovery" ? "danger" : presentation.status === "completed" ? "neutral" : "info"}`}
        >
          {presentation.statusLabel}
        </span>
      </header>

      {job.evidence.completeness === "partial" ? (
        <InlineNotice title="Some activity is still loading" tone="warning">
          <p>
            The protected amount is confirmed. Service payment details will appear after the
            remaining chain inputs are indexed.
          </p>
        </InlineNotice>
      ) : null}

      <section
        aria-label="Harvest summary"
        className="harvest-detail__summary harvest-detail__summary--four"
      >
        <div>
          <span className="harvest-dashboard__icon">
            <Landmark size={18} />
          </span>
          <div>
            <small>Original amount</small>
            <strong>{harvestV2Amount(job.protectedAmount)}</strong>
          </div>
        </div>
        <div>
          <small>Earned compensation</small>
          <strong>{harvestV2Amount(job.compensation.availableToWithdraw)}</strong>
        </div>
        <div>
          <small>Progress</small>
          <strong>
            {presentation.completedCycles} of {presentation.totalCycles} harvests
          </strong>
        </div>
        <div>
          <small>Recoverable reserve</small>
          <strong>{harvestV2Amount(reserve)}</strong>
        </div>
      </section>

      <section className="harvest-detail__section">
        <h2>How execution works</h2>
        <ol className="harvest-timeline">
          <li data-complete="true">
            <CheckCircle2 size={17} />
            <div>
              <strong>Your original amount stays protected</strong>
              <span>Service charges and network fees cannot be taken from it.</span>
            </div>
          </li>
          <li data-current="true">
            <LoaderCircle size={17} />
            <div>
              <strong>Preferred operator acts first</strong>
              <span>
                The selected operator gets the first safe opportunity to start or complete the
                harvest.
              </span>
            </div>
          </li>
          <li>
            <ShieldCheck size={17} />
            <div>
              <strong>A backup can take over later</strong>
              <span>
                If the preferred operator does not act, an approved backup or compatible operator
                can continue after the waiting period.
              </span>
            </div>
          </li>
        </ol>
      </section>

      <section className="harvest-detail__section">
        <h2>Charges and activity</h2>
        <dl className="harvest-v2-values">
          <div>
            <dt>Latest activity</dt>
            <dd>{harvestV2Operation(job.serviceSettlement.lastOperation)}</dd>
          </div>
          <div>
            <dt>Prepare service charge paid</dt>
            <dd>{harvestV2Amount(job.serviceSettlement.preparePaid)}</dd>
          </div>
          <div>
            <dt>Completion service charge paid</dt>
            <dd>{harvestV2Amount(job.serviceSettlement.claimPaid)}</dd>
          </div>
          <div>
            <dt>Latest transaction</dt>
            <dd>
              <a
                href={ckbTestnetTransactionUrl(job.evidence.transactionHash)}
                rel="noreferrer"
                target="_blank"
              >
                View on explorer <ExternalLink size={14} />
              </a>
            </dd>
          </div>
        </dl>
        <p>
          Service charges are paid only for completed work. The submitting operator provides the
          network fee.
        </p>
      </section>

      {owner && actions.length > 0 ? (
        <section className="harvest-detail__section">
          <h2>Owner actions</h2>
          <p>Only the connected owner wallet can approve these actions.</p>
          <div className="harvest-detail__actions">
            {actions.map((operation) => (
              <HarvestV2OwnerAction api={api} job={job} key={operation} operation={operation} />
            ))}
          </div>
        </section>
      ) : null}
    </article>
  );
}
