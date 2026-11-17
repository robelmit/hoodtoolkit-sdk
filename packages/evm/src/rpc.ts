/**
 * A small JSON-RPC client for an EVM endpoint: paced, retrying what was
 * throttled or failed in transit, with a time limit per attempt. Reads only;
 * nothing here signs or sends.
 */

export class EvmRpcError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'EvmRpcError';
  }
}

/** The endpoint could not be reached, or kept throttling, after every retry. */
export class EvmRpcUnavailable extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
    this.name = 'EvmRpcUnavailable';
  }
}

export interface EvmRpc {
  call<T = unknown>(method: string, params: unknown[]): Promise<T>;
}

export interface EvmRpcOptions {
  /** The JSON-RPC endpoint. */
  readonly url: string;
  /** Calls a second, at most. Default 8, a pace a public endpoint tolerates; 0 turns pacing off. */
  readonly requestsPerSecond?: number;
  /** How many times a throttled or failed call is tried again. Default 4. */
  readonly retries?: number;
  /** How long one attempt may take. Default 15 seconds. */
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/** Robinhood Chain's public endpoint. It rate-limits; use your own for anything that must not stall. */
export const ROBINHOOD_PUBLIC_RPC = 'https://rpc.mainnet.chain.robinhood.com';
export const ROBINHOOD_CHAIN_ID = 4663;

export function createEvmRpc(options: EvmRpcOptions): EvmRpc {
  if (!/^https?:\/\//.test(options.url)) throw new Error('the RPC url must start with http:// or https://');
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const retries = options.retries ?? 4;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const gap = options.requestsPerSecond === 0 ? 0 : 1000 / (options.requestsPerSecond ?? 8);
  let nextAt = 0;
  let id = 0;

  async function pace(): Promise<void> {
    if (gap === 0) return;
    const at = now();
    const wait = Math.max(0, nextAt - at);
    nextAt = Math.max(at, nextAt) + gap;
    if (wait > 0) await sleep(wait);
  }

  async function call<T>(method: string, params: unknown[]): Promise<T> {
    let last = 'no attempt was made';
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) await sleep(Math.min(8_000, 300 * 2 ** (attempt - 1)));
      await pace();
      let response: Response;
      try {
        response = await doFetch(options.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        last = error instanceof Error ? error.message : 'the request failed';
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        last = `HTTP ${response.status}`;
        continue;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        last = `HTTP ${response.status} with a body that is not JSON`;
        continue;
      }
      const answer = body as { result?: unknown; error?: { code?: number; message?: string } };
      if (answer.error) {
        const code = typeof answer.error.code === 'number' ? answer.error.code : null;
        const message = String(answer.error.message ?? 'error');
        // A node's own rate limit arrives as a JSON-RPC error on some endpoints.
        if (code === -32005 || /rate limit|too many requests/i.test(message)) {
          last = message;
          continue;
        }
        throw new EvmRpcError(method, code, message);
      }
      if (!('result' in answer)) throw new EvmRpcError(method, null, 'the answer has no result');
      return answer.result as T;
    }
    throw new EvmRpcUnavailable(method, last);
  }

  return { call };
}

/** A read of a contract at a block (`latest` by default). */
export const ethCall = (rpc: EvmRpc, to: string, data: string, block: string = 'latest'): Promise<string> => rpc.call<string>('eth_call', [{ to, data }, block]);

export const blockNumber = async (rpc: EvmRpc): Promise<number> => Number(BigInt(await rpc.call<string>('eth_blockNumber', [])));

/** The chain id the endpoint serves. Check it before trusting anything else the endpoint says. */
export const chainId = async (rpc: EvmRpc): Promise<number> => Number(BigInt(await rpc.call<string>('eth_chainId', [])));
