import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseDaoHarvestV2ExecutorManifest } from "./dao-harvest-v2-manifest.ts";

test("hosted executor accepts the audited V2 manifest shape", async () => {
  const path = new URL("../../../deploy/manifests/dao-harvest-v2-testnet.json", import.meta.url);
  const manifest = parseDaoHarvestV2ExecutorManifest(JSON.parse(await readFile(path, "utf8")));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.contracts.jobLock.hashType, "data1");
  assert.equal(manifest.operators.fallbackPrepareLockHashes.length, 1);
});

test("hosted executor rejects unaudited contract metadata and duplicate operators", () => {
  const base = {
    schemaVersion: 2,
    releaseVersion: "0.2.0",
    network: "ckb_testnet",
    genesisHash: `0x${"1".repeat(64)}`,
    sourceRevision: "1".repeat(40),
    predecessorManifests: [],
    secp256k1Blake160: {
      codeHash: `0x${"2".repeat(64)}`,
      hashType: "type",
      cellDep: { outPoint: { txHash: `0x${"3".repeat(64)}`, index: "0x0" }, depType: "depGroup" },
    },
    nervosDao: {
      codeHash: `0x${"4".repeat(64)}`,
      hashType: "type",
      cellDep: { outPoint: { txHash: `0x${"5".repeat(64)}`, index: "0x0" }, depType: "code" },
    },
    contracts: Object.fromEntries(
      ["jobLock", "policy", "vaultLock", "compensationLock"].map((name, index) => [
        name,
        {
          codeHash: `0x${String(index + 6).repeat(64)}`,
          hashType: "data1",
          binarySha256: "a".repeat(64),
          sizeBytes: 1,
          cellDep: {
            outPoint: { txHash: `0x${String(index + 6).repeat(64)}`, index: "0x0" },
            depType: "code",
          },
        },
      ]),
    ),
    operators: {
      preferredPrepareLockHash: `0x${"a".repeat(64)}`,
      fallbackPrepareLockHashes: [`0x${"b".repeat(64)}`],
    },
  };
  assert.throws(
    () =>
      parseDaoHarvestV2ExecutorManifest({
        ...base,
        contracts: {
          ...base.contracts,
          policy: { ...base.contracts["policy"], binarySha256: "not-a-digest" },
        },
      }),
    /audit metadata/,
  );
  assert.throws(
    () =>
      parseDaoHarvestV2ExecutorManifest({
        ...base,
        operators: {
          ...base.operators,
          fallbackPrepareLockHashes: [
            base.operators.fallbackPrepareLockHashes[0],
            base.operators.fallbackPrepareLockHashes[0],
          ],
        },
      }),
    /unique/,
  );
});
