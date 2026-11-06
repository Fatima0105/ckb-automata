import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { PERSONAL, blake2b, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import {
  parseHash32,
  type CellDepIdentity,
  type DaoHarvestV2TransitionDeployment,
  type Hash32,
} from "@ckb-automata/core";

import type { ExecutorRuntime } from "./runtime.ts";

const SHA256 = /^[0-9a-f]{64}$/;
const PREDECESSOR = /^dao-harvest-v2-testnet-v[0-9]+\.[0-9]+\.[0-9]+\.json$/;

interface SystemScript {
  readonly codeHash: Hash32;
  readonly hashType: "type";
  readonly cellDep: CellDepIdentity;
}

interface AuditedContract {
  readonly codeHash: Hash32;
  readonly hashType: "data1";
  readonly cellDep: CellDepIdentity;
  readonly binarySha256: string;
  readonly sizeBytes: number;
}

export interface DaoHarvestV2ExecutorManifest {
  readonly schemaVersion: 2;
  readonly releaseVersion: string;
  readonly network: "ckb_testnet";
  readonly genesisHash: Hash32;
  readonly sourceRevision: string;
  readonly predecessorManifests: readonly string[];
  readonly secp256k1Blake160: SystemScript;
  readonly nervosDao: SystemScript;
  readonly contracts: {
    readonly jobLock: AuditedContract;
    readonly policy: AuditedContract;
    readonly vaultLock: AuditedContract;
    readonly compensationLock: AuditedContract;
  };
  readonly operators: {
    readonly preferredPrepareLockHash: Hash32;
    readonly fallbackPrepareLockHashes: readonly Hash32[];
  };
}

export interface VerifiedDaoHarvestV2ExecutorDeployment {
  readonly manifest: DaoHarvestV2ExecutorManifest;
  readonly manifestSha256: string;
  readonly transition: DaoHarvestV2TransitionDeployment;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function dependency(value: unknown, name: string): CellDepIdentity {
  const item = object(value, name);
  const point = object(item["outPoint"], `${name}.outPoint`);
  const depType = item["depType"];
  if (depType !== "code" && depType !== "depGroup") {
    throw new TypeError(`${name}.depType is invalid`);
  }
  const index = text(point["index"], `${name}.outPoint.index`);
  if (!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(index)) {
    throw new TypeError(`${name}.outPoint.index is invalid`);
  }
  return Object.freeze({
    outPoint: Object.freeze({
      txHash: parseHash32(text(point["txHash"], `${name}.outPoint.txHash`)),
      index: index as `0x${string}`,
    }),
    depType,
  });
}

function systemScript(value: unknown, name: string): SystemScript {
  const item = object(value, name);
  if (item["hashType"] !== "type") throw new TypeError(`${name}.hashType is invalid`);
  return Object.freeze({
    codeHash: parseHash32(text(item["codeHash"], `${name}.codeHash`)),
    hashType: "type" as const,
    cellDep: dependency(item["cellDep"], `${name}.cellDep`),
  });
}

function contract(value: unknown, name: string): AuditedContract {
  const item = object(value, name);
  const binarySha256 = text(item["binarySha256"], `${name}.binarySha256`);
  const sizeBytes = item["sizeBytes"];
  if (item["hashType"] !== "data1" || !SHA256.test(binarySha256)) {
    throw new TypeError(`${name} audit metadata is invalid`);
  }
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 1) {
    throw new TypeError(`${name}.sizeBytes is invalid`);
  }
  const cellDep = dependency(item["cellDep"], `${name}.cellDep`);
  if (cellDep.depType !== "code") throw new TypeError(`${name}.cellDep must be code`);
  return Object.freeze({
    codeHash: parseHash32(text(item["codeHash"], `${name}.codeHash`)),
    hashType: "data1" as const,
    cellDep,
    binarySha256,
    sizeBytes: Number(sizeBytes),
  });
}

export function parseDaoHarvestV2ExecutorManifest(value: unknown): DaoHarvestV2ExecutorManifest {
  const item = object(value, "DAO harvest V2 manifest");
  if (item["schemaVersion"] !== 2 || item["network"] !== "ckb_testnet") {
    throw new TypeError("DAO harvest V2 manifest must target CKB testnet schema 2");
  }
  const releaseVersion = text(item["releaseVersion"], "releaseVersion");
  const sourceRevision = text(item["sourceRevision"], "sourceRevision");
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(releaseVersion)) {
    throw new TypeError("releaseVersion must be semantic");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new TypeError("sourceRevision must be a full Git revision");
  }
  const predecessorManifests = item["predecessorManifests"] ?? [];
  if (
    !Array.isArray(predecessorManifests) ||
    predecessorManifests.length > 8 ||
    predecessorManifests.some((entry) => typeof entry !== "string" || !PREDECESSOR.test(entry)) ||
    new Set(predecessorManifests).size !== predecessorManifests.length
  ) {
    throw new TypeError("predecessorManifests are invalid");
  }
  const contracts = object(item["contracts"], "contracts");
  const operators = object(item["operators"], "operators");
  const fallback = operators["fallbackPrepareLockHashes"];
  if (!Array.isArray(fallback) || fallback.length < 1 || fallback.length > 8) {
    throw new TypeError("fallbackPrepareLockHashes must contain 1 to 8 identities");
  }
  const fallbackHashes = fallback.map((entry, index) =>
    parseHash32(text(entry, `fallbackPrepareLockHashes[${index}]`)),
  );
  if (new Set(fallbackHashes).size !== fallbackHashes.length) {
    throw new TypeError("fallbackPrepareLockHashes must be unique");
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    releaseVersion,
    network: "ckb_testnet" as const,
    genesisHash: parseHash32(text(item["genesisHash"], "genesisHash")),
    sourceRevision,
    predecessorManifests: Object.freeze(predecessorManifests as string[]),
    secp256k1Blake160: systemScript(item["secp256k1Blake160"], "secp256k1Blake160"),
    nervosDao: systemScript(item["nervosDao"], "nervosDao"),
    contracts: Object.freeze({
      jobLock: contract(contracts["jobLock"], "contracts.jobLock"),
      policy: contract(contracts["policy"], "contracts.policy"),
      vaultLock: contract(contracts["vaultLock"], "contracts.vaultLock"),
      compensationLock: contract(contracts["compensationLock"], "contracts.compensationLock"),
    }),
    operators: Object.freeze({
      preferredPrepareLockHash: parseHash32(
        text(operators["preferredPrepareLockHash"], "preferredPrepareLockHash"),
      ),
      fallbackPrepareLockHashes: Object.freeze(fallbackHashes),
    }),
  });
}

function ckbDataHash(bytes: Uint8Array): Hash32 {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(bytes);
  return parseHash32(`0x${hasher.digest("hex")}`);
}

async function loadOne(
  path: string,
  runtime: ExecutorRuntime,
  expectedGenesisHash: string,
): Promise<VerifiedDaoHarvestV2ExecutorDeployment> {
  const bytes = await readFile(path);
  const manifest = parseDaoHarvestV2ExecutorManifest(JSON.parse(bytes.toString("utf8")));
  const expected = parseHash32(expectedGenesisHash);
  if (manifest.genesisHash !== expected) {
    throw new Error("DAO harvest V2 manifest does not match the configured chain genesis");
  }
  for (const [name, deployed] of Object.entries(manifest.contracts)) {
    const live = await runtime.getCellLive(deployed.cellDep.outPoint);
    if (!live) throw new Error(`${name} V2 code cell is not live`);
    const contractBytes = hexToBytes(live.outputData.toString());
    const digest = createHash("sha256").update(contractBytes).digest("hex");
    if (
      contractBytes.length !== deployed.sizeBytes ||
      digest !== deployed.binarySha256 ||
      ckbDataHash(contractBytes) !== deployed.codeHash
    ) {
      throw new Error(`${name} V2 code cell does not match the audited manifest`);
    }
  }
  return Object.freeze({
    manifest,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    transition: Object.freeze({
      secp256k1Blake160: manifest.secp256k1Blake160,
      nervosDao: manifest.nervosDao,
      contracts: Object.freeze({
        jobLock: manifest.contracts.jobLock,
        policy: manifest.contracts.policy,
        vaultLock: manifest.contracts.vaultLock,
        compensationLock: manifest.contracts.compensationLock,
      }),
    }),
  });
}

export async function loadVerifiedDaoHarvestV2ExecutorDeployments(
  path: string,
  runtime: ExecutorRuntime,
  expectedGenesisHash: string,
): Promise<readonly VerifiedDaoHarvestV2ExecutorDeployment[]> {
  const active = await loadOne(path, runtime, expectedGenesisHash);
  const predecessors = await Promise.all(
    active.manifest.predecessorManifests.map((filename) =>
      loadOne(resolve(dirname(path), filename), runtime, expectedGenesisHash),
    ),
  );
  const deployments = [active, ...predecessors];
  const jobLocks = deployments.map(({ manifest }) => manifest.contracts.jobLock.codeHash);
  if (new Set(jobLocks).size !== jobLocks.length) {
    throw new Error("DAO harvest V2 deployment revisions must have unique Job Lock code hashes");
  }
  return Object.freeze(deployments);
}
