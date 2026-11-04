import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { AutomataMetrics } from "@ckb-automata/telemetry";

import { CkbClientError, createCkbClient } from "./ckb-client.ts";

const GENESIS_HASH = `0x${"11".repeat(32)}`;
const TIP_HASH = `0x${"22".repeat(32)}`;
const PARENT_HASH = `0x${"33".repeat(32)}`;
const LIVE_TX_HASH = `0x${"66".repeat(32)}`;

interface RpcRequest {
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params: readonly unknown[];
}

function respond(response: ServerResponse, request: RpcRequest, result: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ id: request.id, jsonrpc: "2.0", result }));
}

function respondError(response: ServerResponse, request: RpcRequest): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      id: request.id,
      jsonrpc: "2.0",
      error: { code: -32_000, message: "submission failed" },
    }),
  );
}

function tipHeader() {
  return {
    compact_target: "0x20010000",
    dao: `0x${"00".repeat(32)}`,
    epoch: "0x1000000000001",
    extra_hash: `0x${"44".repeat(32)}`,
    hash: TIP_HASH,
    nonce: `0x${"00".repeat(16)}`,
    number: "0x2a",
    parent_hash: PARENT_HASH,
    proposals_hash: `0x${"00".repeat(32)}`,
    timestamp: "0x1234",
    transactions_root: `0x${"55".repeat(32)}`,
    version: "0x0",
  };
}

async function openServer(
  handler: (request: RpcRequest, response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    await handler(JSON.parse(body) as RpcRequest, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock RPC did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function openBatchServer(
  handler: (request: readonly RpcRequest[], response: ServerResponse) => void | Promise<void>,
) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body) as unknown;
    if (!Array.isArray(payload)) throw new Error("mock batch RPC expected an array");
    await handler(payload as readonly RpcRequest[], response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock batch RPC did not bind");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function rpcBlock(number: number) {
  const header = tipHeader();
  return {
    extension: `0x${"00".repeat(32)}`,
    header: {
      ...header,
      hash: `0x${number.toString(16).padStart(64, "0")}`,
      number: `0x${number.toString(16)}`,
      parent_hash: `0x${(number - 1).toString(16).padStart(64, "0")}`,
    },
    proposals: [],
    transactions: [],
    uncles: [],
  };
}

test("CCC wrapper reads chain and indexer responses", async (context) => {
  const chain = await openServer((request, response) => {
    const result =
      request.method === "get_block_hash"
        ? GENESIS_HASH
        : request.method === "get_live_cell"
          ? {
              cell: {
                data: { content: "0x", hash: `0x${"00".repeat(32)}` },
                output: {
                  capacity: "0x174876e800",
                  lock: {
                    args: `0x${"77".repeat(20)}`,
                    code_hash: `0x${"88".repeat(32)}`,
                    hash_type: "type",
                  },
                  type: null,
                },
              },
              status: "live",
            }
          : tipHeader();
    respond(response, request, result);
  });
  const indexer = await openServer((request, response) => {
    if (request.method === "get_transactions") {
      respond(response, request, {
        last_cursor: "0xcursor",
        objects: [
          {
            block_number: "0x2a",
            cells: [["output", "0x0"]],
            tx_hash: LIVE_TX_HASH,
            tx_index: "0x1",
          },
        ],
      });
      return;
    }
    assert.equal(request.method, "get_indexer_tip");
    respond(response, request, { block_number: "0x29", block_hash: PARENT_HASH });
  });
  context.after(async () => Promise.all([chain.close(), indexer.close()]));
  const client = createCkbClient({
    rpcEndpoints: [chain.url],
    indexerEndpoints: [indexer.url],
    timeoutMs: 200,
    retryDelayMs: 0,
  });
  context.after(() => client.close());

  assert.equal(await client.getGenesisHash(), GENESIS_HASH);
  const header = await client.getTipHeader();
  assert.equal(header.number, 42n);
  assert.equal(header.hash, TIP_HASH);
  assert.deepEqual(await client.getIndexerTip(), {
    blockNumber: 41n,
    blockHash: PARENT_HASH,
  });
  const live = await client.getCellLive({ txHash: LIVE_TX_HASH, index: 0 });
  assert.equal(live?.outPoint.txHash, LIVE_TX_HASH);
  assert.equal(live?.cellOutput.capacity, 100_000_000_000n);
  const transactions = await client.findTransactionsPaged({
    script: {
      args: "0x",
      codeHash: GENESIS_HASH,
      hashType: "data1",
    },
    scriptType: "lock",
    scriptSearchMode: "exact",
    groupByTransaction: true,
  });
  assert.equal(transactions.lastCursor, "0xcursor");
  assert.deepEqual(transactions.transactions, [
    {
      blockNumber: 42n,
      cells: [{ cellIndex: 0n, isInput: false }],
      txHash: LIVE_TX_HASH,
      txIndex: 1n,
    },
  ]);
});

test("block batches validate unordered envelopes and restore requested order", async (context) => {
  const chain = await openBatchServer((requests, response) => {
    assert.deepEqual(
      requests.map(({ method, params }) => [method, params[0]]),
      [
        ["get_block_by_number", "0x29"],
        ["get_block_by_number", "0x2a"],
      ],
    );
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        { id: 1, jsonrpc: "2.0", result: rpcBlock(42) },
        { id: 0, jsonrpc: "2.0", result: rpcBlock(41) },
      ]),
    );
  });
  context.after(() => chain.close());
  const client = createCkbClient({
    rpcEndpoints: [chain.url],
    indexerEndpoints: [chain.url],
    timeoutMs: 200,
    safeReadAttempts: 1,
  });
  context.after(() => client.close());

  const blocks = await client.getBlocksByNumber([41n, 42n]);
  assert.deepEqual(
    blocks.map((block) => block?.header.number),
    [41n, 42n],
  );
});

test("block batches fail closed on duplicate or missing response ids", async (context) => {
  const chain = await openBatchServer((_requests, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify([
        { id: 0, jsonrpc: "2.0", result: rpcBlock(41) },
        { id: 0, jsonrpc: "2.0", result: rpcBlock(42) },
      ]),
    );
  });
  context.after(() => chain.close());
  const client = createCkbClient({
    rpcEndpoints: [chain.url],
    indexerEndpoints: [chain.url],
    timeoutMs: 200,
    safeReadAttempts: 1,
  });
  context.after(() => client.close());

  await assert.rejects(
    client.getBlocksByNumber([41n, 42n]),
    (error: unknown) => error instanceof CkbClientError && error.code === "CHAIN_READ_FAILED",
  );
});

test("client configuration rejects unsafe endpoints and retry bounds", () => {
  assert.throws(
    () =>
      createCkbClient({
        rpcEndpoints: ["file:///tmp/rpc"],
        indexerEndpoints: ["http://127.0.0.1:8116"],
      }),
    /unsupported protocol/,
  );
  assert.throws(
    () =>
      createCkbClient({
        rpcEndpoints: ["http://127.0.0.1:8114"],
        indexerEndpoints: ["http://127.0.0.1:8116"],
        safeReadAttempts: 0,
      }),
    /safeReadAttempts must be positive/,
  );
});

test("request timeout fails with a stable non-sensitive error", async (context) => {
  const hanging = await openServer(() => undefined);
  context.after(() => hanging.close());
  const metrics = new AutomataMetrics();
  const spans: string[] = [];
  const client = createCkbClient({
    rpcEndpoints: [hanging.url],
    indexerEndpoints: [hanging.url],
    timeoutMs: 25,
    safeReadAttempts: 1,
    metrics,
    telemetry: {
      withSpan: async (name, _attributes, operation) => {
        spans.push(name);
        return operation();
      },
    },
  });
  context.after(() => client.close());

  await assert.rejects(
    client.getGenesisHash(),
    (error: unknown) =>
      error instanceof CkbClientError &&
      error.code === "CHAIN_READ_FAILED" &&
      !error.message.includes(hanging.url),
  );
  assert.deepEqual(spans, ["ckb.rpc.get_block_hash"]);
  const rendered = await metrics.render();
  assert.match(rendered, /automata_rpc_errors_total\{endpoint="rpc",method="get_block_hash"\} 1/);
  assert.doesNotMatch(rendered, new RegExp(hanging.url.replaceAll("/", "\\/")));
});

test("malformed RPC success envelopes fail closed", async (context) => {
  const malformed = await openServer((request, response) => {
    respond(response, request, { number: "0x2a" });
  });
  context.after(() => malformed.close());
  const client = createCkbClient({
    rpcEndpoints: [malformed.url],
    indexerEndpoints: [malformed.url],
    timeoutMs: 100,
    safeReadAttempts: 1,
  });
  context.after(() => client.close());

  await assert.rejects(
    client.getTipHeader(),
    (error: unknown) => error instanceof CkbClientError && error.code === "CHAIN_READ_FAILED",
  );
});

test("failed endpoints rotate to the next configured CCC transport", async (context) => {
  let failedRequests = 0;
  let successfulRequests = 0;
  const failed = await openServer((_request, response) => {
    failedRequests += 1;
    response.destroy();
  });
  const healthy = await openServer((request, response) => {
    successfulRequests += 1;
    respond(response, request, GENESIS_HASH);
  });
  context.after(async () => Promise.all([failed.close(), healthy.close()]));
  const client = createCkbClient({
    rpcEndpoints: [failed.url, healthy.url],
    indexerEndpoints: [healthy.url],
    timeoutMs: 1_000,
    safeReadAttempts: 1,
  });
  context.after(() => client.close());

  assert.equal(await client.getGenesisHash(), GENESIS_HASH);
  assert.equal(await client.getGenesisHash(), GENESIS_HASH);
  assert.equal(failedRequests, 1);
  assert.equal(successfulRequests, 2);
});

test("transient safe-read failures retry without exposing endpoint details", async (context) => {
  let requests = 0;
  const transient = await openServer((request, response) => {
    requests += 1;
    if (requests === 1) response.destroy();
    else respond(response, request, GENESIS_HASH);
  });
  context.after(() => transient.close());
  const client = createCkbClient({
    rpcEndpoints: [transient.url],
    indexerEndpoints: [transient.url],
    timeoutMs: 100,
    safeReadAttempts: 2,
    retryDelayMs: 0,
  });
  context.after(() => client.close());

  assert.equal(await client.getGenesisHash(), GENESIS_HASH);
  assert.equal(requests, 2);
});

test("dry-run and status are readable while submission never falls back", async (context) => {
  let fallbackRequests = 0;
  const primary = await openServer((request, response) => {
    if (request.method === "test_tx_pool_accept") {
      respond(response, request, { cycles: "0x1" });
    } else if (request.method === "get_transaction") {
      respond(response, request, { transaction: null, tx_status: { status: "unknown" } });
    } else if (request.method === "send_transaction") {
      respondError(response, request);
    } else {
      respond(response, request, GENESIS_HASH);
    }
  });
  const fallback = await openServer((request, response) => {
    fallbackRequests += 1;
    respond(response, request, `0x${"99".repeat(32)}`);
  });
  context.after(async () => Promise.all([primary.close(), fallback.close()]));
  const client = createCkbClient({
    rpcEndpoints: [primary.url, fallback.url],
    indexerEndpoints: [primary.url],
    timeoutMs: 100,
    safeReadAttempts: 1,
  });
  context.after(() => client.close());

  assert.equal(await client.dryRun({}), 1n);
  assert.equal(await client.getTransactionStatus(GENESIS_HASH), undefined);
  await assert.rejects(
    client.send({}),
    (error: unknown) => error instanceof CkbClientError && error.code === "SUBMISSION_FAILED",
  );
  assert.equal(fallbackRequests, 0);
});
