import {
  ECPair,
  EMPTY_SECP_SIG,
  PERSONAL,
  blake160,
  blake2b,
  hexToBytes,
  rawTransactionToHash,
  serializeWitnessArgs,
} from "@nervosnetwork/ckb-sdk-utils";

import type { UnsignedDeadlineTransaction } from "@ckb-automata/core";

function littleEndian(value: number, bytes: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("length is invalid");
  let remaining = BigInt(value);
  const encoded = new Uint8Array(bytes);
  for (let index = 0; index < bytes; index += 1) {
    encoded[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (remaining !== 0n) throw new RangeError("length does not fit its encoding");
  return encoded;
}

export function operatorLockArgs(privateKey: string): `0x${string}` {
  if (!/^0x[0-9a-f]{64}$/.test(privateKey)) {
    throw new TypeError("operator private key is invalid");
  }
  const publicKey = new ECPair(privateKey).publicKey;
  return `0x${blake160(publicKey, "hex")}`;
}

export function signOperatorFeeInput(
  transaction: UnsignedDeadlineTransaction,
  privateKey: string,
  inputIndex: number,
): UnsignedDeadlineTransaction {
  if (
    !Number.isSafeInteger(inputIndex) ||
    inputIndex < 0 ||
    inputIndex >= transaction.inputs.length
  ) {
    throw new RangeError("operator input index is invalid");
  }
  const zeroedWitness = serializeWitnessArgs({
    lock: EMPTY_SECP_SIG,
    inputType: "",
    outputType: "",
  });
  const transactionHash = rawTransactionToHash(
    transaction as unknown as Parameters<typeof rawTransactionToHash>[0],
  );
  const hasher = blake2b(32, null, null, PERSONAL);
  hasher.update(hexToBytes(transactionHash));
  const first = hexToBytes(zeroedWitness);
  hasher.update(littleEndian(first.length, 8));
  hasher.update(first);
  const witnesses = [...transaction.witnesses];
  while (witnesses.length < transaction.inputs.length) witnesses.push("0x");
  for (const witness of witnesses.slice(transaction.inputs.length)) {
    const bytes = hexToBytes(witness);
    hasher.update(littleEndian(bytes.length, 8));
    hasher.update(bytes);
  }
  witnesses[inputIndex] = serializeWitnessArgs({
    lock: new ECPair(privateKey).signRecoverable(hasher.digest("binary") as Uint8Array),
    inputType: "",
    outputType: "",
  }) as `0x${string}`;
  return Object.freeze({ ...transaction, witnesses: Object.freeze(witnesses) });
}
