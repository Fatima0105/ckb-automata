import { resolve } from "node:path";

const HASH = /^0x[0-9a-f]{64}$/;
const PRIVATE_KEY = /^0x[0-9a-f]{64}$/;

export interface OperatorConfiguration {
  readonly rpcUrl: string;
  readonly indexerUrl: string;
  readonly manifestPath?: string;
  readonly automationManifestPath?: string;
  readonly lockResolutionsPath?: string;
  readonly privateKey?: string;
  readonly minimumProfitMargin: bigint;
  readonly feeRatePerKilobyte: bigint;
  readonly transactionFee: bigint;
  readonly confirmationDepth: bigint;
  readonly healthPort: number;
  readonly expectedGenesisHash?: string;
}

function url(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.href;
}

function decimal(value: string | undefined, fallback: bigint, name: string): bigint {
  if (value === undefined || value === "") return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`${name} must be a decimal integer`);
  return BigInt(value);
}

function port(value: string | undefined): number {
  const parsed = value === undefined || value === "" ? 9464 : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("OPERATOR_HEALTH_PORT must be between 1 and 65535");
  }
  return parsed;
}

export function parseOperatorConfiguration(
  input: Readonly<Record<string, string | undefined>>,
  cwd = process.cwd(),
): OperatorConfiguration {
  const privateKey = input["OPERATOR_PRIVATE_KEY"];
  if (privateKey !== undefined && privateKey !== "" && !PRIVATE_KEY.test(privateKey)) {
    throw new Error("OPERATOR_PRIVATE_KEY must be a lowercase 32-byte private key");
  }
  const expectedGenesisHash = input["CKB_GENESIS_HASH"];
  if (expectedGenesisHash && !HASH.test(expectedGenesisHash)) {
    throw new Error("CKB_GENESIS_HASH must be a lowercase 32-byte hash");
  }
  const manifestPath = input["OPERATOR_MANIFEST_PATH"];
  const automationManifestPath = input["OPERATOR_AUTOMATION_MANIFEST_PATH"];
  if (!manifestPath && !automationManifestPath) {
    throw new Error("at least one operator manifest path is required");
  }
  const transactionFee = decimal(
    input["OPERATOR_TRANSACTION_FEE"],
    50_000n,
    "OPERATOR_TRANSACTION_FEE",
  );
  if (transactionFee < 1n || transactionFee > 50_000n) {
    throw new Error("OPERATOR_TRANSACTION_FEE must be between 1 and 50000 shannons");
  }
  return Object.freeze({
    rpcUrl: url(input["CKB_RPC_URL"], "CKB_RPC_URL"),
    indexerUrl: url(input["CKB_INDEXER_URL"], "CKB_INDEXER_URL"),
    ...(manifestPath ? { manifestPath: resolve(cwd, manifestPath) } : {}),
    ...(automationManifestPath
      ? { automationManifestPath: resolve(cwd, automationManifestPath) }
      : {}),
    ...(input["OPERATOR_LOCK_RESOLUTIONS_PATH"]
      ? { lockResolutionsPath: resolve(cwd, input["OPERATOR_LOCK_RESOLUTIONS_PATH"]!) }
      : {}),
    ...(privateKey ? { privateKey } : {}),
    minimumProfitMargin: decimal(
      input["OPERATOR_MINIMUM_PROFIT_MARGIN"],
      0n,
      "OPERATOR_MINIMUM_PROFIT_MARGIN",
    ),
    feeRatePerKilobyte: decimal(
      input["OPERATOR_FEE_RATE_PER_KILOBYTE"],
      1_000n,
      "OPERATOR_FEE_RATE_PER_KILOBYTE",
    ),
    transactionFee,
    confirmationDepth: decimal(
      input["OPERATOR_CONFIRMATION_DEPTH"],
      5n,
      "OPERATOR_CONFIRMATION_DEPTH",
    ),
    healthPort: port(input["OPERATOR_HEALTH_PORT"]),
    ...(expectedGenesisHash ? { expectedGenesisHash } : {}),
  });
}

export function publicOperatorConfiguration(config: OperatorConfiguration) {
  return Object.freeze({
    rpcUrl: config.rpcUrl,
    indexerUrl: config.indexerUrl,
    manifestPath: config.manifestPath ?? null,
    automationManifestPath: config.automationManifestPath ?? null,
    lockResolutionsPath: config.lockResolutionsPath ?? null,
    signingKeyConfigured: config.privateKey !== undefined,
    minimumProfitMargin: config.minimumProfitMargin.toString(),
    feeRatePerKilobyte: config.feeRatePerKilobyte.toString(),
    transactionFee: config.transactionFee.toString(),
    confirmationDepth: config.confirmationDepth.toString(),
    healthPort: config.healthPort,
    expectedGenesisHash: config.expectedGenesisHash ?? null,
  });
}
