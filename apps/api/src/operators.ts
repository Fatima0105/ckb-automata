import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Inject,
  Put,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from "@nestjs/swagger";
import { and, asc, eq } from "drizzle-orm";
import { Address, Script } from "@ckb-ccc/shell";

import type { AutomataEnvironment } from "@ckb-automata/config";

import type { AuthService } from "./auth.ts";
import type { AutomataDatabase } from "./database/client.ts";
import { operatorRegistrations } from "./database/schema.ts";

const HASH = /^0x[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ADDRESS = /^ckt1[0-9a-z]{20,124}$/;
const CKB_TESTNET_SECP256K1_BLAKE160_CODE_HASH =
  "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const OPERATOR_SERVICES = ["dao-harvest", "deadline", "recurring"] as const;
const MAX_RESPONSE_BYTES = 64 * 1024;
const PROBE_TIMEOUT_MS = 5_000;
const OFFLINE_FAILURES = 3;

export type OperatorService = (typeof OPERATOR_SERVICES)[number];

export interface PublicOperatorRegistration {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly lockHash: string;
  readonly services: readonly OperatorService[];
  readonly status: "active";
}

export interface HostedOperatorInfo extends PublicOperatorRegistration {
  readonly endpoint: string;
  readonly genesisHash: string;
  readonly manifests: {
    readonly harvest: string | null;
    readonly payments: string | null;
  };
  readonly network: string;
  readonly version: string;
}

export interface OperatorCompatibility {
  readonly genesisHash: string;
  readonly harvestManifestHashes: ReadonlySet<string>;
  readonly network: string;
  readonly paymentManifestSha256?: string;
}

export interface OperatorProbe {
  read(endpoint: string): Promise<unknown>;
}

export interface StoredOperatorRegistration extends Omit<HostedOperatorInfo, "status"> {
  readonly consecutiveFailures: number;
  readonly createdAt: Date;
  readonly lastCheckedAt: Date;
  readonly lastSeenAt: Date;
  readonly status: "active" | "offline";
  readonly updatedAt: Date;
}

export interface OperatorRegistryRepository {
  list(network: string): Promise<readonly StoredOperatorRegistration[]>;
  remove(network: string, lockHash: string): Promise<boolean>;
  save(
    network: string,
    info: HostedOperatorInfo,
    checkedAt: Date,
  ): Promise<StoredOperatorRegistration>;
  setFailure(network: string, lockHash: string, failures: number, checkedAt: Date): Promise<void>;
}

function invalid(message: string): BadRequestException {
  return new BadRequestException({
    status: "invalid_request",
    code: "INVALID_OPERATOR_REGISTRATION",
    message,
  });
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalid(`${name} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw invalid(`${name} must be a string`);
  return value;
}

function nullableSha256(value: unknown, name: string): string | null {
  if (value === null) return null;
  const parsed = string(value, name);
  if (!SHA256.test(parsed)) throw invalid(`${name} must be a lowercase SHA-256 digest`);
  return parsed;
}

export function normalizeOperatorEndpoint(value: unknown): string {
  const raw = string(value, "endpoint");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("endpoint must be a valid public HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    isIP(url.hostname) !== 0 ||
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname.endsWith(".local") ||
    url.hostname.endsWith(".internal")
  ) {
    throw invalid("endpoint must be a public HTTPS origin using a DNS hostname");
  }
  return url.origin;
}

function isPublicIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIp(address: string, family: number): boolean {
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) return isPublicIpv4(normalized.slice(7));
  const first = Number.parseInt(normalized.split(":")[0] ?? "", 16);
  return Number.isInteger(first) && first >= 0x2000 && first <= 0x3fff;
}

async function readPinnedHttpsJson(endpoint: string): Promise<unknown> {
  const origin = new URL(endpoint);
  const addresses = await lookup(origin.hostname, { all: true, verbatim: true });
  if (
    addresses.length === 0 ||
    addresses.some(({ address, family }) => !isPublicIp(address, family))
  ) {
    throw new Error("operator endpoint does not resolve exclusively to public addresses");
  }
  const selected = addresses[0]!;
  const url = new URL("/operator-info", origin);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        headers: { accept: "application/json", "user-agent": "CKAutomata-Operator-Registry/1" },
        lookup: (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
        method: "GET",
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`operator endpoint returned HTTP ${response.statusCode ?? 0}`));
          return;
        }
        const contentType = response.headers["content-type"] ?? "";
        if (!contentType.toLowerCase().startsWith("application/json")) {
          response.resume();
          reject(new Error("operator endpoint did not return JSON"));
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            request.destroy(new Error("operator endpoint response is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
          } catch {
            reject(new Error("operator endpoint returned invalid JSON"));
          }
        });
      },
    );
    request.setTimeout(PROBE_TIMEOUT_MS, () =>
      request.destroy(new Error("operator endpoint timed out")),
    );
    request.once("error", reject);
    request.end();
  });
}

export const publicOperatorProbe: OperatorProbe = Object.freeze({ read: readPinnedHttpsJson });

function parseServices(value: unknown): readonly OperatorService[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > OPERATOR_SERVICES.length) {
    throw invalid("services must contain one to three supported services");
  }
  const services = value.map((item) => string(item, "services item"));
  if (
    new Set(services).size !== services.length ||
    services.some((service) => !OPERATOR_SERVICES.includes(service as OperatorService))
  ) {
    throw invalid("services contains an unsupported or duplicate service");
  }
  return Object.freeze(services.toSorted() as OperatorService[]);
}

export function validateHostedOperatorInfo(
  value: unknown,
  endpoint: string,
  expectedLockHash: string,
  compatibility: OperatorCompatibility,
): HostedOperatorInfo {
  const item = record(value, "operator info");
  const identity = record(item["identity"], "identity");
  const identityLock = record(identity["lock"], "identity.lock");
  const manifests = record(item["manifests"], "manifests");
  const name = string(item["name"], "name").trim();
  const lockHash = string(identity["lockHash"], "identity.lockHash");
  const address = string(identity["address"], "identity.address");
  const lockCodeHash = string(identityLock["codeHash"], "identity.lock.codeHash");
  const lockHashType = string(identityLock["hashType"], "identity.lock.hashType");
  const lockArgs = string(identityLock["args"], "identity.lock.args");
  const network = string(item["network"], "network");
  const genesisHash = string(item["genesisHash"], "genesisHash");
  const version = string(item["version"], "version");
  const services = parseServices(item["services"]);
  const harvest = nullableSha256(manifests["harvest"], "manifests.harvest");
  const payments = nullableSha256(manifests["payments"], "manifests.payments");
  if (item["status"] !== "ready") throw invalid("operator endpoint is not ready");
  const hasControlCharacter = [...name].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
  if (name.length < 2 || name.length > 64 || hasControlCharacter) {
    throw invalid("operator name must contain 2 to 64 printable characters");
  }
  if (!HASH.test(lockHash) || lockHash !== expectedLockHash) {
    throw invalid("hosted operator identity does not match the authenticated lock");
  }
  if (!ADDRESS.test(address)) throw invalid("hosted operator address is not a CKB testnet address");
  if (
    lockCodeHash !== CKB_TESTNET_SECP256K1_BLAKE160_CODE_HASH ||
    lockHashType !== "type" ||
    !/^0x[0-9a-f]{40}$/.test(lockArgs)
  ) {
    throw invalid("hosted operator lock is not a CKB secp256k1 identity");
  }
  const advertisedLock = Script.from({
    codeHash: lockCodeHash,
    hashType: lockHashType,
    args: lockArgs,
  });
  if (
    advertisedLock.hash() !== lockHash ||
    new Address(advertisedLock, "ckt").toString() !== address
  ) {
    throw invalid("hosted operator address does not match its authenticated lock");
  }
  if (network !== compatibility.network || genesisHash !== compatibility.genesisHash) {
    throw invalid("hosted operator is connected to a different network");
  }
  if (!/^0\.[0-9]+\.[0-9]+$/.test(version)) throw invalid("operator version is unsupported");
  if (
    services.includes("dao-harvest") &&
    (harvest === null || !compatibility.harvestManifestHashes.has(harvest))
  ) {
    throw invalid("hosted operator uses an incompatible DAO Harvest manifest");
  }
  if (
    (services.includes("deadline") || services.includes("recurring")) &&
    (payments === null || payments !== compatibility.paymentManifestSha256)
  ) {
    throw invalid("hosted operator uses an incompatible payment manifest");
  }
  return Object.freeze({
    id: `registry:${lockHash}`,
    name,
    address,
    lockHash,
    endpoint,
    services,
    status: "active" as const,
    genesisHash,
    manifests: Object.freeze({ harvest, payments }),
    network,
    version,
  });
}

function publicRegistration(value: StoredOperatorRegistration): PublicOperatorRegistration {
  return Object.freeze({
    id: value.id,
    name: value.name,
    address: value.address,
    lockHash: value.lockHash,
    services: value.services,
    status: "active" as const,
  });
}

export class PostgresOperatorRegistryRepository implements OperatorRegistryRepository {
  readonly #database: AutomataDatabase;

  constructor(database: AutomataDatabase) {
    this.#database = database;
  }

  async list(network: string): Promise<readonly StoredOperatorRegistration[]> {
    const rows = await this.#database
      .select()
      .from(operatorRegistrations)
      .where(eq(operatorRegistrations.networkId, network))
      .orderBy(asc(operatorRegistrations.displayName), asc(operatorRegistrations.lockHash));
    return rows.map((row) =>
      Object.freeze({
        id: `registry:${row.lockHash}`,
        name: row.displayName,
        address: row.address,
        lockHash: row.lockHash,
        endpoint: row.endpoint,
        services: Object.freeze([...row.services] as OperatorService[]),
        status: row.status as "active" | "offline",
        genesisHash: "",
        manifests: Object.freeze({
          harvest: row.harvestManifestSha256,
          payments: row.paymentManifestSha256,
        }),
        network,
        version: "",
        consecutiveFailures: row.consecutiveFailures,
        createdAt: row.createdAt,
        lastCheckedAt: row.lastCheckedAt,
        lastSeenAt: row.lastSeenAt,
        updatedAt: row.updatedAt,
      }),
    );
  }

  async save(
    network: string,
    info: HostedOperatorInfo,
    checkedAt: Date,
  ): Promise<StoredOperatorRegistration> {
    const [row] = await this.#database
      .insert(operatorRegistrations)
      .values({
        networkId: network,
        lockHash: info.lockHash,
        displayName: info.name,
        address: info.address,
        endpoint: info.endpoint,
        services: info.services,
        harvestManifestSha256: info.manifests.harvest,
        paymentManifestSha256: info.manifests.payments,
        status: "active",
        consecutiveFailures: 0,
        lastCheckedAt: checkedAt,
        lastSeenAt: checkedAt,
        createdAt: checkedAt,
        updatedAt: checkedAt,
      })
      .onConflictDoUpdate({
        target: [operatorRegistrations.networkId, operatorRegistrations.lockHash],
        set: {
          displayName: info.name,
          address: info.address,
          endpoint: info.endpoint,
          services: info.services,
          harvestManifestSha256: info.manifests.harvest,
          paymentManifestSha256: info.manifests.payments,
          status: "active",
          consecutiveFailures: 0,
          lastCheckedAt: checkedAt,
          lastSeenAt: checkedAt,
          updatedAt: checkedAt,
        },
      })
      .returning();
    if (row === undefined) throw new Error("operator registration was not stored");
    const stored = await this.list(network);
    const result = stored.find(({ lockHash }) => lockHash === info.lockHash);
    if (result === undefined) throw new Error("operator registration could not be reloaded");
    return result;
  }

  async remove(network: string, lockHash: string): Promise<boolean> {
    const removed = await this.#database
      .delete(operatorRegistrations)
      .where(
        and(
          eq(operatorRegistrations.networkId, network),
          eq(operatorRegistrations.lockHash, lockHash),
        ),
      )
      .returning({ lockHash: operatorRegistrations.lockHash });
    return removed.length === 1;
  }

  async setFailure(
    network: string,
    lockHash: string,
    failures: number,
    checkedAt: Date,
  ): Promise<void> {
    await this.#database
      .update(operatorRegistrations)
      .set({
        consecutiveFailures: failures,
        status: failures >= OFFLINE_FAILURES ? "offline" : "active",
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt,
      })
      .where(
        and(
          eq(operatorRegistrations.networkId, network),
          eq(operatorRegistrations.lockHash, lockHash),
        ),
      );
  }
}

export interface OperatorRegistryOptions {
  readonly now?: () => Date;
  readonly probe?: OperatorProbe;
}

export class OperatorRegistryService {
  readonly #repository: OperatorRegistryRepository;
  readonly #auth: Pick<AuthService, "authenticate">;
  readonly #network: string;
  readonly #compatibility: OperatorCompatibility;
  readonly #now: () => Date;
  readonly #probe: OperatorProbe;

  constructor(
    repository: OperatorRegistryRepository,
    auth: Pick<AuthService, "authenticate">,
    environment: Pick<AutomataEnvironment, "CKB_NETWORK" | "CKB_GENESIS_HASH">,
    compatibility: Omit<OperatorCompatibility, "network" | "genesisHash">,
    options: OperatorRegistryOptions = {},
  ) {
    this.#repository = repository;
    this.#auth = auth;
    this.#network = environment.CKB_NETWORK;
    this.#compatibility = Object.freeze({
      network: environment.CKB_NETWORK,
      genesisHash: environment.CKB_GENESIS_HASH,
      ...compatibility,
    });
    this.#now = options.now ?? (() => new Date());
    this.#probe = options.probe ?? publicOperatorProbe;
  }

  async list(
    service?: string,
  ): Promise<{ readonly operators: readonly PublicOperatorRegistration[] }> {
    if (service !== undefined && !OPERATOR_SERVICES.includes(service as OperatorService)) {
      throw invalid("service is unsupported");
    }
    const rows = await this.#repository.list(this.#network);
    return Object.freeze({
      operators: Object.freeze(
        rows
          .filter(
            (row) =>
              row.status === "active" &&
              (service === undefined || row.services.includes(service as OperatorService)),
          )
          .map(publicRegistration),
      ),
    });
  }

  async register(
    authorization: string | undefined,
    input: unknown,
  ): Promise<PublicOperatorRegistration> {
    const session = await this.#auth.authenticate(authorization);
    const body = record(input, "request");
    if (Object.keys(body).some((key) => key !== "endpoint") || !("endpoint" in body)) {
      throw invalid("request must contain only endpoint");
    }
    const endpoint = normalizeOperatorEndpoint(body["endpoint"]);
    let info: HostedOperatorInfo;
    try {
      info = validateHostedOperatorInfo(
        await this.#probe.read(endpoint),
        endpoint,
        session.ownerLockHash,
        this.#compatibility,
      );
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw invalid("operator endpoint could not be verified");
    }
    try {
      return publicRegistration(await this.#repository.save(this.#network, info, this.#now()));
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw invalid("operator address or endpoint is already registered");
      }
      throw error;
    }
  }

  async remove(authorization: string | undefined): Promise<{ readonly removed: true }> {
    const session = await this.#auth.authenticate(authorization);
    if (!(await this.#repository.remove(this.#network, session.ownerLockHash))) {
      throw new UnauthorizedException({
        status: "unauthorized",
        code: "OPERATOR_REGISTRATION_NOT_FOUND",
      });
    }
    return Object.freeze({ removed: true as const });
  }

  async refreshAll(): Promise<void> {
    const rows = await this.#repository.list(this.#network);
    await Promise.allSettled(
      rows.map(async (row) => {
        const checkedAt = this.#now();
        try {
          const info = validateHostedOperatorInfo(
            await this.#probe.read(row.endpoint),
            row.endpoint,
            row.lockHash,
            this.#compatibility,
          );
          await this.#repository.save(this.#network, info, checkedAt);
        } catch {
          await this.#repository.setFailure(
            this.#network,
            row.lockHash,
            row.consecutiveFailures + 1,
            checkedAt,
          );
        }
      }),
    );
  }
}

export class OperatorRegistryMonitor {
  readonly #service: OperatorRegistryService;
  readonly #enabled: boolean;
  #timer?: NodeJS.Timeout;

  constructor(service: OperatorRegistryService, enabled: boolean) {
    this.#service = service;
    this.#enabled = enabled;
  }

  onModuleInit(): void {
    if (!this.#enabled) return;
    this.#timer = setInterval(() => void this.#service.refreshAll(), 60_000);
    this.#timer.unref();
  }

  onModuleDestroy(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }
}

export class OperatorRegistryController {
  readonly #operators: OperatorRegistryService;

  constructor(operators: OperatorRegistryService) {
    this.#operators = operators;
  }

  list(service?: string) {
    return this.#operators.list(service);
  }

  register(authorization: string | undefined, body: unknown) {
    return this.#operators.register(authorization, body);
  }

  remove(authorization: string | undefined) {
    return this.#operators.remove(authorization);
  }
}

const hashSchema = { type: "string", pattern: "^0x[0-9a-f]{64}$" };
const operatorSchema = {
  type: "object",
  required: ["id", "name", "address", "lockHash", "services", "status"],
  additionalProperties: false,
  properties: {
    id: { type: "string" },
    name: { type: "string", minLength: 2, maxLength: 64 },
    address: { type: "string", pattern: "^ckt1[0-9a-z]{20,124}$" },
    lockHash: hashSchema,
    services: { type: "array", items: { type: "string", enum: [...OPERATOR_SERVICES] } },
    status: { type: "string", enum: ["active"] },
  },
};

Inject(OperatorRegistryService)(OperatorRegistryController, undefined, 0);
Controller("operators")(OperatorRegistryController);
ApiTags("operators")(OperatorRegistryController);

Get()(
  OperatorRegistryController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "list")!,
);
Query("service")(OperatorRegistryController.prototype, "list", 0);
ApiOperation({ summary: "List verified active external operators" })(
  OperatorRegistryController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "list")!,
);
ApiQuery({ name: "service", required: false, enum: OPERATOR_SERVICES })(
  OperatorRegistryController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "list")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["operators"],
    properties: { operators: { type: "array", items: operatorSchema } },
  },
})(
  OperatorRegistryController.prototype,
  "list",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "list")!,
);

Put("registration")(
  OperatorRegistryController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "register")!,
);
Headers("authorization")(OperatorRegistryController.prototype, "register", 0);
Body()(OperatorRegistryController.prototype, "register", 1);
ApiBearerAuth("bearer")(
  OperatorRegistryController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "register")!,
);
ApiOperation({ summary: "Register or refresh an authenticated external operator" })(
  OperatorRegistryController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "register")!,
);
ApiBody({
  schema: {
    type: "object",
    required: ["endpoint"],
    additionalProperties: false,
    properties: { endpoint: { type: "string", format: "uri" } },
  },
})(
  OperatorRegistryController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "register")!,
);
ApiOkResponse({ schema: operatorSchema })(
  OperatorRegistryController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "register")!,
);
ApiBadRequestResponse({ description: "The endpoint, identity, network, or manifests are invalid" })(
  OperatorRegistryController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "register")!,
);
ApiUnauthorizedResponse({ description: "The wallet session is invalid" })(
  OperatorRegistryController.prototype,
  "register",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "register")!,
);

Delete("registration")(
  OperatorRegistryController.prototype,
  "remove",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "remove")!,
);
Headers("authorization")(OperatorRegistryController.prototype, "remove", 0);
ApiBearerAuth("bearer")(
  OperatorRegistryController.prototype,
  "remove",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "remove")!,
);
ApiOperation({ summary: "Remove the authenticated external operator" })(
  OperatorRegistryController.prototype,
  "remove",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "remove")!,
);
ApiOkResponse({
  schema: {
    type: "object",
    required: ["removed"],
    properties: { removed: { type: "boolean", enum: [true] } },
  },
})(
  OperatorRegistryController.prototype,
  "remove",
  Object.getOwnPropertyDescriptor(OperatorRegistryController.prototype, "remove")!,
);
