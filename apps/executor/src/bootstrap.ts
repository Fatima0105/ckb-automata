import type { INestApplicationContext, LoggerService } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

import { parseEnvironment, type AutomataEnvironment } from "@ckb-automata/config";
import { CorrelatedLogger, type LogWriter } from "@ckb-automata/telemetry";

import { createExecutorModule, type ExecutorModuleDependencies } from "./app.module.ts";
import { startExecutorHealthServer, type ExecutorHealthServer } from "./health.ts";
import { executorQueuePrefix as queuePrefixForInstance } from "./queues.ts";
import { ExecutorRuntime, type ExecutorEventLogger } from "./runtime.ts";

const SERVICE_NAME = "ckb-automata-executor";
const SERVICE_VERSION = "0.0.0";
type EntryNestModule = Parameters<typeof NestFactory.createApplicationContext>[0];

function configuredSecrets(environment: AutomataEnvironment): readonly string[] {
  return [
    environment.DATABASE_URL,
    environment.REDIS_URL,
    environment.WEBHOOK_ENCRYPTION_KEY,
    environment.EXECUTOR_FEE_PRIVATE_KEY,
    environment.ERROR_TRACKING_DSN,
    environment.OTEL_EXPORTER_OTLP_HEADERS,
  ].filter((value): value is string => value !== undefined && value !== "");
}

export class ExecutorLogger implements LoggerService, ExecutorEventLogger {
  readonly #logger: CorrelatedLogger;

  constructor(environment: AutomataEnvironment, writer?: LogWriter) {
    this.#logger = new CorrelatedLogger({
      configuredSecrets: configuredSecrets(environment),
      release: environment.RELEASE_VERSION ?? SERVICE_VERSION,
      revision: environment.RELEASE_REVISION ?? "unversioned",
      service: SERVICE_NAME,
      ...(writer === undefined ? {} : { writer }),
    });
  }

  log(message: unknown, ...optional: unknown[]): void {
    this.#framework("info", message, optional);
  }

  error(message: unknown, ...optional: unknown[]): void;
  error(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void;
  error(first: unknown, ...optional: unknown[]): void {
    if (
      typeof first === "string" &&
      typeof optional[0] === "string" &&
      /^[a-z][a-z0-9_.-]{0,95}$/.test(first)
    ) {
      this.#logger.error(first, optional[0], optional[1] as Readonly<Record<string, unknown>>);
      return;
    }
    this.#framework("error", first, optional);
  }

  warn(message: unknown, ...optional: unknown[]): void {
    this.#framework("warn", message, optional);
  }

  debug(message: unknown, ...optional: unknown[]): void {
    this.#framework("debug", message, optional);
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    this.#framework("debug", message, optional);
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    this.#framework("fatal", message, optional);
  }

  info(event: string, message: string, fields?: Readonly<Record<string, unknown>>): void {
    this.#logger.info(event, message, fields);
  }

  #framework(
    level: "debug" | "info" | "warn" | "error" | "fatal",
    message: unknown,
    optional: readonly unknown[],
  ): void {
    this.#logger.write(
      level,
      `nestjs.${level}`,
      typeof message === "string" ? message : "framework event",
      optional.length === 0 ? {} : { context: optional },
    );
  }
}

export interface ExecutorBootstrapResult {
  readonly app: INestApplicationContext;
  readonly environment: AutomataEnvironment;
  readonly runtime: ExecutorRuntime;
  readonly healthServer?: ExecutorHealthServer;
}

export interface ExecutorBootstrapDependencies {
  readonly createApplicationContext?: (
    module: EntryNestModule,
    logger: LoggerService,
  ) => Promise<INestApplicationContext>;
  readonly createChainClient?: ExecutorModuleDependencies["createChainClient"];
  readonly enableDeadLetterWorkers?: boolean;
  readonly enableDaoHarvestV2Runtime?: boolean;
  readonly enableBuildWorkers?: boolean;
  readonly enableConfirmationWorkers?: boolean;
  readonly enableEligibilityWorkers?: boolean;
  readonly enableSimulationWorkers?: boolean;
  readonly logger?: ExecutorLogger;
  readonly queuePrefix?: string;
  readonly queues?: ExecutorModuleDependencies["queues"];
  readonly writer?: LogWriter;
}

export function executorQueuePrefix(environment: AutomataEnvironment): string | undefined {
  return queuePrefixForInstance(environment.EXECUTOR_INSTANCE_ID);
}

async function createNestApplicationContext(
  module: EntryNestModule,
  logger: LoggerService,
): Promise<INestApplicationContext> {
  return NestFactory.createApplicationContext(module, {
    abortOnError: true,
    bufferLogs: true,
    logger,
  });
}

export async function createExecutorApplication(
  input: Readonly<Record<string, string | undefined>>,
  dependencies: ExecutorBootstrapDependencies = {},
): Promise<ExecutorBootstrapResult> {
  const environment = parseEnvironment(input);
  const logger = dependencies.logger ?? new ExecutorLogger(environment, dependencies.writer);
  const queuePrefix = dependencies.queuePrefix ?? executorQueuePrefix(environment);
  const module = createExecutorModule(environment, {
    logger,
    ...(dependencies.createChainClient === undefined
      ? {}
      : { createChainClient: dependencies.createChainClient }),
    ...(dependencies.enableDeadLetterWorkers === undefined
      ? {}
      : { enableDeadLetterWorkers: dependencies.enableDeadLetterWorkers }),
    ...(dependencies.enableDaoHarvestV2Runtime === undefined
      ? {}
      : { enableDaoHarvestV2Runtime: dependencies.enableDaoHarvestV2Runtime }),
    ...(dependencies.enableBuildWorkers === undefined
      ? {}
      : { enableBuildWorkers: dependencies.enableBuildWorkers }),
    ...(dependencies.enableConfirmationWorkers === undefined
      ? {}
      : { enableConfirmationWorkers: dependencies.enableConfirmationWorkers }),
    ...(dependencies.enableEligibilityWorkers === undefined
      ? {}
      : { enableEligibilityWorkers: dependencies.enableEligibilityWorkers }),
    ...(dependencies.enableSimulationWorkers === undefined
      ? {}
      : { enableSimulationWorkers: dependencies.enableSimulationWorkers }),
    ...(queuePrefix === undefined ? {} : { queuePrefix }),
    ...(dependencies.queues === undefined ? {} : { queues: dependencies.queues }),
  });
  const app = await (dependencies.createApplicationContext ?? createNestApplicationContext)(
    module,
    logger,
  );
  app.enableShutdownHooks();
  return Object.freeze({
    app,
    environment,
    runtime: app.get(ExecutorRuntime),
  });
}

export async function startExecutor(
  input: Readonly<Record<string, string | undefined>> = process.env,
  dependencies: ExecutorBootstrapDependencies = {},
): Promise<ExecutorBootstrapResult> {
  const result = await createExecutorApplication(input, {
    ...dependencies,
    enableBuildWorkers: dependencies.enableBuildWorkers ?? true,
    enableConfirmationWorkers: dependencies.enableConfirmationWorkers ?? true,
    enableSimulationWorkers: dependencies.enableSimulationWorkers ?? true,
  });
  const rawPort = input["PORT"];
  if (rawPort === undefined) return result;
  if (!/^[1-9][0-9]*$/.test(rawPort) || Number(rawPort) > 65_535) {
    await result.app.close();
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  if (
    result.environment.AUTOMATA_PROFILE === "testnet-public" &&
    result.environment.EXECUTOR_INSTANCE_ID === undefined
  ) {
    await result.app.close();
    throw new Error("public executor instance identity is required");
  }
  try {
    const healthServer = await startExecutorHealthServer(result.runtime, Number(rawPort));
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.once(signal, () => void healthServer.close());
    }
    return Object.freeze({ ...result, healthServer });
  } catch (error) {
    await result.app.close();
    throw error;
  }
}
