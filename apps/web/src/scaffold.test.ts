import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

import { TESTNET_DEPLOYMENT_MANIFEST_SHA256, TESTNET_GENESIS_HASH } from "@ckb-automata/core";

import { parseWebEnvironment } from "./environment.ts";
import { createServerApiClient } from "./server-api.ts";

const appUrl = new URL("../app/", import.meta.url);

function routeFromPage(file: string): string {
  if (file === "page.tsx") return "/";
  const segments = file
    .replaceAll("\\", "/")
    .replace(/\/page\.tsx$/, "")
    .split("/")
    .filter((segment) => segment && !/^\(.+\)$/.test(segment))
    .map((segment) => (segment.startsWith("[") ? `:${segment.slice(1, -1)}` : segment));
  return `/${segments.join("/")}`;
}

test("App Router exposes every planned product route", async () => {
  const entries = (await readdir(appUrl, { recursive: true })).map((entry) =>
    entry.replaceAll("\\", "/"),
  );
  const routes = entries
    .filter((entry) => entry.endsWith("/page.tsx") || entry === "page.tsx")
    .map(routeFromPage)
    .toSorted();
  const productRoutes = routes.filter((route) => !route.startsWith("/fixtures/"));
  assert.deepEqual(productRoutes, [
    "/",
    "/activity",
    "/automations",
    "/automations/:jobId",
    "/automations/dao-harvest-v2/:jobId",
    "/automations/dao-harvest/:jobId",
    "/automations/new",
    "/automations/new/dao-harvest",
    "/automations/new/dao-harvest-v2",
    "/automations/new/deadline",
    "/automations/new/recurring",
    "/demo",
    "/how-it-works",
    "/limitations",
    "/research/nervdao",
    "/settings",
  ]);
  assert.ok(routes.includes("/fixtures/visual-system"));
  assert.ok(routes.includes("/fixtures/wallet-provider"));
  assert.ok(routes.includes("/fixtures/automation-dashboard"));
  assert.ok(routes.includes("/fixtures/setup-stepper"));
  assert.ok(routes.includes("/fixtures/transaction-review"));
  assert.ok(routes.includes("/fixtures/transaction-submission"));
  for (const boundary of [
    "error.tsx",
    "global-error.tsx",
    "loading.tsx",
    "(product)/error.tsx",
    "(product)/loading.tsx",
    "(setup)/error.tsx",
    "(setup)/loading.tsx",
  ]) {
    assert.ok(entries.includes(boundary), `${boundary} is missing`);
  }
});

test("Server Components do not import wallet code", async () => {
  const entries = (await readdir(appUrl, { recursive: true })).map((entry) =>
    entry.replaceAll("\\", "/"),
  );
  const serverComponents = entries.filter(
    (entry) => entry.endsWith(".tsx") && !entry.endsWith("error.tsx"),
  );
  for (const entry of serverComponents) {
    const source = await readFile(new URL(entry, appUrl), "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(?:connector-react|wallet)[^"']*["']/i);
  }
});

test("typed environment configures the generated API client and rejects unsafe values", () => {
  const input = {
    NEXT_PUBLIC_AUTOMATA_API_URL: "https://api.example.test/",
    NEXT_PUBLIC_AUTOMATA_SSE_URL: "https://api.example.test/",
    NEXT_PUBLIC_CKB_NETWORK: "testnet",
    NEXT_PUBLIC_CKB_GENESIS_HASH: TESTNET_GENESIS_HASH,
    NEXT_PUBLIC_DEPLOYMENT_MANIFEST_SHA256: TESTNET_DEPLOYMENT_MANIFEST_SHA256,
  };
  assert.deepEqual(parseWebEnvironment(input), {
    apiUrl: "https://api.example.test/",
    genesisHash: TESTNET_GENESIS_HASH,
    manifestSha256: TESTNET_DEPLOYMENT_MANIFEST_SHA256,
    network: "testnet",
    sseUrl: "https://api.example.test/",
  });
  assert.ok(createServerApiClient(input));
  assert.throws(
    () => parseWebEnvironment({ ...input, NEXT_PUBLIC_CKB_NETWORK: "mainnet" }),
    /must be testnet/,
  );
  assert.throws(
    () =>
      parseWebEnvironment({
        ...input,
        NEXT_PUBLIC_AUTOMATA_API_URL: "https://user:secret@api.example.test/",
      }),
    /HTTP\(S\) origin/,
  );
  assert.throws(
    () =>
      parseWebEnvironment({
        ...input,
        NEXT_PUBLIC_AUTOMATA_SSE_URL: "https://stream.example.test/",
      }),
    /origins must match/,
  );
  assert.throws(
    () =>
      parseWebEnvironment({
        ...input,
        NEXT_PUBLIC_CKB_GENESIS_HASH: `0x${"0".repeat(64)}`,
      }),
    /CKB Testnet/,
  );
});
