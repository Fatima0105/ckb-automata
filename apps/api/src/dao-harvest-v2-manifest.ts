import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PERSONAL, blake2b, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, type CellDepIdentity, type Hash32 } from "@ckb-automata/core";

import type { CkbReadClient } from "./ckb-client.ts";
import type {
  DaoHarvestV2Deployment,
  DaoHarvestV2DeploymentContract,
} from "./dao-harvest-v2-adapter.ts";

const SHA256 = /^[0-9a-f]{64}$/;

interface AuditedContract extends DaoHarvestV2DeploymentContract {
  readonly binarySha256: string;
  readonly sizeBytes: number;
}

export interface DaoHarvestV2DeploymentManifest {
  readonly schemaVersion: 2;
  readonly releaseVersion: string;
  readonly network: "ckb_testnet";
  readonly genesisHash: Hash32;
  readonly sourceRevision: string;
  readonly secp256k1Blake160: DaoHarvestV2Deployment["secp256k1Blake160"];
  readonly nervosDao: DaoHarvestV2Deployment["nervosDao"];
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

export interface VerifiedDaoHarvestV2Deployment {
  readonly deployment: DaoHarvestV2Deployment;
  readonly manifest: DaoHarvestV2DeploymentManifest;
  readonly manifestSha256: string;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function cellDep(value: unknown, name: string): CellDepIdentity {
  const item = record(value, name);
  const outPoint = record(item["outPoint"], `${name}.outPoint`);
  if (item["depType"] !== "code" && item["depType"] !== "depGroup") {
    throw new TypeError(`${name}.depType is invalid`);
  }
  const index = string(outPoint["index"], `${name}.outPoint.index`);
  if (!/^0x[0-9a-f]+$/.test(index)) throw new TypeError(`${name}.outPoint.index is invalid`);
  return Object.freeze({
    outPoint: Object.freeze({
      txHash: parseHash32(string(outPoint["txHash"], `${name}.outPoint.txHash`)),
      index: index as `0x${string}`,
    }),
    depType: item["depType"],
  });
}

function systemScript(
  value: unknown,
  name: string,
  hashType: "type",
): DaoHarvestV2Deployment["nervosDao"] {
  const item = record(value, name);
  if (item["hashType"] !== hashType) throw new TypeError(`${name}.hashType is invalid`);
  return Object.freeze({
    codeHash: parseHash32(string(item["codeHash"], `${name}.codeHash`)),
    hashType,
    cellDep: cellDep(item["cellDep"], `${name}.cellDep`),
  });
}

function contract(value: unknown, name: string): AuditedContract {
  const item = record(value, name);
  const sizeBytes = item["sizeBytes"];
  const binarySha256 = string(item["binarySha256"], `${name}.binarySha256`);
  if (item["hashType"] !== "data1") throw new TypeError(`${name}.hashType must be data1`);
  if (!SHA256.test(binarySha256)) throw new TypeError(`${name}.binarySha256 is invalid`);
  if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 1) {
    throw new TypeError(`${name}.sizeBytes is invalid`);
  }
  const dependency = cellDep(item["cellDep"], `${name}.cellDep`);
  if (dependency.depType !== "code") throw new TypeError(`${name}.cellDep must be a code dep`);
  return Object.freeze({
    codeHash: parseHash32(string(item["codeHash"], `${name}.codeHash`)),
    hashType: "data1" as const,
    cellDep: dependency,
    binarySha256,
    sizeBytes: Number(sizeBytes),
  });
}

export function parseDaoHarvestV2DeploymentManifest(
  value: unknown,
): DaoHarvestV2DeploymentManifest {
  const item = record(value, "DAO harvest V2 manifest");
  if (item["schemaVersion"] !== 2 || item["network"] !== "ckb_testnet") {
    throw new TypeError("DAO harvest V2 manifest must target CKB testnet schema 2");
  }
  const releaseVersion = string(item["releaseVersion"], "releaseVersion");
  const sourceRevision = string(item["sourceRevision"], "sourceRevision");
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(releaseVersion)) {
    throw new TypeError("releaseVersion must be semantic");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new TypeError("sourceRevision must be a full Git revision");
  }
  const contracts = record(item["contracts"], "contracts");
  const operators = record(item["operators"], "operators");
  const fallback = operators["fallbackPrepareLockHashes"];
  if (!Array.isArray(fallback) || fallback.length < 1 || fallback.length > 8) {
    throw new TypeError("fallbackPrepareLockHashes must contain 1 to 8 identities");
  }
  const fallbackHashes = fallback.map((entry, index) =>
    parseHash32(string(entry, `fallbackPrepareLockHashes[${index}]`)),
  );
  if (new Set(fallbackHashes).size !== fallbackHashes.length) {
    throw new TypeError("fallbackPrepareLockHashes must be unique");
  }
  return Object.freeze({
    schemaVersion: 2 as const,
    releaseVersion,
    network: "ckb_testnet" as const,
    genesisHash: parseHash32(string(item["genesisHash"], "genesisHash")),
    sourceRevision,
    secp256k1Blake160: systemScript(item["secp256k1Blake160"], "secp256k1Blake160", "type"),
    nervosDao: systemScript(item["nervosDao"], "nervosDao", "type"),
    contracts: Object.freeze({
      jobLock: contract(contracts["jobLock"], "contracts.jobLock"),
      policy: contract(contracts["policy"], "contracts.policy"),
      vaultLock: contract(contracts["vaultLock"], "contracts.vaultLock"),
      compensationLock: contract(contracts["compensationLock"], "contracts.compensationLock"),
    }),
    operators: Object.freeze({
      preferredPrepareLockHash: parseHash32(
        string(operators["preferredPrepareLockHash"], "preferredPrepareLockHash"),
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

export async function loadVerifiedDaoHarvestV2Deployment(
  path: string,
  chain: Pick<CkbReadClient, "getCellLive" | "getGenesisHash">,
  expectedGenesisHash: string,
): Promise<VerifiedDaoHarvestV2Deployment> {
  const bytes = await readFile(path);
  const manifest = parseDaoHarvestV2DeploymentManifest(JSON.parse(bytes.toString("utf8")));
  const expectedGenesis = parseHash32(expectedGenesisHash);
  const actualGenesis = await chain.getGenesisHash();
  if (manifest.genesisHash !== expectedGenesis || actualGenesis !== expectedGenesis) {
    throw new Error("DAO harvest V2 manifest does not match the configured chain genesis");
  }
  for (const [name, item] of Object.entries(manifest.contracts)) {
    const live = await chain.getCellLive(item.cellDep.outPoint);
    if (!live) throw new Error(`${name} V2 code cell is not live`);
    const contractBytes = hexToBytes(live.outputData.toString());
    const digest = createHash("sha256").update(contractBytes).digest("hex");
    if (
      contractBytes.length !== item.sizeBytes ||
      digest !== item.binarySha256 ||
      ckbDataHash(contractBytes) !== item.codeHash
    ) {
      throw new Error(`${name} V2 code cell does not match the audited manifest`);
    }
  }
  return Object.freeze({
    manifest,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    deployment: Object.freeze({
      genesisHash: manifest.genesisHash,
      secp256k1Blake160: manifest.secp256k1Blake160,
      nervosDao: manifest.nervosDao,
      contracts: manifest.contracts,
      preferredPrepareOperatorLockHash: manifest.operators.preferredPrepareLockHash,
      fallbackPrepareOperatorLockHashes: manifest.operators.fallbackPrepareLockHashes,
    }),
  });
}
