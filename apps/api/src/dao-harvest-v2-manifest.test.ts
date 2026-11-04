import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PERSONAL, blake2b, bytesToHex } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32 } from "@ckb-automata/core";

import {
  loadVerifiedDaoHarvestV2Deployment,
  parseDaoHarvestV2DeploymentManifest,
} from "./dao-harvest-v2-manifest.ts";

const genesisHash = parseHash32(`0x${"1".repeat(64)}`);
const hash = (value: string) => parseHash32(`0x${value.repeat(64)}`);
const cellDep = (value: string) => ({
  outPoint: { txHash: hash(value), index: "0x0" },
  depType: "code",
});

function dataHash(bytes: Uint8Array) {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(bytes);
  return `0x${hasher.digest("hex")}`;
}

function sha256(bytes: Uint8Array) {
  return import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(bytes).digest("hex"),
  );
}

async function fixture() {
  const binaries = Object.fromEntries(
    ["jobLock", "policy", "vaultLock", "compensationLock"].map((name, index) => [
      name,
      Uint8Array.of(index + 1, index + 2, index + 3),
    ]),
  ) as Record<string, Uint8Array>;
  const contracts = Object.fromEntries(
    await Promise.all(
      Object.entries(binaries).map(async ([name, bytes], index) => [
        name,
        {
          codeHash: dataHash(bytes),
          hashType: "data1",
          binarySha256: await sha256(bytes),
          sizeBytes: bytes.length,
          cellDep: cellDep(String(index + 2)),
        },
      ]),
    ),
  );
  return {
    binaries,
    manifest: {
      schemaVersion: 2,
      releaseVersion: "0.1.0",
      network: "ckb_testnet",
      genesisHash,
      sourceRevision: "8e35b25772dd826329db0e336e28686932dde112",
      secp256k1Blake160: {
        codeHash: hash("a"),
        hashType: "type",
        cellDep: { ...cellDep("a"), depType: "depGroup" },
      },
      nervosDao: { codeHash: hash("b"), hashType: "type", cellDep: cellDep("b") },
      contracts,
      operators: {
        preferredPrepareLockHash: hash("c"),
        fallbackPrepareLockHashes: [hash("d"), hash("e")],
      },
    },
  };
}

test("V2 activation verifies every immutable code cell before returning identities", async () => {
  const { binaries, manifest } = await fixture();
  const directory = await mkdtemp(join(tmpdir(), "ckautomata-v2-manifest-"));
  const path = join(directory, "manifest.json");
  try {
    await writeFile(path, `${JSON.stringify(manifest)}\n`);
    const loaded = await loadVerifiedDaoHarvestV2Deployment(
      path,
      {
        getGenesisHash: async () => genesisHash,
        getCellLive: async (outPoint) => {
          const entry = Object.entries(
            manifest.contracts as Record<
              string,
              { readonly cellDep: { readonly outPoint: { readonly txHash: string } } }
            >,
          ).find(([, contract]) => contract.cellDep.outPoint.txHash === outPoint.txHash);
          return entry === undefined
            ? undefined
            : ({ outputData: { toString: () => bytesToHex(binaries[entry[0]]!) } } as never);
        },
      },
      genesisHash,
    );
    assert.equal(loaded.deployment.contracts.policy.codeHash, manifest.contracts.policy.codeHash);
    assert.equal(loaded.deployment.fallbackPrepareOperatorLockHashes.length, 2);
    assert.match(loaded.manifestSha256, /^[0-9a-f]{64}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("V2 activation rejects manifest drift, duplicate operators, and altered bytes", async () => {
  const { binaries, manifest } = await fixture();
  assert.throws(
    () =>
      parseDaoHarvestV2DeploymentManifest({
        ...manifest,
        operators: {
          ...manifest.operators,
          fallbackPrepareLockHashes: [hash("d"), hash("d")],
        },
      }),
    /unique/,
  );
  const directory = await mkdtemp(join(tmpdir(), "ckautomata-v2-manifest-"));
  const path = join(directory, "manifest.json");
  try {
    await writeFile(path, `${JSON.stringify(manifest)}\n`);
    await assert.rejects(
      loadVerifiedDaoHarvestV2Deployment(
        path,
        {
          getGenesisHash: async () => genesisHash,
          getCellLive: async (outPoint) => {
            const entry = Object.entries(
              manifest.contracts as Record<
                string,
                { readonly cellDep: { readonly outPoint: { readonly txHash: string } } }
              >,
            ).find(([, contract]) => contract.cellDep.outPoint.txHash === outPoint.txHash);
            return entry === undefined
              ? undefined
              : ({
                  outputData: {
                    toString: () =>
                      bytesToHex(
                        entry[0] === "policy" ? Uint8Array.of(9, 9, 9) : binaries[entry[0]]!,
                      ),
                  },
                } as never);
          },
        },
        genesisHash,
      ),
      /does not match/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
