import { bytesToHex, hexToBytes } from "@nervosnetwork/ckb-sdk-utils";

import { parseHash32, type Hash32 } from "@ckb-automata/core";
import { JobDataV1 } from "@ckb-automata/molecule";

import type { OperatorManifest } from "./manifest.ts";
import type { JsonRpcClient } from "./rpc.ts";
import { record, string } from "./rpc.ts";

export interface DiscoveredHarvestV2Job {
  readonly jobId: Hash32;
  readonly sequence: string;
  readonly state: number;
  readonly notBeforeSince: string;
  readonly remainingRuns: string;
  readonly outPoint: { readonly txHash: Hash32; readonly index: string };
  readonly blockNumber: string;
}

export async function discoverHarvestV2Jobs(
  manifest: OperatorManifest,
  indexer: JsonRpcClient,
  limit = 100,
): Promise<readonly DiscoveredHarvestV2Job[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("discovery limit must be between 1 and 100");
  }
  const result = record(
    await indexer.call("get_cells", [
      {
        script: {
          code_hash: manifest.contracts.jobLock.codeHash,
          hash_type: manifest.contracts.jobLock.hashType,
          args: "0x",
        },
        script_type: "lock",
        script_search_mode: "exact",
        filter: {
          script: {
            code_hash: manifest.contracts.policy.codeHash,
            hash_type: manifest.contracts.policy.hashType,
            args: manifest.contracts.jobLock.codeHash,
          },
        },
      },
      "asc",
      `0x${limit.toString(16)}`,
    ]),
    "indexer cells response",
  );
  if (!Array.isArray(result["objects"])) throw new TypeError("indexer cells are invalid");
  return Object.freeze(
    result["objects"].map((item, index) => {
      const cell = record(item, `cell ${index}`);
      const outputData = string(cell["output_data"], `cell ${index} output_data`);
      const job = JobDataV1.unpack(hexToBytes(outputData));
      if (Number(job.version) !== 1)
        throw new Error(`cell ${index} has an unsupported Job version`);
      const output = record(cell["output"], `cell ${index} output`);
      const type = record(output["type"], `cell ${index} type script`);
      if (type["args"] !== manifest.contracts.jobLock.codeHash) {
        throw new Error(`cell ${index} policy does not bind the deployed V2 Job Lock`);
      }
      const outPoint = record(cell["out_point"], `cell ${index} out_point`);
      return Object.freeze({
        jobId: parseHash32(bytesToHex(Uint8Array.from(job.job_id))),
        sequence: job.sequence.toString(),
        state: Number(job.state),
        notBeforeSince: job.not_before.toString(),
        remainingRuns: job.remaining_runs.toString(),
        outPoint: Object.freeze({
          txHash: parseHash32(string(outPoint["tx_hash"], `cell ${index} transaction hash`)),
          index: string(outPoint["index"], `cell ${index} output index`),
        }),
        blockNumber: BigInt(string(cell["block_number"], `cell ${index} block number`)).toString(),
      });
    }),
  );
}
