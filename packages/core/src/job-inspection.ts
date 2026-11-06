import { JobDataV1 } from "@ckb-automata/molecule";
import { scriptToHash } from "@nervosnetwork/ckb-sdk-utils";

import {
  hash32FromBytes,
  parseHash32,
  parseRunCount,
  parseSequence,
  parseShannons,
  parseSince,
  type Hash32,
  type RunCount,
  type Sequence,
  type Shannons,
  type SinceValue,
} from "./chain-values.ts";
import type { OperatorAutomationDeployment } from "./operator-deployment.ts";

export const DEPLOYED_CONTRACT_NAMES = [
  "job-lock",
  "deadline-policy",
  "recurring-policy",
  "demo-campaign-type",
  "campaign-lock",
] as const;

export type DeployedContractName = (typeof DEPLOYED_CONTRACT_NAMES)[number];
export type ScriptHashType = "data" | "type" | "data1";

export interface ScriptIdentity {
  readonly codeHash: Hash32;
  readonly hashType: ScriptHashType;
  readonly args: `0x${string}`;
}

export interface CellDepIdentity {
  readonly outPoint: {
    readonly txHash: Hash32;
    readonly index: `0x${string}`;
  };
  readonly depType: "code" | "depGroup";
}

export function scriptIdentityHash(script: ScriptIdentity): Hash32 {
  return parseHash32(scriptToHash(script));
}

export interface DeployedContract {
  readonly codeHash: Hash32;
  readonly hashType: ScriptHashType;
  readonly cellDep: CellDepIdentity;
  readonly binarySha256: string;
  readonly sizeBytes: number;
}

export interface DaoHarvestManifestDeployment {
  readonly deployment: {
    readonly transactionHash: Hash32;
    readonly blockHash: Hash32;
  };
  readonly contracts: {
    readonly "harvest-vault-lock": DeployedContract;
    readonly "dao-harvest-policy": DeployedContract;
  };
  readonly nervosDao: {
    readonly codeHash: Hash32;
    readonly hashType: ScriptHashType;
    readonly cellDep: CellDepIdentity;
  };
  readonly prepareExecutorLockHashes: readonly Hash32[];
}

export interface DeploymentManifest {
  readonly schemaVersion: 1;
  readonly network: string;
  readonly rpcUrl: string;
  readonly genesisHash: Hash32;
  readonly consensus: {
    readonly hardfork: string;
    readonly activationEpoch: number;
  };
  readonly nodeVersion: string;
  readonly fixtureWallet: {
    readonly lockArg: `0x${string}`;
    readonly warning: string;
  };
  readonly artifacts: {
    readonly sourceRevision: string;
    readonly schemaSha256: string;
    readonly builder: {
      readonly baseImage: string;
      readonly dockerfileSha256: string;
      readonly rust: string;
      readonly target: string;
      readonly profile: string;
      readonly sourceDateEpoch: number;
    };
  };
  readonly secp256k1Blake160: {
    readonly codeHash: Hash32;
    readonly hashType: ScriptHashType;
    readonly cellDep: CellDepIdentity;
  };
  readonly deployment: {
    readonly transactionHash: Hash32;
    readonly blockHash: Hash32;
  };
  readonly contracts: Readonly<Record<DeployedContractName, DeployedContract>>;
  readonly daoHarvest?: DaoHarvestManifestDeployment;
  readonly verification: {
    readonly kind: string;
    readonly transactionHash: Hash32;
    readonly blockHash: Hash32;
    readonly contract: DeployedContractName;
    readonly status: "committed";
  };
}

export interface ManifestIssue {
  readonly code: "INVALID_FIELD" | "WRONG_NETWORK" | "INCONSISTENT_DEPLOYMENT";
  readonly path: string;
  readonly message: string;
}

export type ManifestValidationResult =
  | { readonly status: "ok"; readonly manifest: DeploymentManifest }
  | { readonly status: "invalid"; readonly issues: readonly ManifestIssue[] };

export interface InspectedJobDataV1 {
  readonly version: 1;
  readonly flags: 0;
  readonly jobId: Hash32;
  readonly sequence: Sequence;
  readonly state: "LIVE";
  readonly trigger: {
    readonly kind: 1 | 2 | 3 | 4 | 5 | 6;
    readonly metric: "block" | "epoch" | "timestamp" | "none";
    readonly paramsHash: Hash32;
  };
  readonly policyScriptHash: Hash32;
  readonly payloadHash: Hash32;
  readonly reward: Shannons;
  readonly remainingBudget: Shannons;
  readonly notBefore: SinceValue;
  readonly notAfter: SinceValue;
  readonly remainingRuns: RunCount;
  readonly cancelLockHash: Hash32;
}

export type PolicyMetadata =
  | { readonly kind: "unresolved"; readonly scriptHash: Hash32 }
  | {
      readonly kind: "recurring";
      readonly scriptHash: Hash32;
      readonly contract: "recurring-policy" | "recurring-policy-v2";
    }
  | {
      readonly kind: "deadline";
      readonly scriptHash: Hash32;
      readonly contract: "deadline-policy" | "deadline-policy-v2";
      readonly campaignTypeHash: Hash32;
    }
  | {
      readonly kind: "dao_harvest";
      readonly scriptHash: Hash32;
      readonly contract: "dao-harvest-policy";
    }
  | {
      readonly kind: "unknown";
      readonly scriptHash: Hash32;
      readonly codeHash: Hash32;
    };

export interface JobInspectionOptions {
  readonly manifest?: unknown;
  readonly expectedGenesisHash?: string;
  readonly policyScript?: unknown;
  readonly operatorDeployment?: OperatorAutomationDeployment;
}

export interface JobSemanticIssue {
  readonly field: "flags" | "state" | "triggerKind" | "remainingRuns";
  readonly message: string;
}

export type JobInspectionResult =
  | {
      readonly status: "ok";
      readonly job: InspectedJobDataV1;
      readonly policy: PolicyMetadata;
      readonly manifest?: DeploymentManifest;
    }
  | { readonly status: "unsupported_version"; readonly version: number }
  | { readonly status: "malformed"; readonly message: string }
  | { readonly status: "invalid_job"; readonly issues: readonly JobSemanticIssue[] }
  | { readonly status: "manifest_error"; readonly issues: readonly ManifestIssue[] }
  | {
      readonly status: "policy_mismatch";
      readonly committedScriptHash: Hash32;
      readonly actualScriptHash: Hash32;
    };

type JsonRecord = Record<string, unknown>;

const HASH_PATTERN = /^0x[0-9a-f]{64}$/;
const HEX_PATTERN = /^0x(?:[0-9a-f]{2})*$/;
const UINT_HEX_PATTERN = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function issue(
  issues: ManifestIssue[],
  code: ManifestIssue["code"],
  path: string,
  message: string,
): void {
  issues.push(Object.freeze({ code, path, message }));
}

function requireRecord(value: unknown, path: string, issues: ManifestIssue[]): JsonRecord {
  if (!isRecord(value)) {
    issue(issues, "INVALID_FIELD", path, "must be an object");
    return {};
  }
  return value;
}

function requireString(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
  pattern?: RegExp,
): string {
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    issue(issues, "INVALID_FIELD", path, "has an invalid string value");
    return "";
  }
  return value;
}

function requireInteger(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    issue(
      issues,
      "INVALID_FIELD",
      path,
      `must be a safe integer greater than or equal to ${minimum}`,
    );
    return minimum;
  }
  return value as number;
}

function requireHash(value: unknown, path: string, issues: ManifestIssue[]): Hash32 {
  const hash = requireString(value, path, issues, HASH_PATTERN);
  return (hash || `0x${"00".repeat(32)}`) as Hash32;
}

function requireHashType(value: unknown, path: string, issues: ManifestIssue[]): ScriptHashType {
  if (value !== "data" && value !== "type" && value !== "data1") {
    issue(issues, "INVALID_FIELD", path, "must be data, data1, or type");
    return "data";
  }
  return value;
}

function validateCellDep(value: unknown, path: string, issues: ManifestIssue[]): CellDepIdentity {
  const cellDep = requireRecord(value, path, issues);
  const outPoint = requireRecord(cellDep["outPoint"], `${path}.outPoint`, issues);
  const depType = cellDep["depType"];
  if (depType !== "code" && depType !== "depGroup") {
    issue(issues, "INVALID_FIELD", `${path}.depType`, "must be code or depGroup");
  }
  const index = requireString(
    outPoint["index"],
    `${path}.outPoint.index`,
    issues,
    UINT_HEX_PATTERN,
  );
  return {
    outPoint: {
      txHash: requireHash(outPoint["txHash"], `${path}.outPoint.txHash`, issues),
      index: (index || "0x0") as `0x${string}`,
    },
    depType: depType === "depGroup" ? "depGroup" : "code",
  };
}

function validateContract(value: unknown, path: string, issues: ManifestIssue[]): DeployedContract {
  const contract = requireRecord(value, path, issues);
  return {
    codeHash: requireHash(contract["codeHash"], `${path}.codeHash`, issues),
    hashType: requireHashType(contract["hashType"], `${path}.hashType`, issues),
    cellDep: validateCellDep(contract["cellDep"], `${path}.cellDep`, issues),
    binarySha256: requireString(
      contract["binarySha256"],
      `${path}.binarySha256`,
      issues,
      SHA256_PATTERN,
    ),
    sizeBytes: requireInteger(contract["sizeBytes"], `${path}.sizeBytes`, issues, 1),
  };
}

function validateDaoHarvestManifest(
  value: unknown,
  issues: ManifestIssue[],
): DaoHarvestManifestDeployment | undefined {
  if (value === undefined) return undefined;
  const path = "$.daoHarvest";
  const harvest = requireRecord(value, path, issues);
  const deployment = requireRecord(harvest["deployment"], `${path}.deployment`, issues);
  const contractsValue = requireRecord(harvest["contracts"], `${path}.contracts`, issues);
  const nervosDao = requireRecord(harvest["nervosDao"], `${path}.nervosDao`, issues);
  const deploymentTransactionHash = requireHash(
    deployment["transactionHash"],
    `${path}.deployment.transactionHash`,
    issues,
  );
  const contracts = {
    "harvest-vault-lock": validateContract(
      contractsValue["harvest-vault-lock"],
      `${path}.contracts.harvest-vault-lock`,
      issues,
    ),
    "dao-harvest-policy": validateContract(
      contractsValue["dao-harvest-policy"],
      `${path}.contracts.dao-harvest-policy`,
      issues,
    ),
  };
  const extraContracts = Object.keys(contractsValue).filter(
    (name) => name !== "harvest-vault-lock" && name !== "dao-harvest-policy",
  );
  if (extraContracts.length > 0) {
    issue(issues, "INVALID_FIELD", `${path}.contracts`, "contains unknown contract entries");
  }
  const identities = new Set<string>();
  let contractsFromLatestDeployment = 0;
  for (const [name, contract] of Object.entries(contracts)) {
    if (contract.hashType !== "data1" || contract.cellDep.depType !== "code") {
      issue(
        issues,
        "INCONSISTENT_DEPLOYMENT",
        `${path}.contracts.${name}`,
        "must use a data1 script and direct code cell dependency",
      );
    }
    if (contract.cellDep.outPoint.txHash === deploymentTransactionHash) {
      contractsFromLatestDeployment += 1;
    }
    const identity = `${contract.cellDep.outPoint.txHash}:${contract.cellDep.outPoint.index}`;
    if (identities.has(identity)) {
      issue(
        issues,
        "INCONSISTENT_DEPLOYMENT",
        `${path}.contracts.${name}.cellDep`,
        "must identify a unique code cell",
      );
    }
    identities.add(identity);
  }
  if (contractsFromLatestDeployment === 0) {
    issue(
      issues,
      "INCONSISTENT_DEPLOYMENT",
      `${path}.deployment.transactionHash`,
      "must contain at least one active DAO harvest contract",
    );
  }
  const executorValues = harvest["prepareExecutorLockHashes"];
  const executorHashes: Hash32[] = [];
  if (!Array.isArray(executorValues) || executorValues.length < 1 || executorValues.length > 8) {
    issue(
      issues,
      "INVALID_FIELD",
      `${path}.prepareExecutorLockHashes`,
      "must contain one to eight executor lock hashes",
    );
  } else {
    for (const [index, executor] of executorValues.entries()) {
      executorHashes.push(
        requireHash(executor, `${path}.prepareExecutorLockHashes[${index}]`, issues),
      );
    }
    if (new Set(executorHashes).size !== executorHashes.length) {
      issue(
        issues,
        "INVALID_FIELD",
        `${path}.prepareExecutorLockHashes`,
        "must not contain duplicate executor lock hashes",
      );
    }
  }
  const daoHashType = requireHashType(nervosDao["hashType"], `${path}.nervosDao.hashType`, issues);
  const daoCellDep = validateCellDep(nervosDao["cellDep"], `${path}.nervosDao.cellDep`, issues);
  if (daoHashType !== "type" || daoCellDep.depType !== "code") {
    issue(
      issues,
      "INCONSISTENT_DEPLOYMENT",
      `${path}.nervosDao`,
      "must reference the canonical type-hash DAO code cell",
    );
  }
  return {
    deployment: {
      transactionHash: deploymentTransactionHash,
      blockHash: requireHash(deployment["blockHash"], `${path}.deployment.blockHash`, issues),
    },
    contracts,
    nervosDao: {
      codeHash: requireHash(nervosDao["codeHash"], `${path}.nervosDao.codeHash`, issues),
      hashType: daoHashType,
      cellDep: daoCellDep,
    },
    prepareExecutorLockHashes: Object.freeze(executorHashes),
  };
}

export function validateDeploymentManifest(
  value: unknown,
  expectedGenesisHash?: string,
): ManifestValidationResult {
  const issues: ManifestIssue[] = [];
  const root = requireRecord(value, "$", issues);
  if (root["schemaVersion"] !== 1) {
    issue(issues, "INVALID_FIELD", "$.schemaVersion", "must equal 1");
  }

  const genesisHash = requireHash(root["genesisHash"], "$.genesisHash", issues);
  let expectedGenesis: Hash32 | undefined;
  if (expectedGenesisHash !== undefined) {
    try {
      expectedGenesis = parseHash32(expectedGenesisHash);
    } catch {
      issue(issues, "INVALID_FIELD", "$expectedGenesisHash", "must be a canonical byte32 hash");
    }
    if (expectedGenesis && genesisHash !== expectedGenesis) {
      issue(issues, "WRONG_NETWORK", "$.genesisHash", "does not match the selected network");
    }
  }

  const consensus = requireRecord(root["consensus"], "$.consensus", issues);
  const fixtureWallet = requireRecord(root["fixtureWallet"], "$.fixtureWallet", issues);
  const artifacts = requireRecord(root["artifacts"], "$.artifacts", issues);
  const builder = requireRecord(artifacts["builder"], "$.artifacts.builder", issues);
  const secp = requireRecord(root["secp256k1Blake160"], "$.secp256k1Blake160", issues);
  const deployment = requireRecord(root["deployment"], "$.deployment", issues);
  const contractsValue = requireRecord(root["contracts"], "$.contracts", issues);
  const verification = requireRecord(root["verification"], "$.verification", issues);
  const daoHarvest = validateDaoHarvestManifest(root["daoHarvest"], issues);

  const contracts = Object.fromEntries(
    DEPLOYED_CONTRACT_NAMES.map((name) => [
      name,
      validateContract(contractsValue[name], `$.contracts.${name}`, issues),
    ]),
  ) as unknown as Record<DeployedContractName, DeployedContract>;

  const extraContracts = Object.keys(contractsValue).filter(
    (name) => !DEPLOYED_CONTRACT_NAMES.includes(name as DeployedContractName),
  );
  if (extraContracts.length > 0) {
    issue(issues, "INVALID_FIELD", "$.contracts", "contains unknown contract entries");
  }

  const deploymentTransactionHash = requireHash(
    deployment["transactionHash"],
    "$.deployment.transactionHash",
    issues,
  );
  const codeHashes = new Set<string>();
  const depOutPoints = new Set<string>();
  let contractsFromLatestDeployment = 0;
  for (const name of DEPLOYED_CONTRACT_NAMES) {
    const contract = contracts[name];
    if (contract.hashType !== "data1") {
      issue(
        issues,
        "INCONSISTENT_DEPLOYMENT",
        `$.contracts.${name}.hashType`,
        "deployed contracts must use data1",
      );
    }
    if (contract.cellDep.depType !== "code") {
      issue(
        issues,
        "INCONSISTENT_DEPLOYMENT",
        `$.contracts.${name}.cellDep.depType`,
        "deployed contracts must use code cell deps",
      );
    }
    if (contract.cellDep.outPoint.txHash === deploymentTransactionHash) {
      contractsFromLatestDeployment += 1;
    }
    if (codeHashes.has(contract.codeHash)) {
      issue(issues, "INCONSISTENT_DEPLOYMENT", `$.contracts.${name}.codeHash`, "must be unique");
    }
    const outPointIdentity = `${contract.cellDep.outPoint.txHash}:${contract.cellDep.outPoint.index}`;
    if (depOutPoints.has(outPointIdentity)) {
      issue(
        issues,
        "INCONSISTENT_DEPLOYMENT",
        `$.contracts.${name}.cellDep`,
        "must identify a unique code cell",
      );
    }
    codeHashes.add(contract.codeHash);
    depOutPoints.add(outPointIdentity);
  }
  if (contractsFromLatestDeployment === 0) {
    issue(
      issues,
      "INCONSISTENT_DEPLOYMENT",
      "$.deployment.transactionHash",
      "must contain at least one active deployed contract",
    );
  }

  const verificationContract = verification["contract"];
  if (!DEPLOYED_CONTRACT_NAMES.includes(verificationContract as DeployedContractName)) {
    issue(issues, "INVALID_FIELD", "$.verification.contract", "must name a deployed contract");
  }
  if (verification["status"] !== "committed") {
    issue(issues, "INVALID_FIELD", "$.verification.status", "must equal committed");
  }

  const manifest: DeploymentManifest = {
    schemaVersion: 1,
    network: requireString(root["network"], "$.network", issues),
    rpcUrl: requireString(root["rpcUrl"], "$.rpcUrl", issues),
    genesisHash,
    consensus: {
      hardfork: requireString(consensus["hardfork"], "$.consensus.hardfork", issues),
      activationEpoch: requireInteger(
        consensus["activationEpoch"],
        "$.consensus.activationEpoch",
        issues,
      ),
    },
    nodeVersion: requireString(root["nodeVersion"], "$.nodeVersion", issues),
    fixtureWallet: {
      lockArg: (requireString(
        fixtureWallet["lockArg"],
        "$.fixtureWallet.lockArg",
        issues,
        HEX_PATTERN,
      ) || "0x") as `0x${string}`,
      warning: requireString(fixtureWallet["warning"], "$.fixtureWallet.warning", issues),
    },
    artifacts: {
      sourceRevision: requireString(
        artifacts["sourceRevision"],
        "$.artifacts.sourceRevision",
        issues,
        REVISION_PATTERN,
      ),
      schemaSha256: requireString(
        artifacts["schemaSha256"],
        "$.artifacts.schemaSha256",
        issues,
        SHA256_PATTERN,
      ),
      builder: {
        baseImage: requireString(builder["baseImage"], "$.artifacts.builder.baseImage", issues),
        dockerfileSha256: requireString(
          builder["dockerfileSha256"],
          "$.artifacts.builder.dockerfileSha256",
          issues,
          SHA256_PATTERN,
        ),
        rust: requireString(builder["rust"], "$.artifacts.builder.rust", issues),
        target: requireString(builder["target"], "$.artifacts.builder.target", issues),
        profile: requireString(builder["profile"], "$.artifacts.builder.profile", issues),
        sourceDateEpoch: requireInteger(
          builder["sourceDateEpoch"],
          "$.artifacts.builder.sourceDateEpoch",
          issues,
        ),
      },
    },
    secp256k1Blake160: {
      codeHash: requireHash(secp["codeHash"], "$.secp256k1Blake160.codeHash", issues),
      hashType: requireHashType(secp["hashType"], "$.secp256k1Blake160.hashType", issues),
      cellDep: validateCellDep(secp["cellDep"], "$.secp256k1Blake160.cellDep", issues),
    },
    deployment: {
      transactionHash: deploymentTransactionHash,
      blockHash: requireHash(deployment["blockHash"], "$.deployment.blockHash", issues),
    },
    contracts,
    ...(daoHarvest === undefined ? {} : { daoHarvest }),
    verification: {
      kind: requireString(verification["kind"], "$.verification.kind", issues),
      transactionHash: requireHash(
        verification["transactionHash"],
        "$.verification.transactionHash",
        issues,
      ),
      blockHash: requireHash(verification["blockHash"], "$.verification.blockHash", issues),
      contract: verificationContract as DeployedContractName,
      status: "committed",
    },
  };

  return issues.length > 0
    ? { status: "invalid", issues: Object.freeze(issues) }
    : { status: "ok", manifest: deepFreeze(manifest) };
}

function decodeBytes(value: Uint8Array | string): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (!HEX_PATTERN.test(value)) {
    throw new TypeError("job data must be canonical lowercase, byte-aligned hexadecimal");
  }
  return Uint8Array.from({ length: (value.length - 2) / 2 }, (_, index) =>
    Number.parseInt(value.slice(2 + index * 2, 4 + index * 2), 16),
  );
}

function parsePolicyScript(value: unknown): ScriptIdentity | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const codeHash = value["codeHash"];
  const hashType = value["hashType"];
  const args = value["args"];
  if (
    typeof codeHash !== "string" ||
    !HASH_PATTERN.test(codeHash) ||
    (hashType !== "data" && hashType !== "data1" && hashType !== "type") ||
    typeof args !== "string" ||
    !HEX_PATTERN.test(args)
  ) {
    return undefined;
  }
  return { codeHash: codeHash as Hash32, hashType, args: args as `0x${string}` };
}

function semanticIssues(decoded: ReturnType<typeof JobDataV1.unpack>): JobSemanticIssue[] {
  const issues: JobSemanticIssue[] = [];
  if (decoded.flags !== 0) {
    issues.push({ field: "flags", message: "reserved flags must be zero" });
  }
  if (decoded.state !== 0) {
    issues.push({ field: "state", message: "V1 only defines the LIVE state" });
  }
  if (decoded.trigger_kind < 1 || decoded.trigger_kind > 6) {
    issues.push({ field: "triggerKind", message: "trigger kind must be between 1 and 6" });
  }
  if (decoded.remaining_runs === 0) {
    issues.push({ field: "remainingRuns", message: "a live job must have at least one run" });
  }
  return issues;
}

function triggerMetric(kind: number): InspectedJobDataV1["trigger"]["metric"] {
  if (kind === 1) return "block";
  if (kind === 2) return "epoch";
  if (kind === 3) return "timestamp";
  return "none";
}

function classifyPolicy(
  scriptHash: Hash32,
  policyScript: ScriptIdentity | undefined,
  manifest: DeploymentManifest | undefined,
  operatorDeployment: OperatorAutomationDeployment | undefined,
): PolicyMetadata {
  if (!policyScript) {
    return Object.freeze({ kind: "unresolved", scriptHash });
  }
  if (!manifest) {
    return Object.freeze({ kind: "unknown", scriptHash, codeHash: policyScript.codeHash });
  }
  if (
    operatorDeployment !== undefined &&
    policyScript.codeHash === operatorDeployment.contracts.recurringPolicy.script.codeHash &&
    policyScript.hashType === operatorDeployment.contracts.recurringPolicy.script.hashType &&
    policyScript.args === "0x"
  ) {
    return Object.freeze({ kind: "recurring", scriptHash, contract: "recurring-policy-v2" });
  }
  if (
    operatorDeployment !== undefined &&
    policyScript.codeHash === operatorDeployment.contracts.deadlinePolicy.script.codeHash &&
    policyScript.hashType === operatorDeployment.contracts.deadlinePolicy.script.hashType &&
    HASH_PATTERN.test(policyScript.args)
  ) {
    return Object.freeze({
      kind: "deadline",
      scriptHash,
      contract: "deadline-policy-v2",
      campaignTypeHash: parseHash32(policyScript.args),
    });
  }
  if (
    policyScript.codeHash === manifest.contracts["recurring-policy"].codeHash &&
    policyScript.hashType === manifest.contracts["recurring-policy"].hashType &&
    policyScript.args === "0x"
  ) {
    return Object.freeze({ kind: "recurring", scriptHash, contract: "recurring-policy" });
  }
  if (
    policyScript.codeHash === manifest.contracts["deadline-policy"].codeHash &&
    policyScript.hashType === manifest.contracts["deadline-policy"].hashType &&
    HASH_PATTERN.test(policyScript.args)
  ) {
    return Object.freeze({
      kind: "deadline",
      scriptHash,
      contract: "deadline-policy",
      campaignTypeHash: parseHash32(policyScript.args),
    });
  }
  if (
    manifest.daoHarvest !== undefined &&
    policyScript.codeHash === manifest.daoHarvest.contracts["dao-harvest-policy"].codeHash &&
    policyScript.hashType === manifest.daoHarvest.contracts["dao-harvest-policy"].hashType &&
    policyScript.args === "0x"
  ) {
    return Object.freeze({
      kind: "dao_harvest",
      scriptHash,
      contract: "dao-harvest-policy",
    });
  }
  return Object.freeze({ kind: "unknown", scriptHash, codeHash: policyScript.codeHash });
}

export function inspectJobData(
  value: Uint8Array | string,
  options: JobInspectionOptions = {},
): JobInspectionResult {
  let decoded: ReturnType<typeof JobDataV1.unpack>;
  try {
    decoded = JobDataV1.unpack(decodeBytes(value));
  } catch (error) {
    return {
      status: "malformed",
      message: error instanceof Error ? error.message : "job data could not be decoded",
    };
  }

  if (decoded.version !== 1) {
    return { status: "unsupported_version", version: decoded.version };
  }

  const invalid = semanticIssues(decoded);
  if (invalid.length > 0) {
    return { status: "invalid_job", issues: Object.freeze(invalid) };
  }

  let manifest: DeploymentManifest | undefined;
  if (options.manifest !== undefined) {
    const validation = validateDeploymentManifest(options.manifest, options.expectedGenesisHash);
    if (validation.status === "invalid") {
      return { status: "manifest_error", issues: validation.issues };
    }
    manifest = validation.manifest;
  } else if (options.expectedGenesisHash !== undefined) {
    return {
      status: "manifest_error",
      issues: [
        {
          code: "INVALID_FIELD",
          path: "$manifest",
          message: "is required when an expected genesis hash is supplied",
        },
      ],
    };
  }

  const policyScript =
    options.policyScript === undefined ? undefined : parsePolicyScript(options.policyScript);
  if (options.policyScript !== undefined && !policyScript) {
    return {
      status: "malformed",
      message: "policy script must contain canonical codeHash, hashType, and byte-aligned args",
    };
  }

  const committedScriptHash = hash32FromBytes(Uint8Array.from(decoded.policy_script_hash));
  if (policyScript) {
    const actualScriptHash = parseHash32(scriptToHash(policyScript));
    if (actualScriptHash !== committedScriptHash) {
      return { status: "policy_mismatch", committedScriptHash, actualScriptHash };
    }
  }

  const job: InspectedJobDataV1 = Object.freeze({
    version: 1,
    flags: 0,
    jobId: hash32FromBytes(Uint8Array.from(decoded.job_id)),
    sequence: parseSequence(decoded.sequence.toString()),
    state: "LIVE",
    trigger: Object.freeze({
      kind: decoded.trigger_kind as InspectedJobDataV1["trigger"]["kind"],
      metric: triggerMetric(decoded.trigger_kind),
      paramsHash: hash32FromBytes(Uint8Array.from(decoded.trigger_params_hash)),
    }),
    policyScriptHash: committedScriptHash,
    payloadHash: hash32FromBytes(Uint8Array.from(decoded.payload_hash)),
    reward: parseShannons(decoded.reward.toString()),
    remainingBudget: parseShannons(decoded.remaining_budget.toString()),
    notBefore: parseSince(decoded.not_before.toString()),
    notAfter: parseSince(decoded.not_after.toString()),
    remainingRuns: parseRunCount(BigInt(decoded.remaining_runs)),
    cancelLockHash: hash32FromBytes(Uint8Array.from(decoded.cancel_lock_hash)),
  });

  return {
    status: "ok",
    job,
    policy: classifyPolicy(committedScriptHash, policyScript, manifest, options.operatorDeployment),
    ...(manifest ? { manifest } : {}),
  };
}
