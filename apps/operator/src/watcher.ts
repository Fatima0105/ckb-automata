import { AutomataMetrics } from "@ckb-automata/telemetry";
import { parseHash32, parseOutputIndex, type Hash32 } from "@ckb-automata/core";

import type { LoadedAutomationManifest } from "./automation-manifest.ts";
import type { OperatorConfiguration } from "./config.ts";
import {
  discoverHarvestV2Jobs,
  discoverPaymentJobs,
  type DiscoveredHarvestV2Job,
  type DiscoveredPaymentJob,
} from "./discovery.ts";
import type { LoadedOperatorManifest } from "./manifest.ts";
import { buildPaymentExecutionBundle } from "./payment-workflow.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { confirmTransaction, submitFallbackClaim, submitPaymentExecution } from "./transaction.ts";
import { buildFallbackClaimBundle } from "./workflow.ts";

type WatcherJob =
  | (DiscoveredPaymentJob & { readonly service: "deadline" | "recurring" })
  | (DiscoveredHarvestV2Job & { readonly service: "dao-harvest" });

interface PendingAttempt {
  readonly jobKey: string;
  readonly service: WatcherJob["service"];
  readonly transactionHash: Hash32;
  readonly submittedAt: number;
}

interface RetryState {
  readonly attempts: number;
  readonly retryAt: number;
}

export interface OperatorWatcherSnapshot {
  readonly status: "disabled" | "starting" | "running" | "stopping" | "stopped";
  readonly scanRunning: boolean;
  readonly lastScanStartedAt: string | null;
  readonly lastScanCompletedAt: string | null;
  readonly lastSuccessfulScanAt: string | null;
  readonly lastError: string | null;
  readonly discoveredJobs: number;
  readonly eligibleJobs: number;
  readonly pendingTransactions: number;
  readonly submittedTransactions: number;
  readonly confirmedTransactions: number;
  readonly failedAttempts: number;
}

export interface OperatorWatcher {
  start(): Promise<void>;
  runOnce(): Promise<void>;
  close(): Promise<void>;
  snapshot(): OperatorWatcherSnapshot;
}

export interface OperatorWatcherDependencies {
  readonly now?: () => number;
  readonly discover?: () => Promise<readonly WatcherJob[]>;
  readonly execute?: (job: WatcherJob) => Promise<Hash32>;
  readonly confirm?: (transactionHash: Hash32) => Promise<string>;
  readonly log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
  readonly metrics?: AutomataMetrics;
}

function jobKey(job: WatcherJob): string {
  return `${job.service}:${job.jobId}:${job.sequence}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "unknown watcher failure";
}

function watcherServices(config: OperatorConfiguration): ReadonlySet<string> {
  return new Set(config.operatorServices ?? ["deadline", "recurring"]);
}

export function createOperatorWatcher(
  options: {
    readonly config: OperatorConfiguration;
    readonly rpc: JsonRpcClient;
    readonly indexer: JsonRpcClient;
    readonly manifest?: LoadedOperatorManifest;
    readonly automationManifest?: LoadedAutomationManifest;
  },
  dependencies: OperatorWatcherDependencies = {},
): OperatorWatcher {
  const now = dependencies.now ?? Date.now;
  const metrics = dependencies.metrics ?? new AutomataMetrics();
  const services = watcherServices(options.config);
  const attempts = new Map<string, PendingAttempt>();
  const retries = new Map<string, RetryState>();
  const settled = new Set<string>();
  const reportedConfirmationTimeouts = new Set<Hash32>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopping = false;
  let status: OperatorWatcherSnapshot["status"] = options.config.watcherEnabled
    ? "starting"
    : "disabled";
  let lastScanStartedAt: string | null = null;
  let lastScanCompletedAt: string | null = null;
  let lastSuccessfulScanAt: string | null = null;
  let lastError: string | null = null;
  let discoveredJobs = 0;
  let eligibleJobs = 0;
  let submittedTransactions = 0;
  let confirmedTransactions = 0;
  let failedAttempts = 0;

  const log = (event: string, fields: Readonly<Record<string, unknown>> = {}) => {
    dependencies.log?.(event, fields);
  };

  const discover =
    dependencies.discover ??
    (async (): Promise<readonly WatcherJob[]> => {
      const limit = options.config.watcherMaximumJobsPerScan;
      const jobs: WatcherJob[] = [];
      if (
        options.automationManifest !== undefined &&
        (services.has("deadline") || services.has("recurring"))
      ) {
        const payments = await discoverPaymentJobs(
          options.automationManifest,
          options.indexer,
          "all",
          limit,
        );
        for (const job of payments) {
          const service = job.kind === "scheduled" ? "deadline" : "recurring";
          if (services.has(service)) jobs.push(Object.freeze({ ...job, service }));
        }
      }
      if (options.manifest !== undefined && services.has("dao-harvest")) {
        const harvest = await discoverHarvestV2Jobs(
          options.manifest.manifest,
          options.indexer,
          limit,
        );
        for (const job of harvest) jobs.push(Object.freeze({ ...job, service: "dao-harvest" }));
      }
      return Object.freeze(jobs.slice(0, limit));
    });

  const execute =
    dependencies.execute ??
    (async (job: WatcherJob): Promise<Hash32> => {
      if (job.service === "dao-harvest") {
        if (options.manifest === undefined) throw new Error("Harvest manifest is unavailable");
        const bundle = await buildFallbackClaimBundle(
          Object.freeze({
            txHash: job.outPoint.txHash,
            index: parseOutputIndex(job.outPoint.index),
          }),
          options.manifest,
          options.config,
          options.rpc,
          options.indexer,
        );
        return (await submitFallbackClaim(bundle, options.manifest, options.config, options.rpc))
          .transactionHash;
      }
      if (options.automationManifest === undefined) {
        throw new Error("payment manifest is unavailable");
      }
      const bundle = await buildPaymentExecutionBundle(
        Object.freeze({
          txHash: job.outPoint.txHash,
          index: parseOutputIndex(job.outPoint.index),
        }),
        options.automationManifest,
        options.config,
        options.rpc,
        options.indexer,
      );
      if (
        (job.service === "deadline" && bundle.operation !== "scheduled_payment") ||
        (job.service === "recurring" && bundle.operation !== "recurring_payment")
      ) {
        throw new Error("discovered payment kind changed before submission");
      }
      return (
        await submitPaymentExecution(
          bundle,
          options.automationManifest,
          options.config,
          options.rpc,
        )
      ).transactionHash;
    });

  const confirm =
    dependencies.confirm ??
    (async (transactionHash: Hash32): Promise<string> =>
      (await confirmTransaction(transactionHash, options.config.confirmationDepth, options.rpc))
        .status);

  const backoff = (key: string) => {
    const previous = retries.get(key)?.attempts ?? 0;
    const attemptsCount = previous + 1;
    const exponential = options.config.watcherRetryBaseMs * 2 ** Math.min(attemptsCount - 1, 20);
    retries.set(
      key,
      Object.freeze({
        attempts: attemptsCount,
        retryAt: now() + Math.min(exponential, options.config.watcherRetryMaximumMs),
      }),
    );
  };

  const reconcile = async () => {
    for (const [key, attempt] of attempts) {
      try {
        const confirmation = await confirm(attempt.transactionHash);
        if (confirmation === "confirmed") {
          attempts.delete(key);
          retries.delete(key);
          settled.add(key);
          reportedConfirmationTimeouts.delete(attempt.transactionHash);
          confirmedTransactions += 1;
          metrics.attemptsTotal.inc({ policy: attempt.service, outcome: "confirmed" });
          log("operator.watcher.confirmed", { ...attempt });
          continue;
        }
        if (confirmation === "rejected") {
          attempts.delete(key);
          backoff(key);
          reportedConfirmationTimeouts.delete(attempt.transactionHash);
          failedAttempts += 1;
          metrics.attemptsTotal.inc({ policy: attempt.service, outcome: "rejected" });
          log("operator.watcher.rejected", { ...attempt });
          continue;
        }
        if (
          now() - attempt.submittedAt >= options.config.watcherConfirmationTimeoutMs &&
          !reportedConfirmationTimeouts.has(attempt.transactionHash)
        ) {
          reportedConfirmationTimeouts.add(attempt.transactionHash);
          failedAttempts += 1;
          metrics.attemptsTotal.inc({ policy: attempt.service, outcome: "confirmation_timeout" });
          log("operator.watcher.confirmation_timeout", { ...attempt });
        }
      } catch (error) {
        metrics.rpcErrorsTotal.inc({ endpoint: "rpc", method: "confirm_transaction" });
        log("operator.watcher.confirmation_failed", {
          transactionHash: attempt.transactionHash,
          reason: message(error),
        });
      }
    }
  };

  const scan = async () => {
    if (stopping || !options.config.watcherEnabled) return;
    lastScanStartedAt = new Date(now()).toISOString();
    lastError = null;
    try {
      await reconcile();
      const jobs = await discover();
      const discoveredKeys = new Set(jobs.map(jobKey));
      for (const key of settled) {
        if (!discoveredKeys.has(key)) settled.delete(key);
      }
      discoveredJobs = jobs.length;
      metrics.jobsLiveTotal.set(jobs.length);
      let ready = 0;
      for (const job of jobs) {
        if (stopping) break;
        if (attempts.size > 0) break;
        const key = jobKey(job);
        if (attempts.has(key) || settled.has(key)) continue;
        const retry = retries.get(key);
        if (retry !== undefined && retry.retryAt > now()) continue;
        ready += 1;
        try {
          const transactionHash = parseHash32(await execute(job));
          attempts.set(
            key,
            Object.freeze({
              jobKey: key,
              service: job.service,
              transactionHash,
              submittedAt: now(),
            }),
          );
          retries.delete(key);
          submittedTransactions += 1;
          metrics.attemptsTotal.inc({ policy: job.service, outcome: "submitted" });
          log("operator.watcher.submitted", { jobKey: key, transactionHash });
          break;
        } catch (error) {
          backoff(key);
          failedAttempts += 1;
          metrics.attemptsTotal.inc({ policy: job.service, outcome: "deferred" });
          log("operator.watcher.deferred", { jobKey: key, reason: message(error) });
        }
      }
      eligibleJobs = ready;
      metrics.jobsReadyTotal.set(ready);
      lastSuccessfulScanAt = new Date(now()).toISOString();
    } catch (error) {
      lastError = message(error);
      metrics.rpcErrorsTotal.inc({ endpoint: "indexer", method: "watcher_scan" });
      log("operator.watcher.scan_failed", { reason: lastError });
    } finally {
      lastScanCompletedAt = new Date(now()).toISOString();
    }
  };

  const runOnce = async () => {
    if (running !== undefined) return running;
    running = scan().finally(() => {
      running = undefined;
    });
    return running;
  };

  const schedule = () => {
    if (stopping || !options.config.watcherEnabled) return;
    timer = setTimeout(() => {
      void runOnce().finally(schedule);
    }, options.config.watcherPollIntervalMs);
    timer.unref();
  };

  return Object.freeze({
    async start() {
      if (!options.config.watcherEnabled || status === "running") return;
      if (!options.config.privateKey)
        throw new Error("OPERATOR_PRIVATE_KEY is required for watcher");
      status = "running";
      await runOnce();
      schedule();
    },
    runOnce,
    async close() {
      if (status === "disabled" || status === "stopped") return;
      stopping = true;
      status = "stopping";
      if (timer !== undefined) clearTimeout(timer);
      if (running !== undefined) await running;
      status = "stopped";
    },
    snapshot() {
      return Object.freeze({
        status,
        scanRunning: running !== undefined,
        lastScanStartedAt,
        lastScanCompletedAt,
        lastSuccessfulScanAt,
        lastError,
        discoveredJobs,
        eligibleJobs,
        pendingTransactions: attempts.size,
        submittedTransactions,
        confirmedTransactions,
        failedAttempts,
      });
    },
  });
}
