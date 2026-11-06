import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { PERSONAL, blake2b, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import {
  parseHash32,
  parseOperatorAutomationManifest,
  type Hash32,
  type OperatorAutomationDeployment,
  type OperatorAutomationManifest,
} from "@ckb-automata/core";

import type { JsonRpcClient } from "./rpc.ts";
import { record, string } from "./rpc.ts";

export interface LoadedAutomationManifest {
  readonly manifest: OperatorAutomationManifest;
  readonly deployment: OperatorAutomationDeployment;
  readonly sha256: string;
}

function ckbDataHash(bytes: Uint8Array): Hash32 {
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(bytes);
  return parseHash32(`0x${hasher.digest("hex")}`);
}

export async function loadAutomationManifest(path: string): Promise<LoadedAutomationManifest> {
  const bytes = await readFile(path);
  const manifest = parseOperatorAutomationManifest(JSON.parse(bytes.toString("utf8")));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return Object.freeze({
    manifest,
    sha256,
    deployment: Object.freeze({
      genesisHash: manifest.genesisHash,
      manifestSha256: sha256,
      secp256k1Blake160: manifest.secp256k1Blake160,
      contracts: manifest.contracts,
      defaultPreferredOperatorLockHash: manifest.defaultPreferredOperatorLockHash,
    }),
  });
}

export async function verifyAutomationManifest(
  loaded: LoadedAutomationManifest,
  rpc: JsonRpcClient,
  expectedGenesisHash?: string,
) {
  const genesisHash = parseHash32(await rpc.call<string>("get_block_hash", ["0x0"]));
  if (
    genesisHash !== loaded.manifest.genesisHash ||
    (expectedGenesisHash !== undefined && genesisHash !== parseHash32(expectedGenesisHash))
  ) {
    throw new Error("public RPC genesis does not match the automation manifest");
  }
  for (const [name, item] of Object.entries(loaded.manifest.contracts)) {
    const result = record(
      await rpc.call("get_live_cell", [
        { tx_hash: item.cellDep.outPoint.txHash, index: item.cellDep.outPoint.index },
        true,
      ]),
      `${name} live cell`,
    );
    if (result["status"] !== "live") throw new Error(`${name} code cell is not live`);
    const cell = record(result["cell"], `${name} cell`);
    const data = record(cell["data"], `${name} data`);
    const binary = hexToBytes(string(data["content"], `${name} data content`));
    if (
      binary.length !== item.sizeBytes ||
      createHash("sha256").update(binary).digest("hex") !== item.binarySha256 ||
      ckbDataHash(binary) !== item.script.codeHash
    ) {
      throw new Error(`${name} code cell does not match the audited manifest`);
    }
  }
  return Object.freeze({ status: "verified" as const, genesisHash, manifestSha256: loaded.sha256 });
}
