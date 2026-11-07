import { createServer, type Server } from "node:http";

import { Address, Script } from "@ckb-ccc/shell";
import { AutomataMetrics } from "@ckb-automata/telemetry";

import type { OperatorConfiguration } from "./config.ts";
import type { LoadedOperatorManifest } from "./manifest.ts";
import { verifyOperatorManifest } from "./manifest.ts";
import type { LoadedAutomationManifest } from "./automation-manifest.ts";
import { verifyAutomationManifest } from "./automation-manifest.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { operatorIdentityLock } from "./registration.ts";
import { OPERATOR_PACKAGE_VERSION } from "./version.ts";

export interface OperatorServer {
  readonly port: number;
  close(): Promise<void>;
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

export async function startOperatorServer(options: {
  readonly config: OperatorConfiguration;
  readonly manifest?: LoadedOperatorManifest;
  readonly automationManifest?: LoadedAutomationManifest;
  readonly rpc: JsonRpcClient;
}): Promise<OperatorServer> {
  const metrics = new AutomataMetrics();
  let ready = false;
  let lastError: string | null = null;
  const refresh = async () => {
    try {
      if (options.manifest === undefined && options.automationManifest === undefined) {
        throw new Error("no operator manifest is configured");
      }
      await Promise.all([
        ...(options.manifest === undefined
          ? []
          : [
              verifyOperatorManifest(
                options.manifest,
                options.rpc,
                options.config.expectedGenesisHash,
              ),
            ]),
        ...(options.automationManifest === undefined
          ? []
          : [
              verifyAutomationManifest(
                options.automationManifest,
                options.rpc,
                options.config.expectedGenesisHash,
              ),
            ]),
      ]);
      ready = true;
      lastError = null;
    } catch (error) {
      ready = false;
      lastError = error instanceof Error ? error.message : "verification failed";
      metrics.rpcErrorsTotal.inc({ endpoint: "rpc", method: "verify_manifest" });
    }
  };
  await refresh();
  const interval = setInterval(() => void refresh(), 60_000);
  interval.unref();
  const server = createServer(async (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "method_not_allowed" }));
      return;
    }
    if (request.url === "/health/live") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ status: "ok", service: "ckb-automata-operator" }));
      return;
    }
    if (request.url === "/health/ready") {
      response.writeHead(ready ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(
        JSON.stringify({
          status: ready ? "ready" : "not_ready",
          manifests: {
            harvest: options.manifest?.sha256 ?? null,
            payments: options.automationManifest?.sha256 ?? null,
          },
          lastError,
        }),
      );
      return;
    }
    if (request.url === "/operator-info") {
      const privateKey = options.config.privateKey;
      const name = options.config.operatorName;
      const genesisHash = options.config.expectedGenesisHash;
      if (!ready || !privateKey || !name || !genesisHash) {
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ status: "not_ready" }));
        return;
      }
      const lock = Script.from(operatorIdentityLock(privateKey, options.manifest));
      const compatible = new Set([
        ...(options.manifest === undefined ? [] : (["dao-harvest"] as const)),
        ...(options.automationManifest === undefined ? [] : (["deadline", "recurring"] as const)),
      ]);
      const services =
        options.config.operatorServices ??
        (options.automationManifest === undefined ? [] : (["deadline", "recurring"] as const));
      if (services.length === 0 || services.some((service) => !compatible.has(service))) {
        response.writeHead(503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ status: "not_ready" }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(
        JSON.stringify({
          status: "ready",
          name,
          version: OPERATOR_PACKAGE_VERSION,
          network: "ckb_testnet",
          genesisHash,
          identity: {
            lockHash: lock.hash(),
            address: new Address(lock, "ckt").toString(),
            lock: {
              codeHash: lock.codeHash,
              hashType: lock.hashType,
              args: lock.args,
            },
          },
          services,
          manifests: {
            harvest: options.manifest?.sha256 ?? null,
            payments: options.automationManifest?.sha256 ?? null,
          },
        }),
      );
      return;
    }
    if (request.url === "/metrics") {
      response.writeHead(200, {
        "content-type": metrics.contentType(),
        "cache-control": "no-store",
      });
      response.end(await metrics.render());
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "not_found" }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.config.healthPort, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    clearInterval(interval);
    await close(server);
    throw new Error("operator health server did not bind a TCP port");
  }
  let closed = false;
  return Object.freeze({
    port: address.port,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      await close(server);
    },
  });
}
