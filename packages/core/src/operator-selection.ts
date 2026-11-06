import { PERSONAL, blake2b } from "@nervosnetwork/ckb-sdk-utils";

import { OperatorPayloadV1, type OperatorPayloadV1Value } from "@ckb-automata/molecule";

import {
  hash32FromBytes,
  hash32ToBytes,
  parseBlockNumber,
  parseHash32,
  type Hash32,
} from "./chain-values.ts";

export const OPERATOR_PAYLOAD_VERSION = 1 as const;
export const DEFAULT_OPERATOR_TAKEOVER_DELAY_BLOCKS = 12n;
export const OPERATOR_PAYLOAD_DOMAIN = "ckb-automata/policy-payload/v1" as const;

export interface OperatorSelection {
  readonly preferredExecutorLockHash: Hash32;
  readonly takeoverDelayBlocks: bigint;
}

export function normalizeOperatorSelection(value: {
  readonly preferredExecutorLockHash: string;
  readonly takeoverDelayBlocks?: bigint;
}): OperatorSelection {
  const takeoverDelayBlocks = parseBlockNumber(
    value.takeoverDelayBlocks ?? DEFAULT_OPERATOR_TAKEOVER_DELAY_BLOCKS,
  );
  if (takeoverDelayBlocks === 0n) throw new RangeError("operator takeover delay must be non-zero");
  return Object.freeze({
    preferredExecutorLockHash: parseHash32(value.preferredExecutorLockHash),
    takeoverDelayBlocks,
  });
}

export function packOperatorPayload(
  selection: OperatorSelection,
  applicationPayload: Uint8Array,
): Uint8Array {
  return OperatorPayloadV1.pack({
    version: OPERATOR_PAYLOAD_VERSION,
    preferred_executor_lock_hash: [...hash32ToBytes(selection.preferredExecutorLockHash)],
    takeover_delay_blocks: selection.takeoverDelayBlocks.toString(),
    application_payload: [...applicationPayload],
  });
}

export function unpackOperatorPayload(payload: Uint8Array): Readonly<{
  applicationPayload: Uint8Array;
  selection: OperatorSelection;
}> {
  const value: OperatorPayloadV1Value = OperatorPayloadV1.unpack(payload);
  if (Number(value.version.toString()) !== OPERATOR_PAYLOAD_VERSION) {
    throw new RangeError("unsupported operator payload version");
  }
  return Object.freeze({
    applicationPayload: Uint8Array.from(value.application_payload),
    selection: normalizeOperatorSelection({
      preferredExecutorLockHash: hash32FromBytes(
        Uint8Array.from(value.preferred_executor_lock_hash),
      ),
      takeoverDelayBlocks: BigInt(value.takeover_delay_blocks.toString()),
    }),
  });
}

export function deriveOperatorPayloadHash(
  policyScriptHash: Uint8Array,
  payload: Uint8Array,
): Uint8Array {
  if (policyScriptHash.length !== 32) {
    throw new RangeError("policyScriptHash must contain exactly 32 bytes");
  }
  const bodyLength = policyScriptHash.length + payload.length;
  if (bodyLength > 0xffff_ffff) throw new RangeError("operator payload is too large");
  const encodedLength = new Uint8Array(4);
  new DataView(encodedLength.buffer).setUint32(0, bodyLength, true);
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(new TextEncoder().encode(OPERATOR_PAYLOAD_DOMAIN));
  hasher.update(Uint8Array.of(0));
  hasher.update(encodedLength);
  hasher.update(policyScriptHash);
  hasher.update(payload);
  return hasher.digest("binary") as Uint8Array;
}

export function operatorTakeoverBlock(notBefore: bigint, delay: bigint): bigint {
  const scheduled = parseBlockNumber(notBefore);
  const normalizedDelay = parseBlockNumber(delay);
  if (normalizedDelay === 0n) throw new RangeError("operator takeover delay must be non-zero");
  return parseBlockNumber(scheduled + normalizedDelay);
}
