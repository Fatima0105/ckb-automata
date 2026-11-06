import assert from "node:assert/strict";
import test from "node:test";

import { ENVIRONMENT_PROFILES, parseEnvironment, type EnvironmentProfile } from "./environment.ts";

const GENESIS_HASH = `0x${"1".repeat(64)}`;

function validEnvironment(profile: EnvironmentProfile) {
  const isTestnet = profile.startsWith("testnet-");
  return {
    AUTOMATA_PROFILE: profile,
    CKB_NETWORK: isTestnet ? "ckb_testnet" : "ckb_dev",
    CKB_GENESIS_HASH: GENESIS_HASH,
    CKB_RPC_URL: isTestnet ? "https://testnet-rpc.example.invalid" : "http://127.0.0.1:8114",
    CKB_INDEXER_URL: isTestnet
      ? "https://testnet-indexer.example.invalid"
      : "http://127.0.0.1:8116",
    DATABASE_URL: "postgresql://automata:local@127.0.0.1:55432/automata",
    REDIS_URL: "redis://127.0.0.1:56379",
    PUBLIC_APP_ORIGIN: isTestnet ? "https://automata.example.invalid" : "http://127.0.0.1:3000",
    WEBHOOK_ENCRYPTION_KEY: "A".repeat(43),
  };
}

for (const profile of ENVIRONMENT_PROFILES) {
  test(`${profile} accepts its required network identity`, () => {
    const result = parseEnvironment(validEnvironment(profile));
    assert.equal(result.AUTOMATA_PROFILE, profile);
  });

  test(`${profile} rejects the other network identity`, () => {
    const input = validEnvironment(profile);
    input.CKB_NETWORK = input.CKB_NETWORK === "ckb_dev" ? "ckb_testnet" : "ckb_dev";
    assert.throws(() => parseEnvironment(input));
  });
}

test("a missing profile fails startup validation", () => {
  const input: Record<string, string | undefined> = validEnvironment("local");
  delete input["AUTOMATA_PROFILE"];
  assert.throws(() => parseEnvironment(input));
});

test("an unknown profile fails startup validation", () => {
  assert.throws(() =>
    parseEnvironment({
      ...validEnvironment("local"),
      AUTOMATA_PROFILE: "development",
    }),
  );
});

test("a mainnet identifier is never accepted", () => {
  assert.throws(() =>
    parseEnvironment({
      ...validEnvironment("testnet-public"),
      CKB_NETWORK: "ckb_mainnet",
    }),
  );
});

test("unrelated process values do not enter the parsed configuration", () => {
  const result = parseEnvironment({
    ...validEnvironment("test"),
    PATH: "ignored",
  });
  assert.equal("PATH" in result, false);
});

test("optional observability metadata is validated and disabled placeholders are ignored", () => {
  const disabled = parseEnvironment({
    ...validEnvironment("local"),
    ERROR_TRACKING_DSN: "local-placeholder-disabled",
    OTEL_EXPORTER_OTLP_ENDPOINT: "local-placeholder-disabled",
    OTEL_EXPORTER_OTLP_HEADERS: "local-placeholder-disabled",
  });
  assert.equal(disabled.ERROR_TRACKING_DSN, undefined);
  assert.equal(disabled.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.equal(disabled.OTEL_EXPORTER_OTLP_HEADERS, undefined);
  assert.throws(() =>
    parseEnvironment({ ...validEnvironment("local"), RELEASE_REVISION: "not-a-revision" }),
  );
});

test("executor fee-cell configuration is public, canonical, and lossless", () => {
  const configured = parseEnvironment({
    ...validEnvironment("local"),
    EXECUTOR_LOCK_ARGS: `0x${"12".repeat(20)}`,
    EXECUTOR_TRANSACTION_FEE: "1000000",
  });
  assert.equal(configured.EXECUTOR_LOCK_ARGS, `0x${"12".repeat(20)}`);
  assert.equal(configured.EXECUTOR_TRANSACTION_FEE, "1000000");
  assert.throws(() =>
    parseEnvironment({
      ...validEnvironment("local"),
      EXECUTOR_LOCK_ARGS: `0x${"AB".repeat(20)}`,
    }),
  );
  assert.throws(() =>
    parseEnvironment({
      ...validEnvironment("local"),
      EXECUTOR_TRANSACTION_FEE: "01",
    }),
  );
});

test("executor simulation limits and fee key are canonical and lossless", () => {
  const privateKey = `0x${"01".repeat(32)}`;
  const configured = parseEnvironment({
    ...validEnvironment("local"),
    EXECUTOR_FEE_PRIVATE_KEY: privateKey,
    EXECUTOR_MAX_CYCLES: "10000000",
    EXECUTOR_MIN_MARGIN: "5000000",
  });
  assert.equal(configured.EXECUTOR_FEE_PRIVATE_KEY, privateKey);
  assert.equal(configured.EXECUTOR_MAX_CYCLES, "10000000");
  assert.equal(configured.EXECUTOR_MIN_MARGIN, "5000000");

  for (const invalid of [
    { EXECUTOR_FEE_PRIVATE_KEY: `0x${"AB".repeat(32)}` },
    { EXECUTOR_MAX_CYCLES: "0" },
    { EXECUTOR_MAX_CYCLES: "01" },
    { EXECUTOR_MIN_MARGIN: "01" },
  ]) {
    assert.throws(() => parseEnvironment({ ...validEnvironment("local"), ...invalid }));
  }
});

test("executor identity and supported policies are explicit and bounded", () => {
  const configured = parseEnvironment({
    ...validEnvironment("testnet-public"),
    EXECUTOR_INSTANCE_ID: "operator-a",
    EXECUTOR_SUPPORTED_POLICIES: "deadline,recurring,dao-harvest,dao-harvest-v2",
  });
  assert.equal(configured.EXECUTOR_INSTANCE_ID, "operator-a");
  assert.equal(
    configured.EXECUTOR_SUPPORTED_POLICIES,
    "deadline,recurring,dao-harvest,dao-harvest-v2",
  );

  for (const invalid of [
    { EXECUTOR_INSTANCE_ID: "Operator A" },
    { EXECUTOR_SUPPORTED_POLICIES: "deadline,unknown" },
    { EXECUTOR_SUPPORTED_POLICIES: "deadline,deadline" },
    { EXECUTOR_SUPPORTED_POLICIES: "".padEnd(65, "x") },
  ]) {
    assert.throws(() => parseEnvironment({ ...validEnvironment("testnet-public"), ...invalid }));
  }
});

test("user signing material fails startup validation", () => {
  assert.throws(
    () =>
      parseEnvironment({
        ...validEnvironment("local"),
        USER_SEED_PHRASE: "never accepted",
      }),
    /USER_SEED_PHRASE is forbidden/,
  );
});
