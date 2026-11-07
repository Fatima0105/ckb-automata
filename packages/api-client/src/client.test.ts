import assert from "node:assert/strict";
import test from "node:test";

import { ApiClientError, createApiClient } from "./client.ts";

const jsonHeaders = { "content-type": "application/json" };

test("invokes browser fetch with the global receiver", async () => {
  let calls = 0;
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async function fetchWithReceiver(this: unknown) {
      assert.equal(this, globalThis);
      calls += 1;
      return new Response(JSON.stringify({ network: "ckb_testnet" }), {
        headers: jsonHeaders,
      });
    },
  });

  await client.network();

  assert.equal(calls, 1);
});

test("encodes path and query parameters", async () => {
  const requests: Request[] = [];
  const client = createApiClient({
    baseUrl: "https://api.example.test/root/",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({ items: [], page: { limit: 20, nextCursor: null, totalItems: 0 } }),
        {
          headers: jsonHeaders,
        },
      );
    },
  });

  await client.listJobEvents("job/value", { cursor: "next value", limit: 20, source: "indexed" });
  await client.listActivity({ jobId: "job/value", limit: 10, source: "operational" });
  await client.getTransactionProgress("tx/value", {
    submittedAt: "2026-09-24T10:00:00.000Z",
    previousBlockNumber: "100",
    previousBlockHash: `0x${"12".repeat(32)}`,
  });
  await client.getJobTerms("job/value");

  assert.equal(requests.length, 4);
  assert.equal(
    requests[0]?.url,
    "https://api.example.test/root/v1/jobs/job%2Fvalue/events?cursor=next+value&limit=20&source=indexed",
  );
  assert.equal(requests[0]?.method, "GET");
  assert.equal(
    requests[1]?.url,
    "https://api.example.test/root/v1/activity?jobId=job%2Fvalue&limit=10&source=operational",
  );
  assert.equal(requests[1]?.method, "GET");
  assert.equal(
    requests[2]?.url,
    `https://api.example.test/root/v1/transactions/tx%2Fvalue/progress?submittedAt=2026-09-24T10%3A00%3A00.000Z&previousBlockNumber=100&previousBlockHash=0x${"12".repeat(32)}`,
  );
  assert.equal(requests[2]?.method, "GET");
  assert.equal(requests[3]?.url, "https://api.example.test/root/v1/jobs/job%2Fvalue/terms");
  assert.equal(requests[3]?.method, "GET");
});

test("serializes generated transaction request bodies", async () => {
  let request: Request | undefined;
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(JSON.stringify({ intentHash: "0x01" }), { headers: jsonHeaders });
    },
  });
  const body = {
    amount: "100",
    creatorNonce: `0x${"01".repeat(32)}`,
    firstNotBefore: "200",
    intervalBlocks: "10",
    lockResolutions: [
      {
        codeHash: `0x${"04".repeat(32)}`,
        hashType: "type",
        args: "0x05",
      },
    ],
    ownerLockHash: `0x${"02".repeat(32)}`,
    recipientLockHash: `0x${"03".repeat(32)}`,
    reward: "20",
    totalRuns: "3",
  } as const;

  await client.createRecurringJob(body);

  assert.equal(request?.method, "POST");
  assert.equal(request?.headers.get("content-type"), "application/json");
  assert.deepEqual(await request?.json(), body);
});

test("registers a submitted DAO harvest by transaction hash", async () => {
  let request: Request | undefined;
  const transactionHash = `0x${"ab".repeat(32)}`;
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return Response.json({ transactionHash });
    },
  });

  await client.registerDaoHarvestSetup({ transactionHash });

  assert.equal(request?.url, "https://api.example.test/v1/dao-harvest/register-setup");
  assert.equal(request?.method, "POST");
  assert.deepEqual(await request?.json(), { transactionHash });
});

test("reads V2 harvest projections without changing V1 routes", async () => {
  let urls: string[] = [];
  const client = createApiClient({
    baseUrl: "https://api.example.test",
    fetch: async (input) => {
      urls = [...urls, String(input)];
      return new Response(JSON.stringify({ items: [], page: { limit: 20, nextCursor: null } }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  await client.listDaoHarvestV2({ limit: 20 });
  await client.getDaoHarvestV2(`0x${"a".repeat(64)}`);
  await client.getDaoHarvestV2Quote(`0x${"a".repeat(64)}`);
  await client.buildDaoHarvestV2("sweep", { jobId: `0x${"a".repeat(64)}` });
  await client.registerDaoHarvestV2Setup({ transactionHash: `0x${"b".repeat(64)}` });
  assert.deepEqual(urls, [
    "https://api.example.test/v1/dao-harvest-v2?limit=20",
    `https://api.example.test/v1/dao-harvest-v2/0x${"a".repeat(64)}`,
    `https://api.example.test/v1/dao-harvest-v2/0x${"a".repeat(64)}/quote`,
    "https://api.example.test/v1/dao-harvest-v2/sweep",
    "https://api.example.test/v1/dao-harvest-v2/register-setup",
  ]);
});

test("revokes settings sessions with bearer authentication", async () => {
  const requests: Array<{ headers: Headers; method: string; url: string }> = [];
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async (input, init) => {
      requests.push({
        headers: new Headers(init?.headers),
        method: init?.method ?? "GET",
        url: String(input),
      });
      return Response.json({ revokedAt: "2026-09-24T12:00:00.000Z" });
    },
  });

  await client.revokeAuthSession("session-token");

  assert.equal(requests[0]?.url, "https://api.example.test/v1/auth/session");
  assert.equal(requests[0]?.method, "DELETE");
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer session-token");
});

test("lists and manages verified external operators", async () => {
  const requests: Request[] = [];
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(requests.length === 1 ? { operators: [] } : { removed: true });
    },
  });

  await client.listOperators({ service: "recurring" });
  await client.registerOperator("operator-session", { endpoint: "https://operator.example" });
  await client.removeOperator("operator-session");

  assert.equal(requests[0]?.url, "https://api.example.test/v1/operators?service=recurring");
  assert.equal(requests[1]?.method, "PUT");
  assert.equal(requests[1]?.headers.get("authorization"), "Bearer operator-session");
  assert.deepEqual(await requests[1]?.json(), { endpoint: "https://operator.example" });
  assert.equal(requests[2]?.method, "DELETE");
  assert.equal(requests[2]?.headers.get("authorization"), "Bearer operator-session");
});

test("exposes structured API failures", async () => {
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async () =>
      new Response(JSON.stringify({ error: "stale_quote" }), {
        headers: jsonHeaders,
        status: 409,
      }),
  });

  await assert.rejects(
    () => client.getJobQuote("job"),
    (error: unknown) => {
      assert.ok(error instanceof ApiClientError);
      assert.equal(error.status, 409);
      assert.deepEqual(error.body, { error: "stale_quote" });
      return true;
    },
  );
});

test("sends opaque sessions only in the authorization header", async () => {
  let request: Request | undefined;
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return new Response(
        JSON.stringify({
          expiresAt: "2026-09-23T00:00:00.000Z",
          network: "ckb_dev",
          ownerLockHash: `0x${"01".repeat(32)}`,
          scope: ["off_chain_settings"],
        }),
        { headers: jsonHeaders },
      );
    },
  });

  await client.getAuthSession("A".repeat(43));

  assert.equal(request?.headers.get("authorization"), `Bearer ${"A".repeat(43)}`);
  assert.equal(new URL(request?.url ?? "https://invalid.test").search, "");
});

test("updates and resets preferences with generated request types and session scope", async () => {
  const requests: Request[] = [];
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(
        JSON.stringify({
          channels: {
            browser: { enabled: true, eventTypes: ["ready"] },
            email: { address: null, enabled: false, eventTypes: [] },
          },
          network: "ckb_dev",
          ownerLockHash: `0x${"01".repeat(32)}`,
        }),
        { headers: jsonHeaders },
      );
    },
  });
  const body = {
    browser: { enabled: true, eventTypes: ["ready"] },
    email: { enabled: false, eventTypes: [] },
  } as const;

  await client.updateNotificationPreferences("B".repeat(43), body);
  await client.resetNotificationPreferences("B".repeat(43));

  assert.equal(requests[0]?.method, "PUT");
  assert.equal(requests[0]?.headers.get("authorization"), `Bearer ${"B".repeat(43)}`);
  assert.deepEqual(await requests[0]?.json(), body);
  assert.equal(requests[1]?.method, "DELETE");
  assert.equal(requests[1]?.headers.get("authorization"), `Bearer ${"B".repeat(43)}`);
});

test("registers, updates, and replays webhooks with owner sessions", async () => {
  const requests: Request[] = [];
  const client = createApiClient({
    baseUrl: "https://api.example.test/",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ id: "delivery" }), { headers: jsonHeaders });
    },
  });
  const session = "C".repeat(43);
  await client.registerWebhook(session, {
    endpoint: "https://hooks.example.test/automata",
    eventTypes: ["confirmed"],
  });
  await client.updateWebhook(session, "subscription/value", { enabled: false });
  await client.replayWebhookDelivery(session, "subscription/value", "delivery/value");

  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.headers.get("authorization"), `Bearer ${session}`);
  assert.deepEqual(await requests[0]?.json(), {
    endpoint: "https://hooks.example.test/automata",
    eventTypes: ["confirmed"],
  });
  assert.equal(requests[1]?.method, "PATCH");
  assert.equal(requests[1]?.url, "https://api.example.test/v1/webhooks/subscription%2Fvalue");
  assert.equal(
    requests[2]?.url,
    "https://api.example.test/v1/webhooks/subscription%2Fvalue/deliveries/delivery%2Fvalue/replay",
  );
});
