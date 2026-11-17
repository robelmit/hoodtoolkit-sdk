/**
 * Reading event logs in ranges an endpoint will actually serve.
 *
 * Robinhood Chain makes about ten blocks a second, and its public endpoint
 * limits `eth_getLogs` by the size of the answer, not by how often it is
 * asked: a query with no address over a few dozen blocks is refused, while a
 * query for one contract's events is served over a very long range. So the
 * span is the caller's to choose per query, and a refused span is halved and
 * tried again instead of being skipped. A skipped span is a silent gap.
 */

import { toQuantity } from './abi';
import { EvmRpcError, EvmRpcUnavailable, type EvmRpc } from './rpc';

export interface EvmLog {
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string;
  readonly blockNumber: number;
  readonly transactionHash: string;
  readonly logIndex: number;
  /** Seconds since the epoch, when the endpoint gives it with the log; null otherwise. */
  readonly blockTimestamp: number | null;
}

export interface LogFilter {
  readonly address?: string | readonly string[];
  /** Topic filters by position; an array at a position matches any of its values. */
  readonly topics?: readonly (string | readonly string[] | null)[];
}

/** A span no address filter is needed for on the public endpoint. */
export const UNFILTERED_LOG_SPAN = 10;
/** A span that works when the query names its contracts. */
export const FILTERED_LOG_SPAN = 20_000;

/** Inclusive `[from, to]` pairs covering a block range, each at most `span` blocks. */
export function logRanges(fromBlock: number, toBlock: number, span: number): { from: number; to: number }[] {
  if (!Number.isInteger(fromBlock) || !Number.isInteger(toBlock) || fromBlock < 0) throw new Error('block numbers are non-negative integers');
  if (!Number.isInteger(span) || span < 1) throw new Error('a span is at least one block');
  const ranges: { from: number; to: number }[] = [];
  for (let start = fromBlock; start <= toBlock; start += span) ranges.push({ from: start, to: Math.min(start + span - 1, toBlock) });
  return ranges;
}

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  blockTimestamp?: string;
  removed?: boolean;
}

function parseLog(raw: RawLog): EvmLog | null {
  if (raw.removed === true) return null;
  if (typeof raw.address !== 'string' || !Array.isArray(raw.topics) || typeof raw.data !== 'string') return null;
  const timestamp = typeof raw.blockTimestamp === 'string' ? Number(BigInt(raw.blockTimestamp)) : 0;
  return {
    address: raw.address.toLowerCase(),
    topics: raw.topics,
    data: raw.data,
    blockNumber: Number(BigInt(raw.blockNumber)),
    transactionHash: raw.transactionHash,
    logIndex: Number(BigInt(raw.logIndex)),
    // Some endpoints answer 0 for the timestamp on long ranges; that is "not given", not 1970.
    blockTimestamp: timestamp > 0 ? timestamp : null,
  };
}

const tooLarge = (error: unknown): boolean =>
  error instanceof EvmRpcUnavailable || (error instanceof EvmRpcError && /limit|too many|too large|more than|exceed|range|timeout|response size/i.test(error.message));

/**
 * Every matching log of a block range, in chain order. The range is read in spans of at most `span` blocks; a span
 * the endpoint refuses is halved and read again, down to one block, where the error is the caller's to see.
 */
export async function getLogs(rpc: EvmRpc, filter: LogFilter, fromBlock: number, toBlock: number, span: number): Promise<EvmLog[]> {
  const out: EvmLog[] = [];
  const read = async (from: number, to: number): Promise<void> => {
    let raw: RawLog[];
    try {
      raw = await rpc.call<RawLog[]>('eth_getLogs', [{ ...filter, fromBlock: toQuantity(from), toBlock: toQuantity(to) }]);
    } catch (error) {
      if (from === to || !tooLarge(error)) throw error;
      const middle = from + Math.floor((to - from) / 2);
      await read(from, middle);
      await read(middle + 1, to);
      return;
    }
    if (!Array.isArray(raw)) throw new EvmRpcError('eth_getLogs', null, 'the answer is not a list');
    for (const item of raw) {
      const log = parseLog(item);
      if (log) out.push(log);
    }
  };
  for (const range of logRanges(fromBlock, toBlock, span)) await read(range.from, range.to);
  return out.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

/** A block's time in seconds since the epoch. */
export async function blockTime(rpc: EvmRpc, block: number): Promise<number> {
  const header = await rpc.call<{ timestamp?: string } | null>('eth_getBlockByNumber', [toQuantity(block), false]);
  if (!header || typeof header.timestamp !== 'string') throw new EvmRpcError('eth_getBlockByNumber', null, `block ${block} was not returned`);
  return Number(BigInt(header.timestamp));
}
