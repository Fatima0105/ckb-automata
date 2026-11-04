let requestId = 0;

export interface JsonRpcClient {
  call<T>(method: string, params?: readonly unknown[]): Promise<T>;
}

export class PublicJsonRpcClient implements JsonRpcClient {
  readonly #url: string;
  readonly #timeoutMs: number;

  constructor(url: string, timeoutMs = 15_000) {
    this.#url = new URL(url).href;
    this.#timeoutMs = timeoutMs;
  }

  async call<T>(method: string, params: readonly unknown[] = []): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: ++requestId, jsonrpc: "2.0", method, params }),
        signal: controller.signal,
      });
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error(`${method} returned an invalid JSON-RPC response`);
      }
      const responseRecord = payload as Record<string, unknown>;
      if (!response.ok || responseRecord["error"] !== undefined) {
        const error = responseRecord["error"];
        const message =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as Record<string, unknown>)["message"])
            : `HTTP ${response.status}`;
        throw new Error(`${method}: ${message}`);
      }
      return responseRecord["result"] as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function string(value: unknown, name: string): string {
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  return value;
}
