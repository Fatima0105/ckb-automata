import assert from "node:assert/strict";
import test from "node:test";

import { BadRequestException } from "@nestjs/common";
import { Address, Script } from "@ckb-ccc/shell";

import {
  OperatorRegistryService,
  normalizeOperatorEndpoint,
  validateHostedOperatorInfo,
  type HostedOperatorInfo,
  type OperatorRegistryRepository,
  type StoredOperatorRegistration,
} from "./operators.ts";

const LOCK = Script.from({
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: `0x${"ab".repeat(20)}`,
});
const LOCK_HASH = LOCK.hash();
const ADDRESS = new Address(LOCK, "ckt").toString();
const GENESIS_HASH = `0x${"34".repeat(32)}`;
const HARVEST_MANIFEST = "56".repeat(32);
const PAYMENT_MANIFEST = "78".repeat(32);

function hostedInfo(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    status: "ready",
    name: "Community Operator",
    version: "0.3.0",
    network: "ckb_testnet",
    genesisHash: GENESIS_HASH,
    identity: {
      lockHash: LOCK_HASH,
      address: ADDRESS,
      lock: {
        codeHash: LOCK.codeHash,
        hashType: LOCK.hashType,
        args: LOCK.args,
      },
    },
    services: ["dao-harvest", "deadline", "recurring"],
    manifests: { harvest: HARVEST_MANIFEST, payments: PAYMENT_MANIFEST },
    ...overrides,
  };
}

const compatibility = {
  network: "ckb_testnet",
  genesisHash: GENESIS_HASH,
  harvestManifestHashes: new Set([HARVEST_MANIFEST]),
  paymentManifestSha256: PAYMENT_MANIFEST,
};

class MemoryRepository implements OperatorRegistryRepository {
  readonly rows = new Map<string, StoredOperatorRegistration>();

  async list(): Promise<readonly StoredOperatorRegistration[]> {
    return [...this.rows.values()];
  }

  async remove(_network: string, lockHash: string): Promise<boolean> {
    return this.rows.delete(lockHash);
  }

  async save(
    _network: string,
    info: HostedOperatorInfo,
    checkedAt: Date,
  ): Promise<StoredOperatorRegistration> {
    const previous = this.rows.get(info.lockHash);
    const row = Object.freeze({
      ...info,
      status: "active" as const,
      consecutiveFailures: 0,
      createdAt: previous?.createdAt ?? checkedAt,
      lastCheckedAt: checkedAt,
      lastSeenAt: checkedAt,
      updatedAt: checkedAt,
    });
    this.rows.set(info.lockHash, row);
    return row;
  }

  async setFailure(
    _network: string,
    lockHash: string,
    failures: number,
    checkedAt: Date,
  ): Promise<void> {
    const row = this.rows.get(lockHash);
    if (row === undefined) return;
    this.rows.set(
      lockHash,
      Object.freeze({
        ...row,
        consecutiveFailures: failures,
        status: failures >= 3 ? ("offline" as const) : ("active" as const),
        lastCheckedAt: checkedAt,
        updatedAt: checkedAt,
      }),
    );
  }
}

test("operator endpoints must be public HTTPS origins", () => {
  assert.equal(normalizeOperatorEndpoint("https://operator.example"), "https://operator.example");
  for (const endpoint of [
    "http://operator.example",
    "https://127.0.0.1",
    "https://operator.local",
    "https://operator.example/path",
    "https://user:pass@operator.example",
  ]) {
    assert.throws(() => normalizeOperatorEndpoint(endpoint), BadRequestException);
  }
});

test("hosted identity is bound to the authenticated lock, network, and audited manifests", () => {
  const parsed = validateHostedOperatorInfo(
    hostedInfo(),
    "https://operator.example",
    LOCK_HASH,
    compatibility,
  );
  assert.equal(parsed.id, `registry:${LOCK_HASH}`);
  assert.deepEqual(parsed.services, ["dao-harvest", "deadline", "recurring"]);
  for (const value of [
    hostedInfo({ identity: { ...hostedInfo().identity, lockHash: `0x${"ff".repeat(32)}` } }),
    hostedInfo({ identity: { ...hostedInfo().identity, address: `${ADDRESS}x` } }),
    hostedInfo({ genesisHash: `0x${"ff".repeat(32)}` }),
    hostedInfo({ manifests: { harvest: HARVEST_MANIFEST, payments: "ff".repeat(32) } }),
  ]) {
    assert.throws(
      () => validateHostedOperatorInfo(value, "https://operator.example", LOCK_HASH, compatibility),
      BadRequestException,
    );
  }
});

test("registration proves ownership, filters services, and retires a repeatedly unhealthy host", async () => {
  const repository = new MemoryRepository();
  let healthy = true;
  const service = new OperatorRegistryService(
    repository,
    {
      authenticate: async () => ({
        expiresAt: new Date("2026-11-08T00:00:00.000Z"),
        id: "session",
        network: "ckb_testnet",
        ownerLockHash: LOCK_HASH,
        scope: "off_chain_settings",
      }),
    },
    { CKB_NETWORK: "ckb_testnet", CKB_GENESIS_HASH: GENESIS_HASH },
    {
      harvestManifestHashes: compatibility.harvestManifestHashes,
      paymentManifestSha256: PAYMENT_MANIFEST,
    },
    {
      now: () => new Date("2026-11-07T12:00:00.000Z"),
      probe: { read: async () => (healthy ? hostedInfo() : Promise.reject(new Error("down"))) },
    },
  );
  const registered = await service.register("Bearer token", {
    endpoint: "https://operator.example",
  });
  assert.equal(registered.lockHash, LOCK_HASH);
  assert.equal((await service.list("deadline")).operators.length, 1);
  await assert.rejects(service.list("unsupported"), BadRequestException);
  healthy = false;
  await service.refreshAll();
  await service.refreshAll();
  assert.equal((await service.list()).operators.length, 1);
  await service.refreshAll();
  assert.equal((await service.list()).operators.length, 0);
});
