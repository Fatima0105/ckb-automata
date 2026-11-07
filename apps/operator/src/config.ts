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
  readonly operatorName?: string;
  readonly operatorPublicUrl?: string;
  readonly automataApiUrl?: string;
  readonly operatorServices?: readonly ("dao-harvest" | "deadline" | "recurring")[];
}

function url(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must use http or https`);
  }
  return parsed.href;
}

function origin(value: string | undefined, name: string, httpsOnly = false): string | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = new URL(value);
  if (
    (httpsOnly
      ? parsed.protocol !== "https:"
      : parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      `${name} must be an ${httpsOnly ? "HTTPS" : "HTTP(S)"} origin without credentials or a path`,
    );
  }
  return parsed.origin;
}

function operatorName(value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  const name = value.trim();
  const hasControlCharacter = [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (name.length < 2 || name.length > 64 || hasControlCharacter) {
    throw new Error("OPERATOR_NAME must contain 2 to 64 printable characters");
  }
  return name;
}

function operatorServices(
  value: string | undefined,
): readonly ("dao-harvest" | "deadline" | "recurring")[] | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const allowed = new Set(["dao-harvest", "deadline", "recurring"] as const);
  const services = value.split(",").map((item) => item.trim());
  if (
    services.length < 1 ||
    services.length > allowed.size ||
    new Set(services).size !== services.length ||
    services.some((service) => !allowed.has(service as "dao-harvest" | "deadline" | "recurring"))
  ) {
    throw new Error(
      "OPERATOR_SERVICES must be a unique comma-separated list of dao-harvest, deadline, and recurring",
    );
  }
  return Object.freeze(services.toSorted() as ("dao-harvest" | "deadline" | "recurring")[]);
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
  const name = operatorName(input["OPERATOR_NAME"]);
  const publicUrl = origin(input["OPERATOR_PUBLIC_URL"], "OPERATOR_PUBLIC_URL", true);
  const apiUrl = origin(input["CKAUTOMATA_API_URL"], "CKAUTOMATA_API_URL");
  const services = operatorServices(input["OPERATOR_SERVICES"]);
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
    ...(name === undefined ? {} : { operatorName: name }),
    ...(publicUrl === undefined ? {} : { operatorPublicUrl: publicUrl }),
    ...(apiUrl === undefined ? {} : { automataApiUrl: apiUrl }),
    ...(services === undefined ? {} : { operatorServices: services }),
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
    operatorName: config.operatorName ?? null,
    operatorPublicUrl: config.operatorPublicUrl ?? null,
    automataApiUrl: config.automataApiUrl ?? null,
    operatorServices: config.operatorServices ?? null,
  });
}
