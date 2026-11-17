/**
 * Decoding Pons events. Each decoder returns `null` for a log it does not
 * recognise or cannot read, so one odd log never abandons a range and leaves
 * a gap.
 *
 * Three things are per launch and must be read, never assumed: the
 * graduation threshold, the quote asset (the native coin, a dollar coin, or a
 * tokenized stock), and so the quote asset's decimals.
 */

import { addressAt, topicAddress, uintAt, wordCount } from '@hood-toolkit/evm';
import { PONS_TOPICS } from './constants';

export interface RawLog {
  readonly topics: readonly string[];
  readonly data: string;
}

export interface PonsLaunch {
  readonly token: string;
  /** The token's own curve contract. Trades happen here until it graduates. */
  readonly curve: string;
  readonly deployer: string;
  /** The quote asset. The zero address means the native coin (ETH). */
  readonly pairToken: string;
  readonly launchConfigId: bigint;
  /** In base units of the quote asset. */
  readonly graduationThreshold: bigint;
}

export interface PonsTrade {
  readonly side: 'buy' | 'sell';
  /** Who called the curve. */
  readonly trader: string;
  /** Who received the tokens (buy) or the quote (sell). */
  readonly recipient: string;
  /** Quote paid in (buy) or received (sell), in base units of the quote asset. */
  readonly quoteAmount: bigint;
  /** Tokens received (buy) or sold (sell), in base units (18 decimals). */
  readonly tokenAmount: bigint;
  /** The curve's fee, in the quote asset. */
  readonly fee: bigint;
  /** Creator tax plus any snipe tax, in the quote asset. */
  readonly tax: bigint;
}

export interface PonsGraduation {
  readonly token: string;
  readonly positionId: bigint;
  /** Tokens placed in the pool. */
  readonly tokenAmount: bigint;
  /** Quote placed in the pool, in base units of the quote asset. */
  readonly pairTokenAmount: bigint;
}

export interface PonsSweep {
  readonly token: string;
  readonly quoteOut: bigint;
  readonly tokenOut: bigint;
}

const safely = <T>(decode: () => T): T | null => {
  try {
    return decode();
  } catch {
    return null;
  }
};

export function decodeLaunch(log: RawLog): PonsLaunch | null {
  if (log.topics[0] !== PONS_TOPICS.tokenLaunched || log.topics.length < 4) return null;
  return safely(() => {
    if (wordCount(log.data) < 3) throw new Error('short');
    return {
      token: topicAddress(log.topics[1]!),
      curve: topicAddress(log.topics[2]!),
      deployer: topicAddress(log.topics[3]!),
      pairToken: addressAt(log.data, 0),
      launchConfigId: uintAt(log.data, 1),
      graduationThreshold: uintAt(log.data, 2),
    };
  });
}

export function decodeTrade(log: RawLog): PonsTrade | null {
  const side = log.topics[0] === PONS_TOPICS.curveBuy ? 'buy' : log.topics[0] === PONS_TOPICS.curveSell ? 'sell' : null;
  if (!side || log.topics.length < 3) return null;
  return safely(() => {
    if (wordCount(log.data) < 4) throw new Error('short');
    const first = uintAt(log.data, 0);
    const second = uintAt(log.data, 1);
    return {
      side,
      trader: topicAddress(log.topics[1]!),
      recipient: topicAddress(log.topics[2]!),
      // A buy is quote in, tokens out; a sell is tokens in, quote out.
      quoteAmount: side === 'buy' ? first : second,
      tokenAmount: side === 'buy' ? second : first,
      fee: uintAt(log.data, 2),
      tax: uintAt(log.data, 3),
    };
  });
}

export function decodeGraduation(log: RawLog): PonsGraduation | null {
  if (log.topics[0] !== PONS_TOPICS.poolGraduated || log.topics.length < 2) return null;
  return safely(() => {
    if (wordCount(log.data) < 3) throw new Error('short');
    return { token: topicAddress(log.topics[1]!), positionId: uintAt(log.data, 0), tokenAmount: uintAt(log.data, 1), pairTokenAmount: uintAt(log.data, 2) };
  });
}

export function decodeSweep(log: RawLog): PonsSweep | null {
  if (log.topics[0] !== PONS_TOPICS.launchSwept || log.topics.length < 2) return null;
  return safely(() => {
    if (wordCount(log.data) < 2) throw new Error('short');
    return { token: topicAddress(log.topics[1]!), quoteOut: uintAt(log.data, 0), tokenOut: uintAt(log.data, 1) };
  });
}

/**
 * True while a buy's tax is a tenth of the trade or more. In the first seconds after a launch buys carry a decaying
 * snipe tax, so their effective prices are real but not representative; keep them in a trade list and out of a
 * price series.
 */
export function isSnipeTaxed(trade: Pick<PonsTrade, 'tax' | 'quoteAmount'>): boolean {
  if (trade.quoteAmount <= 0n) return false;
  return (trade.tax * 100n) / trade.quoteAmount >= 10n;
}
