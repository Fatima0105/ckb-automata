import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PERSONAL, blake2b, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, type CellDepIdentity, type Hash32 } from "@ckb-automata/core";

import type { JsonRpcClient } from "./rpc.ts";
import { record, string } from "./rpc.ts";

const HASH = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export interface OperatorManifestContract {
  readonly codeHash: Hash32;
  readonly hashType: "data1";
  readonly binarySha256: string;
  readonly sizeBytes: number;
  readonly cellDep: CellDepIdentity & { readonly depType: "code" };
}

interface OperatorSystemScript {
  readonly codeHash: Hash32;
  readonly hashType: "type";
  readonly cellDep: CellDepIdentity;
}

export interface OperatorManifest {
  readonly schemaVersion: 2;
  readonly releaseVersion: string;
  readonly network: "ckb_testnet";
  readonly genesisHash: Hash32;
  readonly sourceRevision: string;
  readonly predecessorManifests: readonly string[];
  readonly secp256k1Blake160: OperatorSystemScript;
  readonly nervosDao: OperatorSystemScript;
  readonly contracts: {
    readonly jobLock: OperatorManifestContract;
    readonly policy: OperatorManifestContract;
    readonly vaultLock: OperatorManifestContract;
    readonly compensationLock: OperatorManifestContract;
  };
  readonly operators: {
    readonly preferredPrepareLockHash: Hash32;
    readonly fallbackPrepareLockHashes: readonly Hash32[];
  };
}

export interface LoadedOperatorManifest {
  readonly manifest: OperatorManifest;
  readonly sha256: string;
}

function hash(value: unknown, name: string): string {
  const parsed = string(value, name);
  if (!HASH.test(parsed)) throw new TypeError(`${name} must be a lowercase 32-byte hash`);
  return parsed;
}

function dependency(value: unknown, name: string): CellDepIdentity {
  const parsed = record(value, name);
  const outPoint = record(parsed["outPoint"], `${name}.outPoint`);
  const depType = parsed["depType"];
  const index = string(outPoint["index"], `${name}.outPoint.index`);
  if (depType !== "code" && depType !== "depGroup") {
    throw new TypeError(`${name}.depType is invalid`);
  }
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(index)) {
    throw new TypeError(`${name}.outPoint.index is invalid`);
  }
  return Object.freeze({
    depType,
    outPoint: Object.freeze({
      txHash: parseHash32(hash(outPoint["txHash"], `${name}.outPoint.txHash`)),
      index: index as `0x${string}`,
    }),
  });
}

function systemScript(value: unknown, name: string): OperatorSystemScript {
  const parsed = record(value, name);
  if (parsed["hashType"] !== "type") throw new TypeError(`${name}.hashType is invalid`);
  return Object.freeze({
    codeHash: parseHash32(hash(parsed["codeHash"], `${name}.codeHash`)),
    hashType: "type" as const,
    cellDep: dependency(parsed["cellDep"], `${name}.cellDep`),
  });
}

function contract(value: unknown, name: string): OperatorManifestContract {
  const parsed = record(value, name);
  const cellDep = dependency(parsed["cellDep"], `${name}.cellDep`);
  const sizeBytes = parsed["sizeBytes"];
  const binarySha256 = string(parsed["binarySha256"], `${name}.binarySha256`);
  if (!SHA256.test(binarySha256)) throw new TypeError(`${name}.binarySha256 is invalid`);
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 1) {
    throw new TypeError(`${name}.sizeBytes is invalid`);
  }
  if (parsed["hashType"] !== "data1" || cellDep.depType !== "code") {
    throw new TypeError(`${name} must use a data1 code cell`);
  }
  return Object.freeze({
    codeHash: parseHash32(hash(parsed["codeHash"], `${name}.codeHash`)),
    hashType: "data1" as const,
    binarySha256,
    sizeBytes: Number(sizeBytes),
    cellDep: Object.freeze({ ...cellDep, depType: "code" as const }),
  });
}

function parseManifest(value: unknown): OperatorManifest {
  const parsed = record(value, "operator manifest");
  const contracts = record(parsed["contracts"], "operator manifest contracts");
  const operators = record(parsed["operators"], "operator manifest operators");
  if (parsed["schemaVersion"] !== 2 || parsed["network"] !== "ckb_testnet") {
    throw new TypeError("operator manifest must target CKAutomata V2 on CKB testnet");
  }
  const releaseVersion = string(parsed["releaseVersion"], "releaseVersion");
  const sourceRevision = string(parsed["sourceRevision"], "sourceRevision");
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(releaseVersion)) {
    throw new TypeError("releaseVersion must be semantic");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new TypeError("sourceRevision must be a full Git commit");
  }
  const predecessors = parsed["predecessorManifests"] ?? [];
  if (!Array.isArray(predecessors) || predecessors.some((item) => typeof item !== "string")) {
    throw new TypeError("predecessorManifests are invalid");
  }
  const fallback = operators["fallbackPrepareLockHashes"];
  if (!Array.isArray(fallback) || fallback.length < 1 || fallback.length > 8) {
    throw new TypeError("fallbackPrepareLockHashes must contain 1 to 8 hashes");
  }
  const fallbackHashes = fallback.map((item, index) =>
    parseHash32(hash(item, `operators.fallbackPrepareLockHashes[${index}]`)),
  );
  if (new Set(fallbackHashes).size !== fallbackHashes.length) {
    throw new TypeError("fallbackPrepareLockHashes must be unique");
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    releaseVersion,
    network: "ckb_testnet" as const,
    genesisHash: parseHash32(hash(parsed["genesisHash"], "genesisHash")),
    sourceRevision,
    predecessorManifests: Object.freeze([...predecessors] as string[]),
    secp256k1Blake160: systemScript(parsed["secp256k1Blake160"], "secp256k1Blake160"),
    nervosDao: systemScript(parsed["nervosDao"], "nervosDao"),
    contracts: Object.freeze({
      jobLock: contract(contracts["jobLock"], "contracts.jobLock"),
      policy: contract(contracts["policy"], "contracts.policy"),
      vaultLock: contract(contracts["vaultLock"], "contracts.vaultLock"),
      compensationLock: contract(contracts["compensationLock"], "contracts.compensationLock"),
    }),
    operators: Object.freeze({
      preferredPrepareLockHash: parseHash32(
        hash(operators["preferredPrepareLockHash"], "operators.preferredPrepareLockHash"),
      ),
      fallbackPrepareLockHashes: Object.freeze(fallbackHashes),
    }),
  });
}

export async function loadOperatorManifest(path: string): Promise<LoadedOperatorManifest> {
  const bytes = await readFile(path);
  const manifest = parseManifest(JSON.parse(bytes.toString("utf8")) as unknown);
  return Object.freeze({
    manifest,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function ckbHash(bytes: Uint8Array): string {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(bytes);
  return `0x${hasher.digest("hex")}`;
}

export async function verifyOperatorManifest(
  loaded: LoadedOperatorManifest,
  rpc: JsonRpcClient,
  expectedGenesisHash?: string,
) {
  const genesisHash = await rpc.call<string>("get_block_hash", ["0x0"]);
  const expected = expectedGenesisHash ?? loaded.manifest.genesisHash;
  if (genesisHash !== expected || genesisHash !== loaded.manifest.genesisHash) {
    throw new Error("public RPC genesis does not match the operator manifest");
  }
  const verified: { name: string; outPoint: string; binarySha256: string }[] = [];
  for (const [name, item] of Object.entries(loaded.manifest.contracts)) {
    const result = record(
      await rpc.call("get_live_cell", [
        {
          tx_hash: item.cellDep.outPoint.txHash,
          index: item.cellDep.outPoint.index,
        },
        true,
      ]),
      `${name} live cell`,
    );
    if (result["status"] !== "live") throw new Error(`${name} code cell is not live`);
    const cell = record(result["cell"], `${name} cell`);
    const data = record(cell["data"], `${name} cell data`);
    const bytes = hexToBytes(string(data["content"], `${name} cell data content`));
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== item.sizeBytes || digest !== item.binarySha256) {
      throw new Error(`${name} code cell does not match the audited binary`);
    }
    if (ckbHash(bytes) !== item.codeHash) {
      throw new Error(`${name} CKB code hash does not match the manifest`);
    }
    verified.push({
      name,
      outPoint: `${item.cellDep.outPoint.txHash}:${item.cellDep.outPoint.index}`,
      binarySha256: digest,
    });
  }
  return Object.freeze({
    status: "verified" as const,
    releaseVersion: loaded.manifest.releaseVersion,
    manifestSha256: loaded.sha256,
    genesisHash,
    contracts: Object.freeze(verified),
  });
}
