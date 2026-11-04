#!/usr/bin/env node
import { parseArgs } from "node:util";

import { parseHash32 } from "@ckb-automata/core";

import { parseOperatorConfiguration, publicOperatorConfiguration } from "./config.ts";
import { discoverHarvestV2Jobs } from "./discovery.ts";
import { loadOperatorManifest, verifyOperatorManifest } from "./manifest.ts";
import { PublicJsonRpcClient } from "./rpc.ts";
import { startOperatorServer } from "./server.ts";
import {
  confirmTransaction,
  dryRunFallbackClaim,
  loadExecutionBundle,
  submitFallbackClaim,
} from "./transaction.ts";

const PACKAGE_VERSION = "0.1.0";

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
      "dry-run --bundle <file>",
      "submit --bundle <file>",
      "confirm --tx-hash <hash>",
      "serve",
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
      "tx-hash": { type: "string" },
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
  const loaded = await loadOperatorManifest(config.manifestPath);
  if (loaded.manifest.releaseVersion !== PACKAGE_VERSION) {
    throw new Error(
      `operator ${PACKAGE_VERSION} cannot use manifest ${loaded.manifest.releaseVersion}`,
    );
  }
  const rpc = new PublicJsonRpcClient(config.rpcUrl);
  const indexer = new PublicJsonRpcClient(config.indexerUrl);
  if (command === "verify-manifest") {
    output(await verifyOperatorManifest(loaded, rpc, config.expectedGenesisHash));
    return 0;
  }
  if (command === "discover") {
    const limit = Number(parsed.values.limit);
    output({
      manifestSha256: loaded.sha256,
      jobs: await discoverHarvestV2Jobs(loaded.manifest, indexer, limit),
    });
    return 0;
  }
  if (command === "dry-run" || command === "submit") {
    if (!parsed.values.bundle) throw new Error("--bundle is required");
    const bundle = await loadExecutionBundle(parsed.values.bundle);
    output(
      command === "dry-run"
        ? await dryRunFallbackClaim(bundle, loaded, config, rpc)
        : await submitFallbackClaim(bundle, loaded, config, rpc),
    );
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
    const server = await startOperatorServer({ config, manifest: loaded, rpc });
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
