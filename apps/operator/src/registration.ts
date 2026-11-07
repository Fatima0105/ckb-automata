import {
  Script,
  SignerSignType,
  messageHashCkbSecp256k1,
  signMessageSecp256k1,
} from "@ckb-ccc/shell";
import { ECPair } from "@nervosnetwork/ckb-sdk-utils";

import type { OperatorConfiguration } from "./config.ts";
import type { LoadedOperatorManifest } from "./manifest.ts";
import { operatorLockArgs } from "./transaction.ts";

export const CKB_TESTNET_SECP256K1_BLAKE160_CODE_HASH =
  "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

export function operatorIdentityLock(
  privateKey: string,
  loaded?: LoadedOperatorManifest,
): Readonly<{ codeHash: string; hashType: "type"; args: string }> {
  return Object.freeze({
    codeHash:
      loaded?.manifest.secp256k1Blake160.codeHash ?? CKB_TESTNET_SECP256K1_BLAKE160_CODE_HASH,
    hashType: "type" as const,
    args: operatorLockArgs(privateKey),
  });
}

function record(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} returned an invalid response`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new Error(`${name} is missing from the API response`);
  return value;
}

async function apiRequest(
  baseUrl: string,
  path: string,
  init: RequestInit,
): Promise<Readonly<Record<string, unknown>>> {
  const response = await fetch(new URL(path, `${baseUrl}/`), {
    ...init,
    headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await response.json().catch(() => undefined)) as unknown;
  if (!response.ok) {
    const detail =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${response.status}`;
    throw new Error(`CKAutomata API rejected operator registration: ${detail}`);
  }
  return record(body, "CKAutomata API");
}

export async function registerHostedOperator(
  config: OperatorConfiguration,
  loaded?: LoadedOperatorManifest,
) {
  if (!config.privateKey) throw new Error("OPERATOR_PRIVATE_KEY is required for registration");
  if (!config.operatorName) throw new Error("OPERATOR_NAME is required for registration");
  if (!config.operatorPublicUrl) {
    throw new Error("OPERATOR_PUBLIC_URL is required for registration");
  }
  if (!config.automataApiUrl) throw new Error("CKAUTOMATA_API_URL is required for registration");

  const ownerLock = operatorIdentityLock(config.privateKey, loaded);
  const ownerLockHash = Script.from(ownerLock).hash();
  const challenge = await apiRequest(config.automataApiUrl, "v1/auth/challenge", {
    method: "POST",
    body: JSON.stringify({ ownerLockHash }),
  });
  const message = string(challenge["message"], "message");
  const publicKey = new ECPair(config.privateKey).publicKey;
  const signature = signMessageSecp256k1(messageHashCkbSecp256k1(message), config.privateKey);
  const session = await apiRequest(config.automataApiUrl, "v1/auth/verify", {
    method: "POST",
    body: JSON.stringify({
      challengeId: string(challenge["challengeId"], "challengeId"),
      nonce: string(challenge["nonce"], "nonce"),
      ownerLock,
      signature: {
        identity: publicKey,
        signature,
        signType: SignerSignType.CkbSecp256k1,
      },
    }),
  });
  const sessionToken = string(session["sessionToken"], "sessionToken");
  const registration = await apiRequest(config.automataApiUrl, "v1/operators/registration", {
    method: "PUT",
    headers: { authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ endpoint: config.operatorPublicUrl }),
  });
  return Object.freeze({
    status: "registered" as const,
    operator: registration,
  });
}
