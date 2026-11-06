import { parseHash32, type Hash32 } from "./chain-values.ts";
import type { CellDepIdentity } from "./job-inspection.ts";
import type {
  OperatorAutomationDeployment,
  OperatorContractDeployment,
} from "./operator-deployment.ts";

const SHA256 = /^[0-9a-f]{64}$/;

export interface OperatorAutomationManifest {
  readonly schemaVersion: 1;
  readonly releaseVersion: string;
  readonly network: "ckb_testnet";
  readonly genesisHash: Hash32;
  readonly sourceRevision: string;
  readonly secp256k1Blake160: OperatorAutomationDeployment["secp256k1Blake160"];
  readonly contracts: OperatorAutomationDeployment["contracts"];
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
