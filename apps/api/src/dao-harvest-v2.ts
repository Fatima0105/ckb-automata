import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ApiNotFoundResponse,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  type SchemaObject,
} from "@nestjs/swagger";
import { createHash } from "node:crypto";
import { and, desc, eq, lt, or } from "drizzle-orm";

import type { AutomataDatabase } from "./database/client.ts";
import { daoHarvestV2Jobs } from "./database/schema.ts";

const HASH = /^0x[0-9a-f]{64}$/;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export interface DaoHarvestV2ReadModel {
  readonly version: 2;
  readonly jobId: string;
  readonly ownerLockHash: string;
  readonly payoutLockHash: string;
  readonly payloadHash: string;
  readonly state: string;
  readonly progress: { readonly cycle: string; readonly totalCycles: string };
  readonly protectedAmount: string;
  readonly compensation: {
    readonly cellAmount: string | null;
    readonly availableToWithdraw: string | null;
  };
  readonly cells: {
    readonly job: unknown;
    readonly daoVault: unknown;
    readonly compensation: unknown;
  };
  readonly prepareCredit: unknown;
  readonly operatorWindow: unknown;
  readonly serviceSettlement: unknown;
  readonly evidence: {
    readonly completeness: "complete" | "partial";
    readonly transactionStatus: string;
    readonly canonical: boolean;
    readonly blockNumber: string;
    readonly blockHash: string;
    readonly transactionHash: string;
  };
  readonly updatedAt: string;
}

export interface DaoHarvestV2ListResponse {
  readonly items: readonly DaoHarvestV2ReadModel[];
  readonly pendingItems: readonly DaoHarvestV2PendingReadModel[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
}

export interface DaoHarvestV2PendingReadModel {
  readonly transactionHash: string;
  readonly submittedAt: string;
  readonly status: "submitting" | "confirming";
  readonly lastKnownStatus: string;
}

export interface DaoHarvestV2QuoteReadModel {
  readonly quoteId: string;
  readonly jobId: string;
  readonly state: string;
  readonly protectedAmount: string;
  readonly compensation: DaoHarvestV2ReadModel["compensation"];
  readonly serviceSettlement: unknown;
  readonly evidence: DaoHarvestV2ReadModel["evidence"];
}

export type DaoHarvestV2BuildOperation = "setup" | "sweep" | "close" | "rotate" | "recover";
export interface DaoHarvestV2UnsignedBuild {
  readonly version: 2;
  readonly jobId: string;
  readonly operation: DaoHarvestV2BuildOperation;
  readonly transaction: unknown;
  readonly intentHash: string;
  readonly payloadHash: string;
  readonly progressHash: string;
  readonly prepareCreditHash: string;
  readonly review: {
    readonly originalAmount: string;
    readonly expectedCompensation: string;
    readonly completedWorkCharges: {
      readonly prepare: string;
      readonly claim: string;
      readonly maximumTotal: string;
    };
    readonly maximumNetworkFee: string;
    readonly recoverableReserve: string;
    readonly accumulatedCompensation: string;
    readonly totalLockedAmount: string;
    readonly notes: readonly string[];
  };
  readonly completion: {
    readonly requiredInputCount: number;
    readonly requiredOutputCount: number;
    readonly requiredInputCapacity: string;
    readonly maximumFee: string;
    readonly allowedFundingLockHashes: readonly string[];
  };
}

export interface DaoHarvestV2MutationAdapter {
  build(operation: DaoHarvestV2BuildOperation, body: unknown): Promise<DaoHarvestV2UnsignedBuild>;
  registerSetup(transactionHash: string): Promise<DaoHarvestV2PendingReadModel>;
}

export interface DaoHarvestV2PendingProvider {
  list(): Promise<readonly DaoHarvestV2PendingReadModel[]>;
}

export interface StoredDaoHarvestV2Submission {
  readonly transactionHash: string;
  readonly submittedAt: Date;
  readonly lastKnownStatus: string;
}

export interface DaoHarvestV2PendingSource {
  list(): Promise<readonly StoredDaoHarvestV2Submission[]>;
  status(transactionHash: string): Promise<string | undefined>;
}

export class DaoHarvestV2PendingService implements DaoHarvestV2PendingProvider {
  readonly #source: DaoHarvestV2PendingSource;

  constructor(source: DaoHarvestV2PendingSource) {
    this.#source = source;
  }

  async list(): Promise<readonly DaoHarvestV2PendingReadModel[]> {
    const submissions = await this.#source.list();
    const items = await Promise.all(
      submissions.map(async (submission) => {
        let observed: string | undefined;
        try {
          observed = await this.#source.status(hash(submission.transactionHash, "transactionHash"));
        } catch {
          observed = undefined;
        }
        const lastKnownStatus = observed ?? submission.lastKnownStatus;
        if (["confirmed", "conflicted", "dropped"].includes(lastKnownStatus)) return undefined;
        return Object.freeze({
          transactionHash: submission.transactionHash,
          submittedAt: submission.submittedAt.toISOString(),
          status:
            lastKnownStatus === "submitted" ? ("submitting" as const) : ("confirming" as const),
          lastKnownStatus,
        });
      }),
    );
    return Object.freeze(items.filter((item) => item !== undefined));
  }
}

type Row = typeof daoHarvestV2Jobs.$inferSelect;

function hash(value: unknown, name: string): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw invalidQuery(`${name} must be a lowercase 32-byte hash`);
  }
  return value;
}

function invalidQuery(message: string): BadRequestException {
  return new BadRequestException({
    status: "invalid_request",
    code: "INVALID_DAO_HARVEST_V2_QUERY",
    message,
  });
}

function pageLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw invalidQuery("limit must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_LIMIT) {
    throw invalidQuery(`limit must not exceed ${MAX_LIMIT}`);
  }
  return parsed;
}

function cursor(value: unknown): { readonly block: string; readonly jobId: string } | null {
  if (value === undefined) return null;
  if (typeof value !== "string") throw invalidQuery("cursor is invalid");
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded))
      throw new Error();
    const record = decoded as Record<string, unknown>;
    if (
      typeof record["block"] !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(record["block"]) ||
      typeof record["jobId"] !== "string" ||
      !HASH.test(record["jobId"])
    ) {
      throw new Error();
    }
    return { block: record["block"], jobId: record["jobId"] };
  } catch {
    throw invalidQuery("cursor is invalid");
  }
}

function encodeCursor(row: Row): string {
  return Buffer.from(
    JSON.stringify({ block: row.observedBlockNumber, jobId: row.jobId }),
    "utf8",
  ).toString("base64url");
}

function readModel(row: Row): DaoHarvestV2ReadModel {
  return Object.freeze({
    version: 2 as const,
    jobId: row.jobId,
    ownerLockHash: row.ownerLockHash,
    payoutLockHash: row.payoutLockHash,
    payloadHash: row.payloadHash,
    state: row.lifecycleState,
    progress: Object.freeze({ cycle: row.cycleIndex, totalCycles: row.totalCycles }),
    protectedAmount: row.principalCapacity,
    compensation: Object.freeze({
      cellAmount: row.compensationCapacity,
      availableToWithdraw: row.accumulatedCompensation,
    }),
    cells: Object.freeze({
      job: row.jobOutpoint,
      daoVault: row.vaultOutpoint,
      compensation: row.compensationOutpoint,
    }),
    prepareCredit: row.prepareCredit,
    operatorWindow: row.operatorWindow,
    serviceSettlement: row.serviceSettlement,
    evidence: Object.freeze({
      completeness: row.projectionCompleteness as "complete" | "partial",
      transactionStatus: row.canonicalTxStatus,
      canonical: row.canonical,
      blockNumber: row.observedBlockNumber,
      blockHash: row.observedBlockHash,
      transactionHash: row.observedTransactionHash,
    }),
    updatedAt: row.updatedAt.toISOString(),
  });
}

export class DaoHarvestV2ReadService {
  readonly #database: AutomataDatabase;
  readonly #network: string;
  readonly #pending: DaoHarvestV2PendingProvider | undefined;

  constructor(database: AutomataDatabase, network: string, pending?: DaoHarvestV2PendingProvider) {
    this.#database = database;
    this.#network = network;
    this.#pending = pending;
  }

  async list(query: {
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<DaoHarvestV2ListResponse> {
    const limit = pageLimit(query.limit);
    const pageCursor = cursor(query.cursor);
    const conditions = [eq(daoHarvestV2Jobs.networkId, this.#network)];
    if (pageCursor) {
      conditions.push(
        or(
          lt(daoHarvestV2Jobs.observedBlockNumber, pageCursor.block),
          and(
            eq(daoHarvestV2Jobs.observedBlockNumber, pageCursor.block),
            lt(daoHarvestV2Jobs.jobId, pageCursor.jobId),
          ),
        )!,
      );
    }
    const rows = await this.#database
      .select()
      .from(daoHarvestV2Jobs)
      .where(and(...conditions))
      .orderBy(desc(daoHarvestV2Jobs.observedBlockNumber), desc(daoHarvestV2Jobs.jobId))
      .limit(limit + 1);
    const selected = rows.slice(0, limit);
    return Object.freeze({
      items: Object.freeze(selected.map(readModel)),
      pendingItems: Object.freeze(pageCursor === null ? ((await this.#pending?.list()) ?? []) : []),
      page: Object.freeze({
        limit,
        nextCursor: rows.length > limit && selected.at(-1) ? encodeCursor(selected.at(-1)!) : null,
      }),
    });
  }

  async detail(jobIdValue: string): Promise<DaoHarvestV2ReadModel> {
    const jobId = hash(jobIdValue, "jobId");
    const [row] = await this.#database
      .select()
      .from(daoHarvestV2Jobs)
      .where(and(eq(daoHarvestV2Jobs.networkId, this.#network), eq(daoHarvestV2Jobs.jobId, jobId)))
      .limit(1);
    if (!row) throw new NotFoundException("DAO harvest V2 automation was not found");
    return readModel(row);
  }

  async quote(jobId: string): Promise<DaoHarvestV2QuoteReadModel> {
    const item = await this.detail(jobId);
    const body = {
      jobId: item.jobId,
      state: item.state,
      protectedAmount: item.protectedAmount,
      compensation: item.compensation,
      serviceSettlement: item.serviceSettlement,
      evidence: item.evidence,
    };
    return Object.freeze({
      quoteId: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
      ...body,
    });
  }
}

export class DaoHarvestV2MutationService {
  readonly #adapter: DaoHarvestV2MutationAdapter | undefined;

  constructor(adapter?: DaoHarvestV2MutationAdapter) {
    this.#adapter = adapter;
  }

  build(operation: DaoHarvestV2BuildOperation, body: unknown): Promise<DaoHarvestV2UnsignedBuild> {
    if (!this.#adapter) {
      throw new ServiceUnavailableException("DAO harvest V2 transaction building is not deployed");
    }
    return this.#adapter.build(operation, body);
  }

  registerSetup(body: unknown): Promise<DaoHarvestV2PendingReadModel> {
    if (!this.#adapter) {
      throw new ServiceUnavailableException(
        "DAO harvest V2 submission registration is not deployed",
      );
    }
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !("transactionHash" in body)
    ) {
      throw invalidQuery("submission must contain only transactionHash");
    }
    const transactionHash = hash(
      (body as Record<string, unknown>)["transactionHash"],
      "transactionHash",
    );
    return this.#adapter.registerSetup(transactionHash);
  }
}

export class DaoHarvestV2Controller {
  readonly #reads: DaoHarvestV2ReadService;
  readonly #mutations: DaoHarvestV2MutationService;

  constructor(reads: DaoHarvestV2ReadService, mutations: DaoHarvestV2MutationService) {
    this.#reads = reads;
    this.#mutations = mutations;
  }

  list(query: {
    readonly cursor?: unknown;
    readonly limit?: unknown;
  }): Promise<DaoHarvestV2ListResponse> {
    return this.#reads.list(query);
  }

  detail(jobId: string): Promise<DaoHarvestV2ReadModel> {
    return this.#reads.detail(jobId);
  }

  quote(jobId: string): Promise<DaoHarvestV2QuoteReadModel> {
    return this.#reads.quote(jobId);
  }

  setup(body: unknown): Promise<DaoHarvestV2UnsignedBuild> {
    return this.#mutations.build("setup", body);
  }

  sweep(body: unknown): Promise<DaoHarvestV2UnsignedBuild> {
    return this.#mutations.build("sweep", body);
  }

  close(body: unknown): Promise<DaoHarvestV2UnsignedBuild> {
    return this.#mutations.build("close", body);
  }

  rotate(body: unknown): Promise<DaoHarvestV2UnsignedBuild> {
    return this.#mutations.build("rotate", body);
  }

  recover(body: unknown): Promise<DaoHarvestV2UnsignedBuild> {
    return this.#mutations.build("recover", body);
  }

  registerSetup(body: unknown): Promise<DaoHarvestV2PendingReadModel> {
    return this.#mutations.registerSetup(body);
  }
}

const hashSchema: SchemaObject = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const decimalSchema: SchemaObject = { type: "string", pattern: "^(0|[1-9][0-9]*)$" };
const nullableDecimalSchema: SchemaObject = { ...decimalSchema, nullable: true };
const outPointSchema: SchemaObject = {
  type: "object",
  nullable: true,
  additionalProperties: true,
};
const compensationSchema: SchemaObject = {
  type: "object",
  required: ["cellAmount", "availableToWithdraw"],
  properties: {
    cellAmount: nullableDecimalSchema,
    availableToWithdraw: nullableDecimalSchema,
  },
};
const evidenceSchema: SchemaObject = {
  type: "object",
  required: [
    "completeness",
    "transactionStatus",
    "canonical",
    "blockNumber",
    "blockHash",
    "transactionHash",
  ],
  properties: {
    completeness: { type: "string", enum: ["complete", "partial"] },
    transactionStatus: { type: "string" },
    canonical: { type: "boolean" },
    blockNumber: decimalSchema,
    blockHash: hashSchema,
    transactionHash: hashSchema,
  },
};
const serviceSettlementSchema: SchemaObject = {
  type: "object",
  required: ["status", "preparePaid", "claimPaid", "lastOperation"],
  properties: {
    status: { type: "string", enum: ["complete", "partial"] },
    preparePaid: decimalSchema,
    claimPaid: decimalSchema,
    lastOperation: { type: "string" },
  },
};
const operatorWindowSchema: SchemaObject = {
  type: "object",
  nullable: true,
  additionalProperties: true,
};
const prepareCreditSchema: SchemaObject = {
  type: "object",
  nullable: true,
  additionalProperties: true,
};
const harvestV2Schema: SchemaObject = {
  type: "object",
  required: [
    "version",
    "jobId",
    "ownerLockHash",
    "payoutLockHash",
    "payloadHash",
    "state",
    "progress",
    "protectedAmount",
    "compensation",
    "cells",
    "prepareCredit",
    "operatorWindow",
    "serviceSettlement",
    "evidence",
    "updatedAt",
  ],
  properties: {
    version: { type: "integer", enum: [2] },
    jobId: hashSchema,
    ownerLockHash: hashSchema,
    payoutLockHash: hashSchema,
    payloadHash: hashSchema,
    state: { type: "string" },
    progress: {
      type: "object",
      required: ["cycle", "totalCycles"],
      properties: {
        cycle: decimalSchema,
        totalCycles: decimalSchema,
      },
    },
    protectedAmount: decimalSchema,
    compensation: compensationSchema,
    cells: {
      type: "object",
      required: ["job", "daoVault", "compensation"],
      properties: {
        job: outPointSchema,
        daoVault: outPointSchema,
        compensation: outPointSchema,
      },
    },
    prepareCredit: prepareCreditSchema,
    operatorWindow: operatorWindowSchema,
    serviceSettlement: serviceSettlementSchema,
    evidence: evidenceSchema,
    updatedAt: { type: "string", format: "date-time" },
  },
};

const pendingV2Schema: SchemaObject = {
  type: "object",
  required: ["transactionHash", "submittedAt", "status", "lastKnownStatus"],
  properties: {
    transactionHash: hashSchema,
    submittedAt: { type: "string", format: "date-time" },
    status: { type: "string", enum: ["submitting", "confirming"] },
    lastKnownStatus: { type: "string" },
  },
};

const quoteV2Schema: SchemaObject = {
  type: "object",
  required: [
    "quoteId",
    "jobId",
    "state",
    "protectedAmount",
    "compensation",
    "serviceSettlement",
    "evidence",
  ],
  properties: {
    quoteId: { type: "string", pattern: "^[0-9a-f]{64}$" },
    jobId: hashSchema,
    state: { type: "string" },
    protectedAmount: decimalSchema,
    compensation: compensationSchema,
    serviceSettlement: serviceSettlementSchema,
    evidence: evidenceSchema,
  },
};

const unsignedBuildV2Schema: SchemaObject = {
  type: "object",
  required: [
    "version",
    "jobId",
    "operation",
    "transaction",
    "intentHash",
    "payloadHash",
    "progressHash",
    "prepareCreditHash",
    "review",
    "completion",
  ],
  properties: {
    version: { type: "integer", enum: [2] },
    jobId: hashSchema,
    operation: { type: "string", enum: ["setup", "sweep", "close", "rotate", "recover"] },
    transaction: { type: "object", additionalProperties: true },
    intentHash: hashSchema,
    payloadHash: hashSchema,
    progressHash: hashSchema,
    prepareCreditHash: hashSchema,
    review: {
      type: "object",
      required: [
        "originalAmount",
        "expectedCompensation",
        "completedWorkCharges",
        "maximumNetworkFee",
        "recoverableReserve",
        "accumulatedCompensation",
        "totalLockedAmount",
        "notes",
      ],
      properties: {
        originalAmount: decimalSchema,
        expectedCompensation: decimalSchema,
        completedWorkCharges: {
          type: "object",
          required: ["prepare", "claim", "maximumTotal"],
          properties: {
            prepare: decimalSchema,
            claim: decimalSchema,
            maximumTotal: decimalSchema,
          },
        },
        maximumNetworkFee: decimalSchema,
        recoverableReserve: decimalSchema,
        accumulatedCompensation: decimalSchema,
        totalLockedAmount: decimalSchema,
        notes: { type: "array", items: { type: "string" } },
      },
    },
    completion: {
      type: "object",
      required: [
        "requiredInputCount",
        "requiredOutputCount",
        "requiredInputCapacity",
        "maximumFee",
        "allowedFundingLockHashes",
      ],
      properties: {
        requiredInputCount: { type: "integer", minimum: 0 },
        requiredOutputCount: { type: "integer", minimum: 0 },
        requiredInputCapacity: decimalSchema,
        maximumFee: decimalSchema,
        allowedFundingLockHashes: { type: "array", items: hashSchema },
      },
    },
  },
};

Injectable()(DaoHarvestV2ReadService);
Injectable()(DaoHarvestV2MutationService);
Injectable()(DaoHarvestV2PendingService);
Inject(DaoHarvestV2ReadService)(DaoHarvestV2Controller, undefined, 0);
Inject(DaoHarvestV2MutationService)(DaoHarvestV2Controller, undefined, 1);
Controller("dao-harvest-v2")(DaoHarvestV2Controller);
ApiTags("DAO harvest V2")(DaoHarvestV2Controller);

const listDescriptor = Object.getOwnPropertyDescriptor(DaoHarvestV2Controller.prototype, "list")!;
Get()(DaoHarvestV2Controller.prototype, "list", listDescriptor);
Query()(DaoHarvestV2Controller.prototype, "list", 0);
ApiOperation({ summary: "List chain-derived DAO harvest V2 projections" })(
  DaoHarvestV2Controller.prototype,
  "list",
  listDescriptor,
);
ApiQuery({ name: "cursor", required: false, type: String })(
  DaoHarvestV2Controller.prototype,
  "list",
  listDescriptor,
);
ApiQuery({ name: "limit", required: false, type: Number })(
  DaoHarvestV2Controller.prototype,
  "list",
  listDescriptor,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["items", "pendingItems", "page"],
    properties: {
      items: { type: "array", items: harvestV2Schema },
      pendingItems: { type: "array", items: pendingV2Schema },
      page: {
        type: "object",
        required: ["limit", "nextCursor"],
        properties: {
          limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
          nextCursor: { type: "string", nullable: true },
        },
      },
    },
  },
})(DaoHarvestV2Controller.prototype, "list", listDescriptor);

const detailDescriptor = Object.getOwnPropertyDescriptor(
  DaoHarvestV2Controller.prototype,
  "detail",
)!;
Get(":jobId")(DaoHarvestV2Controller.prototype, "detail", detailDescriptor);
Param("jobId")(DaoHarvestV2Controller.prototype, "detail", 0);
ApiOperation({ summary: "Read one chain-derived DAO harvest V2 projection" })(
  DaoHarvestV2Controller.prototype,
  "detail",
  detailDescriptor,
);
ApiParam({ name: "jobId", schema: { type: "string", pattern: "^0x[0-9a-f]{64}$" } })(
  DaoHarvestV2Controller.prototype,
  "detail",
  detailDescriptor,
);
ApiOkResponse({ schema: harvestV2Schema })(
  DaoHarvestV2Controller.prototype,
  "detail",
  detailDescriptor,
);
ApiNotFoundResponse({ description: "DAO harvest V2 automation not found" })(
  DaoHarvestV2Controller.prototype,
  "detail",
  detailDescriptor,
);

const quoteDescriptor = Object.getOwnPropertyDescriptor(DaoHarvestV2Controller.prototype, "quote")!;
Get(":jobId/quote")(DaoHarvestV2Controller.prototype, "quote", quoteDescriptor);
Param("jobId")(DaoHarvestV2Controller.prototype, "quote", 0);
ApiOperation({ summary: "Quote one canonical DAO harvest V2 snapshot" })(
  DaoHarvestV2Controller.prototype,
  "quote",
  quoteDescriptor,
);
ApiOkResponse({ schema: quoteV2Schema })(
  DaoHarvestV2Controller.prototype,
  "quote",
  quoteDescriptor,
);

for (const operation of ["setup", "sweep", "close", "rotate", "recover"] as const) {
  const descriptor = Object.getOwnPropertyDescriptor(DaoHarvestV2Controller.prototype, operation)!;
  Post(operation)(DaoHarvestV2Controller.prototype, operation, descriptor);
  Body()(DaoHarvestV2Controller.prototype, operation, 0);
  ApiOperation({ summary: `Build an unsigned DAO harvest V2 ${operation} transaction` })(
    DaoHarvestV2Controller.prototype,
    operation,
    descriptor,
  );
  ApiBody({ schema: { type: "object" } })(DaoHarvestV2Controller.prototype, operation, descriptor);
  ApiOkResponse({ schema: unsignedBuildV2Schema })(
    DaoHarvestV2Controller.prototype,
    operation,
    descriptor,
  );
}

const registerDescriptor = Object.getOwnPropertyDescriptor(
  DaoHarvestV2Controller.prototype,
  "registerSetup",
)!;
Post("register-setup")(DaoHarvestV2Controller.prototype, "registerSetup", registerDescriptor);
Body()(DaoHarvestV2Controller.prototype, "registerSetup", 0);
ApiOperation({ summary: "Register a submitted DAO harvest V2 setup" })(
  DaoHarvestV2Controller.prototype,
  "registerSetup",
  registerDescriptor,
);
ApiBody({
  schema: {
    type: "object",
    required: ["transactionHash"],
    additionalProperties: false,
    properties: { transactionHash: hashSchema },
  },
})(DaoHarvestV2Controller.prototype, "registerSetup", registerDescriptor);
ApiOkResponse({ schema: pendingV2Schema })(
  DaoHarvestV2Controller.prototype,
  "registerSetup",
  registerDescriptor,
);
