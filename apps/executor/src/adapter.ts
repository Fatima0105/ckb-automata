import {
  inspectJobData,
  type BlockNumber,
  type ErrorKey,
  type Hash32,
  type JobInspectionResult,
  type OutPoint,
  type OperatorAutomationDeployment,
  type PolicyMetadata,
  type RegisteredDeployment,
  type ScriptIdentity,
  type Shannons,
  type UnsignedDeadlineTransaction,
} from "@ckb-automata/core";
import type { TelemetryRuntime } from "@ckb-automata/telemetry";

type Hex = `0x${string}`;

export interface ExecutorCellSnapshot {
  readonly outPoint: OutPoint;
  readonly output: {
    readonly capacity: `0x${string}`;
    readonly lock: ScriptIdentity;
    readonly type: ScriptIdentity | null;
  };
  readonly data: Hex;
  readonly blockHash: Hash32;
  readonly blockNumber: BlockNumber;
}

export interface ExecutorHeaderSnapshot {
  readonly hash: Hash32;
  readonly number: BlockNumber;
  readonly epoch: `0x${string}`;
  readonly timestamp: `0x${string}`;
  readonly dao?: `0x${string}`;
}

export interface ExecutorSnapshot {
  readonly deployment: RegisteredDeployment;
  readonly tip: ExecutorHeaderSnapshot;
  readonly job: ExecutorCellSnapshot;
  readonly applicationCells: readonly ExecutorCellSnapshot[];
  readonly feeCells: readonly ExecutorCellSnapshot[];
  readonly headers: readonly ExecutorHeaderSnapshot[];
  readonly resolvedLocks: readonly ScriptIdentity[];
  readonly payloads: readonly Hex[];
  readonly claims: Readonly<Record<string, unknown>>;
  readonly operatorDeployment?: OperatorAutomationDeployment;
}

export interface ExecutorIdentity {
  readonly rewardLock: ScriptIdentity;
  readonly transactionFee: Shannons;
}

export interface ExecutorContext {
  readonly snapshot: ExecutorSnapshot;
  readonly identity: ExecutorIdentity;
  readonly jobInspection: Extract<JobInspectionResult, { readonly status: "ok" }>;
}

export type ExecutorEligibilityContext = Omit<ExecutorContext, "identity">;

export type EligibilityDecision<Evidence = unknown> =
  | {
      readonly status: "eligible";
      readonly evidence: Evidence;
    }
  | {
      readonly status: "ineligible";
      readonly reason: ErrorKey;
      readonly terminal: boolean;
      readonly evidence: Evidence;
    };

export interface ExecutorBuild {
  readonly transaction: UnsignedDeadlineTransaction;
  readonly summary: Readonly<Record<string, unknown>>;
}

export type BuiltVerification =
  | { readonly status: "valid" }
  | {
      readonly status: "invalid";
      readonly reason: ErrorKey;
      readonly message: string;
    };

export interface ExecutorAdapterRegistration {
  readonly id: string;
  readonly policy: "deadline" | "recurring" | "dao-harvest";
  readonly supports: (policy: PolicyMetadata) => boolean;
  readonly evaluateEligibility: (context: ExecutorEligibilityContext) => EligibilityDecision;
}

export interface ExecutorPolicyAdapter<Inspection = unknown, Evidence = unknown> {
  readonly registration: ExecutorAdapterRegistration;
  readonly inspect: (context: ExecutorContext) => Inspection;
  readonly eligibility: (
    context: ExecutorContext,
    inspection: Inspection,
  ) => EligibilityDecision<Evidence>;
  readonly build: (
    context: ExecutorContext,
    inspection: Inspection,
    eligibility: Extract<EligibilityDecision<Evidence>, { readonly status: "eligible" }>,
  ) => ExecutorBuild | Promise<ExecutorBuild>;
  readonly verifyBuilt: (
    context: ExecutorContext,
    inspection: Inspection,
    eligibility: Extract<EligibilityDecision<Evidence>, { readonly status: "eligible" }>,
    build: ExecutorBuild,
  ) => BuiltVerification | Promise<BuiltVerification>;
}

export interface RegisteredExecutorAdapter {
  readonly registration: ExecutorAdapterRegistration;
  readonly inspect: (context: ExecutorContext) => unknown;
  readonly eligibility: (context: ExecutorContext, inspection: unknown) => EligibilityDecision;
  readonly build: (
    context: ExecutorContext,
    inspection: unknown,
    eligibility: Extract<EligibilityDecision, { readonly status: "eligible" }>,
  ) => ExecutorBuild | Promise<ExecutorBuild>;
  readonly verifyBuilt: (
    context: ExecutorContext,
    inspection: unknown,
    eligibility: Extract<EligibilityDecision, { readonly status: "eligible" }>,
    build: ExecutorBuild,
  ) => BuiltVerification | Promise<BuiltVerification>;
}

export type ExecutorRunResult =
  | {
      readonly status: "ineligible";
      readonly adapterId: string;
      readonly inspection: unknown;
      readonly eligibility: Extract<EligibilityDecision, { readonly status: "ineligible" }>;
    }
  | {
      readonly status: "built";
      readonly adapterId: string;
      readonly inspection: unknown;
      readonly eligibility: Extract<EligibilityDecision, { readonly status: "eligible" }>;
      readonly build: ExecutorBuild;
      readonly verification: { readonly status: "valid" };
    }
  | {
      readonly status: "invalid_build";
      readonly adapterId: string;
      readonly inspection: unknown;
      readonly eligibility: Extract<EligibilityDecision, { readonly status: "eligible" }>;
      readonly build: ExecutorBuild;
      readonly verification: Extract<BuiltVerification, { readonly status: "invalid" }>;
    };

export interface ExecutorEligibilityResult {
  readonly adapterId: string;
  readonly eligibility: EligibilityDecision;
}

export class ExecutorAdapterError extends Error {
  override readonly name = "ExecutorAdapterError";
  readonly code: "INVALID_SNAPSHOT" | "UNSUPPORTED_POLICY" | "DUPLICATE_ADAPTER";

  constructor(
    code: "INVALID_SNAPSHOT" | "UNSUPPORTED_POLICY" | "DUPLICATE_ADAPTER",
    message: string,
  ) {
    super(message);
    this.code = code;
  }
}

function eraseAdapter<Inspection, Evidence>(
  adapter: ExecutorPolicyAdapter<Inspection, Evidence>,
): RegisteredExecutorAdapter {
  return {
    registration: adapter.registration,
    inspect: adapter.inspect,
    eligibility: (context, inspection) => adapter.eligibility(context, inspection as Inspection),
    build: (context, inspection, eligibility) =>
      adapter.build(
        context,
        inspection as Inspection,
        eligibility as Extract<EligibilityDecision<Evidence>, { readonly status: "eligible" }>,
      ),
    verifyBuilt: (context, inspection, eligibility, build) =>
      adapter.verifyBuilt(
        context,
        inspection as Inspection,
        eligibility as Extract<EligibilityDecision<Evidence>, { readonly status: "eligible" }>,
        build,
      ),
  };
}

export function defineExecutorAdapter<Inspection, Evidence>(
  adapter: ExecutorPolicyAdapter<Inspection, Evidence>,
): RegisteredExecutorAdapter {
  return Object.freeze(eraseAdapter(adapter));
}

export class ExecutorAdapterRegistry {
  readonly #adapters: readonly RegisteredExecutorAdapter[];

  constructor(adapters: readonly RegisteredExecutorAdapter[] = []) {
    const registered = [...adapters];
    const ids = new Set<string>();
    for (const adapter of registered) {
      if (ids.has(adapter.registration.id)) {
        throw new ExecutorAdapterError(
          "DUPLICATE_ADAPTER",
          `executor adapter id ${adapter.registration.id} is registered more than once`,
        );
      }
      ids.add(adapter.registration.id);
    }
    this.#adapters = Object.freeze(registered);
  }

  resolve(policy: PolicyMetadata): RegisteredExecutorAdapter {
    const matches = this.#adapters.filter((adapter) => adapter.registration.supports(policy));
    if (matches.length !== 1) {
      throw new ExecutorAdapterError(
        "UNSUPPORTED_POLICY",
        matches.length === 0
          ? "no executor adapter supports the inspected policy"
          : "more than one executor adapter supports the inspected policy",
      );
    }
    return matches[0]!;
  }
}

function createEligibilityContext(snapshot: ExecutorSnapshot): ExecutorEligibilityContext {
  const jobInspection = inspectJobData(snapshot.job.data, {
    manifest: snapshot.deployment.manifest,
    expectedGenesisHash: snapshot.deployment.genesisHash,
    ...(snapshot.job.output.type ? { policyScript: snapshot.job.output.type } : {}),
    ...(snapshot.operatorDeployment === undefined
      ? {}
      : { operatorDeployment: snapshot.operatorDeployment }),
  });
  if (jobInspection.status !== "ok") {
    throw new ExecutorAdapterError(
      "INVALID_SNAPSHOT",
      `executor snapshot contains a job that failed inspection (${jobInspection.status})`,
    );
  }
  return Object.freeze({ snapshot, jobInspection });
}

function createContext(snapshot: ExecutorSnapshot, identity: ExecutorIdentity): ExecutorContext {
  return Object.freeze({ ...createEligibilityContext(snapshot), identity });
}

export function evaluateExecutorEligibility(
  registry: ExecutorAdapterRegistry,
  snapshot: ExecutorSnapshot,
): ExecutorEligibilityResult {
  const context = createEligibilityContext(snapshot);
  const adapter = registry.resolve(context.jobInspection.policy);
  return Object.freeze({
    adapterId: adapter.registration.id,
    eligibility: adapter.registration.evaluateEligibility(context),
  });
}

export async function runExecutorAdapter(
  registry: ExecutorAdapterRegistry,
  snapshot: ExecutorSnapshot,
  identity: ExecutorIdentity,
  instrumentation: { readonly telemetry?: Pick<TelemetryRuntime, "withSpanSync"> } = {},
): Promise<ExecutorRunResult> {
  const run = async (): Promise<ExecutorRunResult> => {
    const context = createContext(snapshot, identity);
    const adapter = registry.resolve(context.jobInspection.policy);
    const inspection = adapter.inspect(context);
    const eligibility = adapter.eligibility(context, inspection);
    if (eligibility.status === "ineligible") {
      return Object.freeze({
        status: "ineligible" as const,
        adapterId: adapter.registration.id,
        inspection,
        eligibility,
      });
    }
    const build = await adapter.build(context, inspection, eligibility);
    const verification = await adapter.verifyBuilt(context, inspection, eligibility, build);
    return verification.status === "valid"
      ? Object.freeze({
          status: "built" as const,
          adapterId: adapter.registration.id,
          inspection,
          eligibility,
          build,
          verification,
        })
      : Object.freeze({
          status: "invalid_build" as const,
          adapterId: adapter.registration.id,
          inspection,
          eligibility,
          build,
          verification,
        });
  };
  return instrumentation.telemetry === undefined
    ? run()
    : instrumentation.telemetry.withSpanSync("executor.adapter.run", {}, run);
}
