import { z } from "zod";

export const ENVIRONMENT_PROFILES = ["local", "test", "testnet-preview", "testnet-public"] as const;

export type EnvironmentProfile = (typeof ENVIRONMENT_PROFILES)[number];

export const AUTOMATA_ENV_KEYS = [
  "AUTOMATA_PROFILE",
  "CKB_NETWORK",
  "CKB_GENESIS_HASH",
  "CKB_RPC_URL",
  "CKB_INDEXER_URL",
  "DAO_HARVEST_V2_MANIFEST_PATH",
  "DATABASE_URL",
  "REDIS_URL",
  "EXECUTOR_LOCK_ARGS",
  "EXECUTOR_TRANSACTION_FEE",
  "EXECUTOR_FEE_PRIVATE_KEY",
  "EXECUTOR_MAX_CYCLES",
  "EXECUTOR_MIN_MARGIN",
  "EXECUTOR_INSTANCE_ID",
  "EXECUTOR_SUPPORTED_POLICIES",
  "PUBLIC_APP_ORIGIN",
  "WEBHOOK_ENCRYPTION_KEY",
  "ERROR_TRACKING_DSN",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "RELEASE_VERSION",
  "RELEASE_REVISION",
] as const;

export const FORBIDDEN_USER_SECRET_KEYS = [
  "USER_MNEMONIC",
  "USER_PRIVATE_KEY",
  "USER_SEED_PHRASE",
  "WALLET_EXPORT",
] as const;

const commonFields = {
  CKB_GENESIS_HASH: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a 32-byte hexadecimal hash"),
  CKB_INDEXER_URL: z.url(),
  CKB_RPC_URL: z.url(),
  DATABASE_URL: z.string().startsWith("postgresql://"),
  DAO_HARVEST_V2_MANIFEST_PATH: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !value.includes("\0"), "must be a valid path")
      .optional(),
  ),
  PUBLIC_APP_ORIGIN: z.url(),
  WEBHOOK_ENCRYPTION_KEY: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/, "must be a base64url-encoded 32-byte key"),
  ERROR_TRACKING_DSN: z.preprocess(
    (value) => (value === "" || value === "local-placeholder-disabled" ? undefined : value),
    z.url().optional(),
  ),
  EXECUTOR_LOCK_ARGS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^0x[0-9a-f]{40}$/, "must be canonical 20-byte secp256k1 lock arguments")
      .optional(),
  ),
  EXECUTOR_TRANSACTION_FEE: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/, "must be a canonical decimal shannon amount")
      .optional(),
  ),
  EXECUTOR_FEE_PRIVATE_KEY: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^0x[0-9a-f]{64}$/, "must be a canonical 32-byte private key")
      .optional(),
  ),
  EXECUTOR_MAX_CYCLES: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[1-9][0-9]*$/, "must be a positive canonical decimal cycle count")
      .optional(),
  ),
  EXECUTOR_MIN_MARGIN: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/, "must be a canonical decimal shannon amount")
      .optional(),
  ),
  EXECUTOR_INSTANCE_ID: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "must be a stable lowercase identifier")
      .optional(),
  ),
  EXECUTOR_SUPPORTED_POLICIES: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .max(64)
      .regex(
        /^(?:deadline|recurring|dao-harvest|dao-harvest-v2)(?:,(?:deadline|recurring|dao-harvest|dao-harvest-v2)){0,3}$/,
      )
      .refine((value) => new Set(value.split(",")).size === value.split(",").length, {
        message: "supported executor policies must be unique",
      })
      .optional(),
  ),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    (value) => (value === "" || value === "local-placeholder-disabled" ? undefined : value),
    z.url().optional(),
  ),
  OTEL_EXPORTER_OTLP_HEADERS: z.preprocess(
    (value) => (value === "" || value === "local-placeholder-disabled" ? undefined : value),
    z.string().max(4096).optional(),
  ),
  RELEASE_VERSION: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
      .optional(),
  ),
  RELEASE_REVISION: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .optional(),
  ),
  REDIS_URL: z
    .string()
    .refine(
      (value) => value.startsWith("redis://") || value.startsWith("rediss://"),
      "must use redis:// or rediss://",
    ),
};

const localEnvironmentSchema = z.strictObject({
  ...commonFields,
  AUTOMATA_PROFILE: z.literal("local"),
  CKB_NETWORK: z.literal("ckb_dev"),
});

const testEnvironmentSchema = z.strictObject({
  ...commonFields,
  AUTOMATA_PROFILE: z.literal("test"),
  CKB_NETWORK: z.literal("ckb_dev"),
});

const testnetPreviewEnvironmentSchema = z.strictObject({
  ...commonFields,
  AUTOMATA_PROFILE: z.literal("testnet-preview"),
  CKB_NETWORK: z.literal("ckb_testnet"),
});

const testnetPublicEnvironmentSchema = z.strictObject({
  ...commonFields,
  AUTOMATA_PROFILE: z.literal("testnet-public"),
  CKB_NETWORK: z.literal("ckb_testnet"),
});

export const EnvironmentSchema = z.discriminatedUnion("AUTOMATA_PROFILE", [
  localEnvironmentSchema,
  testEnvironmentSchema,
  testnetPreviewEnvironmentSchema,
  testnetPublicEnvironmentSchema,
]);

export type AutomataEnvironment = z.infer<typeof EnvironmentSchema>;

export function parseEnvironment(
  input: Readonly<Record<string, string | undefined>>,
): AutomataEnvironment {
  const forbiddenKey = FORBIDDEN_USER_SECRET_KEYS.find((key) => Boolean(input[key]?.trim()));
  if (forbiddenKey) {
    throw new Error(`${forbiddenKey} is forbidden in application processes`);
  }

  const candidate = Object.fromEntries(AUTOMATA_ENV_KEYS.map((key) => [key, input[key]]));
  return EnvironmentSchema.parse(candidate);
}
