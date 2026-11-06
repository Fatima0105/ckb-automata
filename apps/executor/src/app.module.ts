import { BullModule, getQueueToken } from "@nestjs/bullmq";
import { Module, type DynamicModule, type Provider } from "@nestjs/common";
import type { Queue } from "bullmq";

import { createCkbClient, type CkbClient } from "@ckb-automata/ccc";
import type { AutomataEnvironment } from "@ckb-automata/config";
import { deploymentRegistry, parseShannons } from "@ckb-automata/core";

import { ExecutorAdapterRegistry, type RegisteredExecutorAdapter } from "./adapter.ts";
import { ChainBuildSnapshotSource } from "./build-snapshot.ts";
import { PostgresBuildAttemptStore } from "./build-store.ts";
import { BuildCoordinator } from "./build-worker.ts";
import { PostgresConfirmationStore } from "./confirmation-store.ts";
import { ConfirmationCoordinator } from "./confirmation-worker.ts";
import { ConfirmationService } from "./confirmation.ts";
import { PostgresDeadLetterStore } from "./dead-letter-store.ts";
import { DeadLetterCoordinator } from "./dead-letter-worker.ts";
import { DaoHarvestV2RuntimeCoordinator } from "./dao-harvest-v2-runtime.ts";
import { EligibilityCoordinator, PostgresEligibilityJobSource } from "./eligibility-worker.ts";
import { DEADLINE_EXECUTOR_ADAPTER } from "./policies/deadline.ts";
import { DAO_HARVEST_EXECUTOR_ADAPTER } from "./policies/dao-harvest.ts";
import { RECURRING_EXECUTOR_ADAPTER } from "./policies/recurring.ts";
import { DurableQueueRegistry, queueRegistrationOptions, queueRootOptions } from "./queues.ts";
import { ExecutorReceiptSigner } from "./receipt.ts";
import {
  ExecutorRuntime,
  type ExecutorChainClient,
  type ExecutorEventLogger,
  type ExecutorQueueReadiness,
} from "./runtime.ts";
import { SimulationGateService } from "./simulation.ts";
import { PostgresSimulationStore } from "./simulation-store.ts";
import { SimulationCoordinator } from "./simulation-worker.ts";
import { operatorLockArgs } from "./signing.ts";
import { loadOperatorAutomationDeployment } from "./operator-automation-manifest.ts";
import { PostgresSubmissionStore } from "./submission-store.ts";
import { SubmissionService } from "./submission.ts";

export const EXECUTOR_ADAPTERS = Symbol("EXECUTOR_ADAPTERS");
export const EXECUTOR_ENVIRONMENT = Symbol("EXECUTOR_ENVIRONMENT");
export const EXECUTOR_LOGGER = Symbol("EXECUTOR_LOGGER");
export const EXECUTOR_QUEUES = Symbol("EXECUTOR_QUEUES");

const DEFAULT_ADAPTERS = Object.freeze([
  DEADLINE_EXECUTOR_ADAPTER,
  RECURRING_EXECUTOR_ADAPTER,
  DAO_HARVEST_EXECUTOR_ADAPTER,
] satisfies readonly RegisteredExecutorAdapter[]);

function configuredAdapters(
  environment: AutomataEnvironment,
): readonly RegisteredExecutorAdapter[] {
  const supported = new Set(
    (environment.EXECUTOR_SUPPORTED_POLICIES ?? "deadline,recurring,dao-harvest").split(","),
  );
  return Object.freeze(
    DEFAULT_ADAPTERS.filter((adapter) => supported.has(adapter.registration.policy)),
  );
}

// Nest uses the class identity as the root dependency-injection module token.
// oxlint-disable-next-line typescript/no-extraneous-class
export class ExecutorModule {}

Module({})(ExecutorModule);

export interface ExecutorModuleDependencies {
  readonly adapters?: readonly RegisteredExecutorAdapter[];
  readonly createChainClient?: (environment: AutomataEnvironment) => ExecutorChainClient;
  readonly enableDeadLetterWorkers?: boolean;
  readonly enableDaoHarvestV2Runtime?: boolean;
  readonly enableBuildWorkers?: boolean;
  readonly enableConfirmationWorkers?: boolean;
  readonly enableEligibilityWorkers?: boolean;
  readonly enableSimulationWorkers?: boolean;
  readonly logger: ExecutorEventLogger;
  readonly queuePrefix?: string;
  readonly queues?: ExecutorQueueReadiness;
}

export function createExecutorModule(
  environment: AutomataEnvironment,
  dependencies: ExecutorModuleDependencies,
): DynamicModule {
  const adapters = Object.freeze([...(dependencies.adapters ?? configuredAdapters(environment))]);
  const registrations = queueRegistrationOptions();
  const imports =
    dependencies.queues === undefined
      ? [
          BullModule.forRoot(queueRootOptions(environment.REDIS_URL, dependencies.queuePrefix)),
          BullModule.registerQueue(...registrations),
        ]
      : [];
  const queueProviders: Provider[] =
    dependencies.queues === undefined
      ? [
          {
            provide: DurableQueueRegistry,
            inject: registrations.map(({ name }) => getQueueToken(name)),
            useFactory: (...queues: Queue[]) => new DurableQueueRegistry(queues),
          },
          { provide: EXECUTOR_QUEUES, useExisting: DurableQueueRegistry },
        ]
      : [{ provide: EXECUTOR_QUEUES, useValue: dependencies.queues }];
  const eligibilityProviders: Provider[] =
    dependencies.enableEligibilityWorkers === false
      ? []
      : [
          {
            provide: EligibilityCoordinator,
            inject: [
              EXECUTOR_ENVIRONMENT,
              ExecutorRuntime,
              ExecutorAdapterRegistry,
              DurableQueueRegistry,
              EXECUTOR_LOGGER,
            ],
            useFactory: (
              configured: AutomataEnvironment,
              runtime: ExecutorRuntime,
              registry: ExecutorAdapterRegistry,
              queues: DurableQueueRegistry,
              logger: ExecutorEventLogger,
            ) =>
              new EligibilityCoordinator({
                environment: configured,
                runtime,
                registry,
                queues,
                source: new PostgresEligibilityJobSource(
                  configured.DATABASE_URL,
                  configured.CKB_NETWORK,
                ),
                logger,
                ...(dependencies.queuePrefix === undefined
                  ? {}
                  : { prefix: dependencies.queuePrefix }),
              }),
          },
        ];
  const hasBuildConfiguration =
    environment.EXECUTOR_LOCK_ARGS !== undefined &&
    environment.EXECUTOR_TRANSACTION_FEE !== undefined;
  if (
    (environment.EXECUTOR_LOCK_ARGS === undefined) !==
    (environment.EXECUTOR_TRANSACTION_FEE === undefined)
  ) {
    throw new Error("executor lock args and transaction fee must be configured together");
  }
  if (dependencies.enableBuildWorkers === true && !hasBuildConfiguration) {
    throw new Error("transaction build worker configuration is required");
  }
  const buildProviders: Provider[] =
    dependencies.enableBuildWorkers === false || !hasBuildConfiguration
      ? []
      : [
          {
            provide: BuildCoordinator,
            inject: [
              EXECUTOR_ENVIRONMENT,
              ExecutorRuntime,
              ExecutorAdapterRegistry,
              DurableQueueRegistry,
              EXECUTOR_LOGGER,
            ],
            useFactory: async (
              configured: AutomataEnvironment,
              runtime: ExecutorRuntime,
              registry: ExecutorAdapterRegistry,
              queues: DurableQueueRegistry,
              logger: ExecutorEventLogger,
            ) => {
              const loaded = await deploymentRegistry.load(configured.CKB_GENESIS_HASH);
              if (loaded.status !== "ok") {
                throw new Error("executor deployment is unavailable for transaction building");
              }
              const lockArgs = configured.EXECUTOR_LOCK_ARGS;
              const transactionFee = configured.EXECUTOR_TRANSACTION_FEE;
              if (lockArgs === undefined || transactionFee === undefined) {
                throw new Error("transaction build worker configuration is unavailable");
              }
              const secp = loaded.deployment.manifest.secp256k1Blake160;
              const rewardLock = Object.freeze({
                codeHash: secp.codeHash,
                hashType: secp.hashType,
                args: lockArgs as `0x${string}`,
              });
              const store = new PostgresBuildAttemptStore(
                configured.DATABASE_URL,
                configured.CKB_NETWORK,
              );
              return new BuildCoordinator({
                runtime,
                queues,
                registry,
                identity: Object.freeze({
                  rewardLock,
                  transactionFee: parseShannons(transactionFee),
                }),
                source: new ChainBuildSnapshotSource({
                  deployment: loaded.deployment,
                  runtime,
                  rewardLock,
                  resolutions: store,
                  loadOperatorDeployment: async () => {
                    const path = configured.OPERATOR_AUTOMATION_MANIFEST_PATH;
                    return path === undefined
                      ? undefined
                      : loadOperatorAutomationDeployment(
                          path,
                          runtime,
                          configured.CKB_GENESIS_HASH,
                        );
                  },
                }),
                store,
                redisUrl: configured.REDIS_URL,
                logger,
                ...(dependencies.queuePrefix === undefined
                  ? {}
                  : { prefix: dependencies.queuePrefix }),
              });
            },
          },
        ];
  const simulationValues = [
    environment.EXECUTOR_FEE_PRIVATE_KEY,
    environment.EXECUTOR_MAX_CYCLES,
    environment.EXECUTOR_MIN_MARGIN,
  ];
  const hasSimulationConfiguration = hasBuildConfiguration && simulationValues.every(Boolean);
  if (simulationValues.some(Boolean) && !hasSimulationConfiguration) {
    throw new Error("complete executor simulation configuration is required");
  }
  if (dependencies.enableSimulationWorkers === true && !hasSimulationConfiguration) {
    throw new Error("executor simulation worker configuration is required");
  }
  const simulationProviders: Provider[] =
    dependencies.enableSimulationWorkers === false || !hasSimulationConfiguration
      ? []
      : [
          {
            provide: SimulationCoordinator,
            inject: [EXECUTOR_ENVIRONMENT, ExecutorRuntime, DurableQueueRegistry, EXECUTOR_LOGGER],
            useFactory: async (
              configured: AutomataEnvironment,
              runtime: ExecutorRuntime,
              queues: DurableQueueRegistry,
              logger: ExecutorEventLogger,
            ) => {
              const loaded = await deploymentRegistry.load(configured.CKB_GENESIS_HASH);
              if (loaded.status !== "ok") {
                throw new Error("executor deployment is unavailable for simulation");
              }
              const lockArgs = configured.EXECUTOR_LOCK_ARGS;
              const transactionFee = configured.EXECUTOR_TRANSACTION_FEE;
              const privateKey = configured.EXECUTOR_FEE_PRIVATE_KEY;
              const maxCycles = configured.EXECUTOR_MAX_CYCLES;
              const minimumMargin = configured.EXECUTOR_MIN_MARGIN;
              if (
                lockArgs === undefined ||
                transactionFee === undefined ||
                privateKey === undefined ||
                maxCycles === undefined ||
                minimumMargin === undefined
              ) {
                throw new Error("executor simulation worker configuration is unavailable");
              }
              const secp = loaded.deployment.manifest.secp256k1Blake160;
              const rewardLock = Object.freeze({
                codeHash: secp.codeHash,
                hashType: secp.hashType,
                args: lockArgs as `0x${string}`,
              });
              if (operatorLockArgs(privateKey) !== rewardLock.args) {
                throw new Error("operator private key does not match the configured reward lock");
              }
              const store = new PostgresSimulationStore(configured.DATABASE_URL);
              const submissionStore = new PostgresSubmissionStore(configured.DATABASE_URL);
              return new SimulationCoordinator({
                runtime,
                queues,
                store,
                service: new SimulationGateService({
                  store,
                  chain: {
                    dryRun: (transaction) => runtime.dryRun(transaction as never),
                  },
                  rewardLock,
                  privateKey,
                  transactionFee: parseShannons(transactionFee),
                  maxCycles: BigInt(maxCycles),
                  minimumMargin: parseShannons(minimumMargin),
                }),
                submission: new SubmissionService({
                  store: submissionStore,
                  chain: {
                    send: (transaction) => runtime.send(transaction as never),
                    getTransactionStatus: (transactionHash) =>
                      runtime.getTransactionStatus(transactionHash),
                  },
                  privateKey,
                }),
                submissionStore,
                redisUrl: configured.REDIS_URL,
                logger,
                ...(dependencies.queuePrefix === undefined
                  ? {}
                  : { prefix: dependencies.queuePrefix }),
              });
            },
          },
        ];
  const supportsDaoHarvestV2 = new Set(
    (environment.EXECUTOR_SUPPORTED_POLICIES ?? "").split(","),
  ).has("dao-harvest-v2");
  const hasDaoHarvestV2Configuration =
    supportsDaoHarvestV2 &&
    environment.DAO_HARVEST_V2_MANIFEST_PATH !== undefined &&
    hasSimulationConfiguration;
  if (dependencies.enableDaoHarvestV2Runtime === true && !hasDaoHarvestV2Configuration) {
    throw new Error("DAO harvest V2 runtime configuration is required");
  }
  const daoHarvestV2Providers: Provider[] =
    dependencies.enableDaoHarvestV2Runtime === false || !hasDaoHarvestV2Configuration
      ? []
      : [
          {
            provide: DaoHarvestV2RuntimeCoordinator,
            inject: [EXECUTOR_ENVIRONMENT, ExecutorRuntime, EXECUTOR_LOGGER],
            useFactory: async (
              configured: AutomataEnvironment,
              runtime: ExecutorRuntime,
              logger: ExecutorEventLogger,
            ) => {
              const loaded = await deploymentRegistry.load(configured.CKB_GENESIS_HASH);
              if (loaded.status !== "ok") {
                throw new Error("executor deployment is unavailable for V2 signing identity");
              }
              const privateKey = configured.EXECUTOR_FEE_PRIVATE_KEY;
              const lockArgs = configured.EXECUTOR_LOCK_ARGS;
              const transactionFee = configured.EXECUTOR_TRANSACTION_FEE;
              const minimumMargin = configured.EXECUTOR_MIN_MARGIN;
              const maximumCycles = configured.EXECUTOR_MAX_CYCLES;
              const manifestPath = configured.DAO_HARVEST_V2_MANIFEST_PATH;
              if (
                privateKey === undefined ||
                lockArgs === undefined ||
                transactionFee === undefined ||
                minimumMargin === undefined ||
                maximumCycles === undefined ||
                manifestPath === undefined
              ) {
                throw new Error("DAO harvest V2 runtime configuration is unavailable");
              }
              const secp = loaded.deployment.manifest.secp256k1Blake160;
              const ownerLock = Object.freeze({
                codeHash: secp.codeHash,
                hashType: secp.hashType,
                args: lockArgs as `0x${string}`,
              });
              if (operatorLockArgs(privateKey) !== ownerLock.args) {
                throw new Error("operator private key does not match the V2 owner lock");
              }
              return new DaoHarvestV2RuntimeCoordinator({
                runtime,
                logger,
                databaseUrl: configured.DATABASE_URL,
                network: configured.CKB_NETWORK,
                manifestPath,
                privateKey,
                ownerLock,
                transactionFee: parseShannons(transactionFee),
                minimumMargin: parseShannons(minimumMargin),
                maximumCycles: BigInt(maximumCycles),
              });
            },
          },
        ];
  const confirmationProviders: Provider[] =
    dependencies.enableConfirmationWorkers !== true
      ? []
      : [
          {
            provide: ConfirmationCoordinator,
            inject: [ExecutorRuntime, DurableQueueRegistry, EXECUTOR_LOGGER],
            useFactory: async (
              runtime: ExecutorRuntime,
              queues: DurableQueueRegistry,
              logger: ExecutorEventLogger,
            ) => {
              const privateKey = environment.EXECUTOR_FEE_PRIVATE_KEY;
              const lockArgs = environment.EXECUTOR_LOCK_ARGS;
              if (privateKey === undefined || lockArgs === undefined) {
                throw new Error("confirmation receipt signing configuration is unavailable");
              }
              const loaded = await deploymentRegistry.load(environment.CKB_GENESIS_HASH);
              if (loaded.status !== "ok") {
                throw new Error("executor deployment is unavailable for receipt signing");
              }
              const secp = loaded.deployment.manifest.secp256k1Blake160;
              const executorLock = Object.freeze({
                codeHash: secp.codeHash,
                hashType: secp.hashType,
                args: lockArgs as `0x${string}`,
              });
              const store = new PostgresConfirmationStore(
                environment.DATABASE_URL,
                environment.CKB_NETWORK,
              );
              return new ConfirmationCoordinator({
                runtime,
                queues,
                store,
                service: new ConfirmationService({
                  store,
                  chain: {
                    getTransactionStatus: (transactionHash) =>
                      runtime.getTransactionStatus(transactionHash),
                  },
                  receipts: new ExecutorReceiptSigner({
                    network: environment.CKB_NETWORK,
                    privateKey,
                    executorLock,
                    version: environment.RELEASE_VERSION ?? "0.0.0",
                    revision: environment.RELEASE_REVISION ?? "unversioned",
                  }),
                  recovery: {
                    async requeue(attempt) {
                      await queues.enqueue(
                        "evaluate",
                        "evaluate-job",
                        `${attempt.jobId}/${attempt.sequence}/reorg-${attempt.attemptId}`,
                        Object.freeze({
                          jobId: attempt.jobId,
                          sequence: attempt.sequence,
                          wakeSequence: 0,
                        }),
                      );
                    },
                  },
                }),
                redisUrl: environment.REDIS_URL,
                logger,
                ...(dependencies.queuePrefix === undefined
                  ? {}
                  : { prefix: dependencies.queuePrefix }),
              });
            },
          },
        ];
  const deadLetterProviders: Provider[] =
    dependencies.enableDeadLetterWorkers === false || dependencies.queues !== undefined
      ? []
      : [
          {
            provide: DeadLetterCoordinator,
            inject: [ExecutorRuntime, EXECUTOR_LOGGER],
            useFactory: (runtime: ExecutorRuntime, logger: ExecutorEventLogger) =>
              new DeadLetterCoordinator({
                runtime,
                store: new PostgresDeadLetterStore(environment.DATABASE_URL),
                redisUrl: environment.REDIS_URL,
                logger,
                ...(dependencies.queuePrefix === undefined
                  ? {}
                  : { prefix: dependencies.queuePrefix }),
              }),
          },
        ];
  return {
    module: ExecutorModule,
    imports,
    providers: [
      { provide: EXECUTOR_ENVIRONMENT, useValue: environment },
      { provide: EXECUTOR_ADAPTERS, useValue: adapters },
      { provide: EXECUTOR_LOGGER, useValue: dependencies.logger },
      ...queueProviders,
      {
        provide: ExecutorAdapterRegistry,
        inject: [EXECUTOR_ADAPTERS],
        useFactory: (registered: readonly RegisteredExecutorAdapter[]) =>
          new ExecutorAdapterRegistry(registered),
      },
      {
        provide: ExecutorRuntime,
        inject: [
          EXECUTOR_ENVIRONMENT,
          EXECUTOR_ADAPTERS,
          EXECUTOR_LOGGER,
          EXECUTOR_QUEUES,
          ExecutorAdapterRegistry,
        ],
        useFactory: (
          configured: AutomataEnvironment,
          registered: readonly RegisteredExecutorAdapter[],
          logger: ExecutorEventLogger,
          queues: ExecutorQueueReadiness,
          registry: ExecutorAdapterRegistry,
        ) => {
          const chain =
            dependencies.createChainClient?.(configured) ??
            (createCkbClient({
              rpcEndpoints: [configured.CKB_RPC_URL],
              indexerEndpoints: [configured.CKB_INDEXER_URL],
            }) satisfies CkbClient);
          return new ExecutorRuntime({
            environment: configured,
            chain,
            queues,
            registry,
            adapterIds: [
              ...registered.map((adapter) => adapter.registration.id),
              ...(hasDaoHarvestV2Configuration ? ["dao-harvest-v2"] : []),
            ],
            logger,
          });
        },
      },
      ...eligibilityProviders,
      ...buildProviders,
      ...simulationProviders,
      ...daoHarvestV2Providers,
      ...confirmationProviders,
      ...deadLetterProviders,
    ],
    exports: [ExecutorAdapterRegistry, ExecutorRuntime, EXECUTOR_QUEUES],
  };
}
