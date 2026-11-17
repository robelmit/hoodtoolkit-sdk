import { describe, expect, it } from 'vitest';
import {
  EvmRpcError,
  EvmRpcUnavailable,
  addressAt,
  address,
  addressWord,
  blockTime,
  createEvmRpc,
  decodeCall,
  decodeString,
  encodeCall,
  getLogs,
  isAddress,
  logRanges,
  quantity,
  readErc20,
  sameAddress,
  toQuantity,
  topicAddress,
  uintAt,
  uintWord,
  wordAt,
  wordCount,
  type EvmRpc,
} from '../src';

const A = '0x5FC5360d0400a0Fd4f2af552AdD042d716F1d168';

describe('abi', () => {
  it('reads and writes 32-byte words', () => {
    const data = `0x${uintWord(7n)}${addressWord(A)}${uintWord(1n)}`;
    expect(wordCount(data)).toBe(3);
    expect(uintAt(data, 0)).toBe(7n);
    expect(addressAt(data, 1)).toBe(A.toLowerCase());
    expect(wordAt(data, 2)).toBe(uintWord(1n));
    expect(() => wordAt(data, 3)).toThrow(/ends before/);
    expect(() => addressAt(`0x${'f'.repeat(64)}`, 0)).toThrow(/not an address/);
    expect(topicAddress(`0x${addressWord(A)}`)).toBe(A.toLowerCase());
    expect(() => uintWord(-1n)).toThrow();
    expect(() => uintWord(1n << 256n)).toThrow();
  });

  it('knows an address, and compares without case', () => {
    expect(isAddress(A)).toBe(true);
    expect(isAddress('0x123')).toBe(false);
    expect(isAddress(42)).toBe(false);
    expect(sameAddress(A, A.toLowerCase())).toBe(true);
    expect(address(A)).toBe(A.toLowerCase());
    expect(() => address('nope')).toThrow(/not an address/);
  });

  it('builds calldata and takes it apart again', () => {
    const data = encodeCall('0x59a87bc1', [uintWord(5n), addressWord(A)]);
    expect(decodeCall(data)).toEqual({ selector: '0x59a87bc1', words: [uintWord(5n), addressWord(A)] });
    expect(decodeCall('0x59A87BC1').selector).toBe('0x59a87bc1');
    expect(() => decodeCall('0x59a87bc1ff')).toThrow(/whole words/);
    expect(() => decodeCall('0x12')).toThrow();
    expect(() => encodeCall('0x59A87BC1')).toThrow(/selector/);
    expect(() => encodeCall('0x59a87bc1', ['ff'])).toThrow(/word/);
  });

  it('decodes a string, a bytes32 name, and nothing from junk', () => {
    const dynamic = `0x${uintWord(32n)}${uintWord(4n)}${Buffer.from('USDG').toString('hex').padEnd(64, '0')}`;
    expect(decodeString(dynamic)).toBe('USDG');
    expect(decodeString(`0x${Buffer.from('MKR').toString('hex').padEnd(64, '0')}`)).toBe('MKR');
    expect(decodeString('0x')).toBeNull();
    expect(decodeString('nope')).toBeNull();
    expect(decodeString(`0x${uintWord(32n)}${uintWord(9999n)}`)).toBeNull();
    // Control characters never reach a caller's screen or log.
    const nasty = `0x${uintWord(32n)}${uintWord(6n)}${Buffer.from('a\u0000\nb\u001bc').toString('hex').padEnd(64, '0')}`;
    expect(decodeString(nasty)).toBe('abc');
  });

  it('converts quantities', () => {
    expect(quantity('0x1237')).toBe(4663);
    expect(toQuantity(4663)).toBe('0x1237');
    expect(() => quantity(`0x${'f'.repeat(20)}`)).toThrow(/safe integer/);
  });
});

function fakeFetch(answers: (() => Response | Promise<Response>)[]): { fetch: typeof fetch; bodies: unknown[] } {
  const bodies: unknown[] = [];
  let i = 0;
  const fn = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? '{}'));
    const next = answers[Math.min(i, answers.length - 1)]!;
    i += 1;
    return next();
  }) as unknown as typeof fetch;
  return { fetch: fn, bodies };
}
const ok = (result: unknown) => () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });

describe('the RPC client', () => {
  it('returns the result and sends well-formed requests', async () => {
    const { fetch, bodies } = fakeFetch([ok('0x1237')]);
    const rpc = createEvmRpc({ url: 'https://rpc.example', fetch, requestsPerSecond: 0 });
    expect(await rpc.call('eth_chainId', [])).toBe('0x1237');
    expect(bodies[0]).toMatchObject({ jsonrpc: '2.0', method: 'eth_chainId', params: [] });
  });

  it('retries what was throttled or failed in transit, then gives up with the reason', async () => {
    const sleeps: number[] = [];
    const flaky = fakeFetch([() => new Response('slow down', { status: 429 }), () => Promise.reject(new Error('socket hang up')), ok('0x1')]);
    const rpc = createEvmRpc({ url: 'https://rpc.example', fetch: flaky.fetch, requestsPerSecond: 0, sleep: async (ms) => void sleeps.push(ms) });
    expect(await rpc.call('eth_blockNumber', [])).toBe('0x1');
    expect(sleeps).toEqual([300, 600]);

    const down = fakeFetch([() => new Response('', { status: 503 })]);
    const dead = createEvmRpc({ url: 'https://rpc.example', fetch: down.fetch, requestsPerSecond: 0, retries: 2, sleep: async () => undefined });
    await expect(dead.call('eth_blockNumber', [])).rejects.toBeInstanceOf(EvmRpcUnavailable);
    expect(down.bodies).toHaveLength(3);
  });

  it('reports a node error as an error, without retrying it', async () => {
    const { fetch, bodies } = fakeFetch([() => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted' } }), { status: 200 })]);
    const rpc = createEvmRpc({ url: 'https://rpc.example', fetch, requestsPerSecond: 0 });
    await expect(rpc.call('eth_call', [])).rejects.toMatchObject({ name: 'EvmRpcError', code: 3 });
    expect(bodies).toHaveLength(1);
  });

  it('paces its calls and refuses a url that is not http', async () => {
    const waits: number[] = [];
    const { fetch } = fakeFetch([ok('0x1')]);
    const rpc = createEvmRpc({ url: 'https://rpc.example', fetch, requestsPerSecond: 4, now: () => 0, sleep: async (ms) => void waits.push(ms) });
    await Promise.all([rpc.call('a', []), rpc.call('b', []), rpc.call('c', [])]);
    expect(waits).toEqual([250, 500]);
    expect(() => createEvmRpc({ url: 'ftp://x' })).toThrow(/http/);
  });
});

const raw = (block: number, index: number, extra: Record<string, unknown> = {}) => ({ address: A, topics: ['0xaa'], data: '0x', blockNumber: toQuantity(block), transactionHash: '0xdead', logIndex: toQuantity(index), ...extra });

describe('logs', () => {
  it('splits a range into spans', () => {
    expect(logRanges(10, 34, 10)).toEqual([{ from: 10, to: 19 }, { from: 20, to: 29 }, { from: 30, to: 34 }]);
    expect(logRanges(5, 4, 10)).toEqual([]);
    expect(() => logRanges(0, 10, 0)).toThrow(/span/);
    expect(() => logRanges(1.5, 10, 5)).toThrow(/integers/);
  });

  it('halves a span the endpoint refuses instead of skipping it, and returns logs in chain order', async () => {
    const asked: string[] = [];
    const rpc: EvmRpc = {
      async call<T>(_method: string, params: unknown[]): Promise<T> {
        const { fromBlock, toBlock } = params[0] as { fromBlock: string; toBlock: string };
        const from = Number(BigInt(fromBlock));
        const to = Number(BigInt(toBlock));
        asked.push(`${from}-${to}`);
        if (to - from >= 4) throw new EvmRpcError('eth_getLogs', -32000, 'query returned more than 10000 results');
        return [raw(to, 1), raw(from, 0, { blockTimestamp: '0x65' }), raw(from, 2, { removed: true })] as T;
      },
    };
    const logs = await getLogs(rpc, { topics: ['0xaa'] }, 0, 7, 8);
    expect(asked).toEqual(['0-7', '0-3', '4-7']);
    expect(logs.map((l) => `${l.blockNumber}:${l.logIndex}`)).toEqual(['0:0', '3:1', '4:0', '7:1']);
    expect(logs[0]).toMatchObject({ address: A.toLowerCase(), blockTimestamp: 101 });
    expect(logs[1]!.blockTimestamp).toBeNull();
  });

  it('lets an error it cannot split through', async () => {
    const rpc: EvmRpc = { call: async () => { throw new EvmRpcError('eth_getLogs', -32602, 'invalid params'); } };
    await expect(getLogs(rpc, {}, 0, 100, 50)).rejects.toThrow(/invalid params/);
    const one: EvmRpc = { call: async () => { throw new EvmRpcUnavailable('eth_getLogs', 'HTTP 429'); } };
    await expect(getLogs(one, {}, 5, 5, 10)).rejects.toBeInstanceOf(EvmRpcUnavailable);
  });

  it('reads a block\'s time', async () => {
    const rpc: EvmRpc = { call: async <T>() => ({ timestamp: '0x6500' }) as T };
    expect(await blockTime(rpc, 9)).toBe(0x6500);
    await expect(blockTime({ call: async <T>() => null as T }, 9)).rejects.toThrow(/not returned/);
  });
});

describe('erc20', () => {
  it('reads what a token says and leaves the rest unknown', async () => {
    const rpc: EvmRpc = {
      async call<T>(_m: string, params: unknown[]): Promise<T> {
        const { data } = params[0] as { data: string };
        if (data === '0x313ce567') return `0x${uintWord(6n)}` as T;
        if (data === '0x95d89b41') return `0x${uintWord(32n)}${uintWord(4n)}${Buffer.from('USDG').toString('hex').padEnd(64, '0')}` as T;
        if (data === '0x18160ddd') throw new EvmRpcError('eth_call', 3, 'execution reverted');
        return '0x' as T;
      },
    };
    expect(await readErc20(rpc, A)).toEqual({ address: A.toLowerCase(), name: null, symbol: 'USDG', decimals: 6, totalSupply: null });
  });

  it('does not hide an endpoint that is down behind "unknown"', async () => {
    const rpc: EvmRpc = { call: async () => { throw new EvmRpcUnavailable('eth_call', 'HTTP 503'); } };
    await expect(readErc20(rpc, A)).rejects.toBeInstanceOf(EvmRpcUnavailable);
  });
});
