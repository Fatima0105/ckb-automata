#!/usr/bin/env node
import { parseArgs } from "node:util";

import { parseHash32, parseOutputIndex } from "@ckb-automata/core";

import { parseOperatorConfiguration, publicOperatorConfiguration } from "./config.ts";
import { discoverHarvestV2Jobs } from "./discovery.ts";
import { discoverPaymentJobs } from "./discovery.ts";
import { loadAutomationManifest, verifyAutomationManifest } from "./automation-manifest.ts";
import { loadOperatorManifest, verifyOperatorManifest } from "./manifest.ts";
import { PublicJsonRpcClient } from "./rpc.ts";
import { startOperatorServer } from "./server.ts";
import { registerHostedOperator } from "./registration.ts";
import {
  confirmTransaction,
  dryRunFallbackClaim,
  loadExecutionBundle,
  submitFallbackClaim,
  dryRunPaymentExecution,
  submitPaymentExecution,
} from "./transaction.ts";
import {
  buildFallbackClaimBundle,
  provisionOperatorAccumulator,
  writeExecutionBundle,
} from "./workflow.ts";
import { buildPaymentExecutionBundle, writePaymentExecutionBundle } from "./payment-workflow.ts";
import { OPERATOR_PACKAGE_VERSION } from "./version.ts";

const PACKAGE_VERSION = OPERATOR_PACKAGE_VERSION;

function jobOutPoint(value: string | undefined) {
  if (!value) throw new Error("--job-out-point is required");
  const separator = value.lastIndexOf(":");
  if (separator < 1) throw new Error("--job-out-point must be <transaction-hash>:<output-index>");
  return Object.freeze({
    txHash: parseHash32(value.slice(0, separator)),
    index: parseOutputIndex(value.slice(separator + 1)),
  });
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function guide() {
  return Object.freeze({
    version: PACKAGE_VERSION,
    funding: [
      "Use a separate testnet key for operator fees.",
      "Fund enough live CKB cells for identity, claim payment accumulation, and the bounded network fee.",
      "The dry-run refuses a claim when its service payment does not cover the configured minimum margin.",
    ],
    commands: [
      "config",
      "verify-manifest",
      "discover",
      "setup (Harvest operator accumulator)",
      "build --kind harvest|scheduled|recurring --job-out-point <hash:index> --output <file>",
      "dry-run --bundle <file>",
      "submit --bundle <file>",
      "confirm --tx-hash <hash>",
      "serve",
      "register (publish this hosted operator to CKAutomata)",
    ],
    shutdown: [
      "Stop accepting new work before shutdown.",
      "Wait for an already-broadcast transaction to become committed or rejected.",
      "Press Ctrl+C once; the health server closes before the process exits.",
      "Never delete the bundle or transaction hash while confirmation is pending.",
    ],
  });
}

export async function runOperatorCli(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const parsed = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      bundle: { type: "string" },
      output: { type: "string" },
      "job-out-point": { type: "string" },
      "tx-hash": { type: "string" },
      kind: { type: "string", default: "all" },
      limit: { type: "string", default: "100" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (parsed.values.version) {
    output({ version: PACKAGE_VERSION });
    return 0;
  }
  const command = parsed.positionals[0] ?? "guide";
  if (command === "guide") {
    output(guide());
    return 0;
  }
  const config = parseOperatorConfiguration(environment);
  if (command === "config") {
    output(publicOperatorConfiguration(config));
    return 0;
  }
  const loaded =
    config.manifestPath === undefined ? undefined : await loadOperatorManifest(config.manifestPath);
  if (
    loaded &&
    loaded.manifest.releaseVersion !== "0.2.0" &&
    loaded.manifest.releaseVersion !== PACKAGE_VERSION
  ) {
    throw new Error(
      `operator ${PACKAGE_VERSION} cannot use manifest ${loaded.manifest.releaseVersion}`,
    );
  }
  const rpc = new PublicJsonRpcClient(config.rpcUrl);
  const indexer = new PublicJsonRpcClient(config.indexerUrl);
  const kind = parsed.values.kind;
  if (kind !== "all" && kind !== "harvest" && kind !== "scheduled" && kind !== "recurring") {
    throw new Error("--kind must be all, harvest, scheduled, or recurring");
  }
  const automation =
    config.automationManifestPath === undefined
      ? undefined
      : await loadAutomationManifest(config.automationManifestPath);
  if (command === "verify-manifest") {
    output({
      ...(loaded === undefined
        ? {}
        : { harvest: await verifyOperatorManifest(loaded, rpc, config.expectedGenesisHash) }),
      ...(automation === undefined
        ? {}
        : {
            payments: await verifyAutomationManifest(automation, rpc, config.expectedGenesisHash),
          }),
    });
    return 0;
  }
  if (command === "register") {
    if (loaded === undefined && automation === undefined) {
      throw new Error("a Harvest or payment manifest is required to register an operator");
    }
    if (loaded !== undefined) {
      await verifyOperatorManifest(loaded, rpc, config.expectedGenesisHash);
    }
    if (automation !== undefined) {
      await verifyAutomationManifest(automation, rpc, config.expectedGenesisHash);
    }
    output(await registerHostedOperator(config, loaded));
    return 0;
  }
  if (command === "discover") {
    const limit = Number(parsed.values.limit);
    output({
      manifests: { harvest: loaded?.sha256 ?? null, payments: automation?.sha256 ?? null },
      jobs: Object.freeze([
        ...(kind === "all" || kind === "harvest"
          ? loaded === undefined
            ? kind === "all"
              ? []
              : (() => {
                  throw new Error("OPERATOR_MANIFEST_PATH is required for Harvest");
                })()
            : await discoverHarvestV2Jobs(loaded.manifest, indexer, limit)
          : []),
        ...(kind === "harvest"
          ? []
          : automation === undefined
            ? kind === "all"
              ? []
              : (() => {
                  throw new Error("OPERATOR_AUTOMATION_MANIFEST_PATH is required for payments");
                })()
            : await discoverPaymentJobs(automation, indexer, kind, limit)),
      ]),
    });
    return 0;
  }
  if (command === "setup") {
    if (loaded === undefined) throw new Error("OPERATOR_MANIFEST_PATH is required for Harvest");
    await verifyOperatorManifest(loaded, rpc, config.expectedGenesisHash);
    output(await provisionOperatorAccumulator(loaded, config, rpc, indexer));
    return 0;
  }
  if (command === "build") {
    if (!parsed.values.output) throw new Error("--output is required");
    if (kind === "all") throw new Error("build requires --kind harvest, scheduled, or recurring");
    if (kind === "harvest") {
      if (loaded === undefined) throw new Error("OPERATOR_MANIFEST_PATH is required for Harvest");
      await verifyOperatorManifest(loaded, rpc, config.expectedGenesisHash);
      const bundle = await buildFallbackClaimBundle(
        jobOutPoint(parsed.values["job-out-point"]),
        loaded,
        config,
        rpc,
        indexer,
      );
      output(await writeExecutionBundle(parsed.values.output, bundle));
    } else {
      if (automation === undefined) {
        throw new Error("OPERATOR_AUTOMATION_MANIFEST_PATH is required for payments");
      }
      await verifyAutomationManifest(automation, rpc, config.expectedGenesisHash);
      const bundle = await buildPaymentExecutionBundle(
        jobOutPoint(parsed.values["job-out-point"]),
        automation,
        config,
        rpc,
        indexer,
      );
      if (bundle.operation !== `${kind}_payment`) {
        throw new Error(`job is not a ${kind} payment`);
      }
      output(await writePaymentExecutionBundle(parsed.values.output, bundle));
    }
    return 0;
  }
  if (command === "dry-run" || command === "submit") {
    if (!parsed.values.bundle) throw new Error("--bundle is required");
    const bundle = await loadExecutionBundle(parsed.values.bundle);
    if (bundle.operation === "fallback_claim") {
      if (loaded === undefined) throw new Error("OPERATOR_MANIFEST_PATH is required for Harvest");
      output(
        command === "dry-run"
          ? await dryRunFallbackClaim(bundle, loaded, config, rpc)
          : await submitFallbackClaim(bundle, loaded, config, rpc),
      );
    } else {
      if (automation === undefined) {
        throw new Error("OPERATOR_AUTOMATION_MANIFEST_PATH is required for payments");
      }
      output(
        command === "dry-run"
          ? await dryRunPaymentExecution(bundle, automation, config, rpc)
          : await submitPaymentExecution(bundle, automation, config, rpc),
      );
    }
    return 0;
  }
  if (command === "confirm") {
    if (!parsed.values["tx-hash"]) throw new Error("--tx-hash is required");
    output(
      await confirmTransaction(
        parseHash32(parsed.values["tx-hash"]),
        config.confirmationDepth,
        rpc,
      ),
    );
    return 0;
  }
  if (command === "serve") {
    const server = await startOperatorServer({
      config,
      ...(loaded === undefined ? {} : { manifest: loaded }),
      ...(automation === undefined ? {} : { automationManifest: automation }),
      rpc,
    });
    output({ status: "ready", port: server.port, version: PACKAGE_VERSION });
    await new Promise<void>((resolve) => {
      const stop = () => void server.close().then(resolve);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }
  throw new Error(`unknown command: ${command}`);
}

runOperatorCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "operator command failed"}\n`);
    process.exitCode = 1;
  },
);
