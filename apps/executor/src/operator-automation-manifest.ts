import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PERSONAL, blake2b, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import {
  parseHash32,
  parseOperatorAutomationManifest,
  type Hash32,
  type OperatorAutomationDeployment,
} from "@ckb-automata/core";

import type { ExecutorRuntime } from "./runtime.ts";

function ckbDataHash(bytes: Uint8Array): Hash32 {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(bytes);
  return parseHash32(`0x${hasher.digest("hex")}`);
}

export async function loadOperatorAutomationDeployment(
  path: string,
  runtime: Pick<ExecutorRuntime, "getCellLive">,
  expectedGenesisHash: string,
): Promise<OperatorAutomationDeployment> {
  const bytes = await readFile(path);
  const manifest = parseOperatorAutomationManifest(JSON.parse(bytes.toString("utf8")));
  if (manifest.genesisHash !== parseHash32(expectedGenesisHash)) {
    throw new Error("operator automation manifest does not match the configured chain genesis");
  }
  for (const [name, item] of Object.entries(manifest.contracts)) {
    const live = await runtime.getCellLive(item.cellDep.outPoint);
    if (!live) throw new Error(`${name} code cell is not live`);
    const contractBytes = hexToBytes(live.outputData.toString());
    if (
      contractBytes.length !== item.sizeBytes ||
      createHash("sha256").update(contractBytes).digest("hex") !== item.binarySha256 ||
      ckbDataHash(contractBytes) !== item.script.codeHash
    ) {
      throw new Error(`${name} code cell does not match the audited manifest`);
    }
  }
  return Object.freeze({
    genesisHash: manifest.genesisHash,
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
    secp256k1Blake160: manifest.secp256k1Blake160,
    contracts: manifest.contracts,
    defaultPreferredOperatorLockHash: manifest.defaultPreferredOperatorLockHash,
  });
}
