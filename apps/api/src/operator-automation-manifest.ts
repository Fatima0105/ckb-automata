import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PERSONAL, blake2b, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import {
  parseHash32,
  type CellDepIdentity,
  type Hash32,
  type OperatorAutomationDeployment,
  type OperatorContractDeployment,
} from "@ckb-automata/core";

import type { CkbReadClient } from "./ckb-client.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export interface OperatorAutomationManifest {
  readonly schemaVersion: 1;
  readonly releaseVersion: string;
  readonly network: "ckb_testnet";
  readonly genesisHash: Hash32;
  readonly sourceRevision: string;
  readonly secp256k1Blake160: OperatorAutomationDeployment["secp256k1Blake160"];
  readonly contracts: {
    readonly jobLock: OperatorContractDeployment;
    readonly deadlinePolicy: OperatorContractDeployment;
    readonly recurringPolicy: OperatorContractDeployment;
  };
  readonly defaultPreferredOperatorLockHash: Hash32;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}

function cellDep(value: unknown, name: string): CellDepIdentity {
  const item = record(value, name);
  const point = record(item["outPoint"], `${name}.outPoint`);
  const depType = item["depType"];
  const index = text(point["index"], `${name}.outPoint.index`);
  if ((depType !== "code" && depType !== "depGroup") || !/^0x[0-9a-f]+$/.test(index)) {
    throw new TypeError(`${name} is invalid`);
  }
  return Object.freeze({
    outPoint: Object.freeze({
      txHash: parseHash32(text(point["txHash"], `${name}.outPoint.txHash`)),
      index: index as `0x${string}`,
    }),
    depType,
  });
}

function contract(value: unknown, name: string): OperatorContractDeployment {
  const item = record(value, name);
  const binarySha256 = text(item["binarySha256"], `${name}.binarySha256`);
  const sizeBytes = item["sizeBytes"];
  if (
    item["hashType"] !== "data1" ||
    !SHA256.test(binarySha256) ||
    !Number.isSafeInteger(sizeBytes) ||
    Number(sizeBytes) < 1
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  const dependency = cellDep(item["cellDep"], `${name}.cellDep`);
  if (dependency.depType !== "code") throw new TypeError(`${name}.cellDep must be a code dep`);
  return Object.freeze({
    script: Object.freeze({
      codeHash: parseHash32(text(item["codeHash"], `${name}.codeHash`)),
      hashType: "data1" as const,
    }),
    cellDep: dependency,
    binarySha256,
    sizeBytes: Number(sizeBytes),
  });
}

export function parseOperatorAutomationManifest(value: unknown): OperatorAutomationManifest {
  const item = record(value, "operator automation manifest");
  if (item["schemaVersion"] !== 1 || item["network"] !== "ckb_testnet") {
    throw new TypeError("operator automation manifest must target CKB testnet schema 1");
  }
  const releaseVersion = text(item["releaseVersion"], "releaseVersion");
  const sourceRevision = text(item["sourceRevision"], "sourceRevision");
  if (!/^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(releaseVersion)) {
    throw new TypeError("releaseVersion must be semantic");
  }
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) {
    throw new TypeError("sourceRevision must be a full Git revision");
  }
  const contracts = record(item["contracts"], "contracts");
  const secp = record(item["secp256k1Blake160"], "secp256k1Blake160");
  return Object.freeze({
    schemaVersion: 1 as const,
    releaseVersion,
    network: "ckb_testnet" as const,
    genesisHash: parseHash32(text(item["genesisHash"], "genesisHash")),
    sourceRevision,
    secp256k1Blake160: Object.freeze({
      cellDep: cellDep(secp["cellDep"], "secp256k1Blake160.cellDep"),
    }),
    contracts: Object.freeze({
      jobLock: contract(contracts["jobLock"], "contracts.jobLock"),
      deadlinePolicy: contract(contracts["deadlinePolicy"], "contracts.deadlinePolicy"),
      recurringPolicy: contract(contracts["recurringPolicy"], "contracts.recurringPolicy"),
    }),
    defaultPreferredOperatorLockHash: parseHash32(
      text(item["defaultPreferredOperatorLockHash"], "defaultPreferredOperatorLockHash"),
    ),
  });
}

function ckbDataHash(bytes: Uint8Array): Hash32 {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(bytes);
  return parseHash32(`0x${hasher.digest("hex")}`);
}

export async function loadOperatorAutomationDeployment(
  path: string,
  chain: Pick<CkbReadClient, "getCellLive" | "getGenesisHash">,
  expectedGenesisHash: string,
): Promise<OperatorAutomationDeployment> {
  const bytes = await readFile(path);
  const manifest = parseOperatorAutomationManifest(JSON.parse(bytes.toString("utf8")));
  const expectedGenesis = parseHash32(expectedGenesisHash);
  if (
    manifest.genesisHash !== expectedGenesis ||
    (await chain.getGenesisHash()) !== expectedGenesis
  ) {
    throw new Error("operator automation manifest does not match the configured chain genesis");
  }
  for (const [name, item] of Object.entries(manifest.contracts)) {
    const live = await chain.getCellLive(item.cellDep.outPoint);
    if (!live) throw new Error(`${name} code cell is not live`);
    const contractBytes = hexToBytes(live.outputData.toString());
    if (
      contractBytes.length !== item.sizeBytes ||
      createHash("sha256").update(contractBytes).digest("hex") !== item.binarySha256 ||
      ckbDataHash(contractBytes) !== item.script.codeHash
    ) {
      throw new Error(`${name} code cell does not match the audited manifest`);
    }
  }
  return Object.freeze({
    genesisHash: manifest.genesisHash,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    secp256k1Blake160: manifest.secp256k1Blake160,
    contracts: manifest.contracts,
    defaultPreferredOperatorLockHash: manifest.defaultPreferredOperatorLockHash,
  });
}
