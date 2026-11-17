/**
 * The Pons curve's arithmetic, in integers, as the contract does it.
 *
 * The curve is a constant product against a quote reserve that includes a
 * phantom amount, so no real quote seeds it. A buy takes the fee, the creator
 * tax and any snipe tax off what is spent, and prices the rest; a sell prices
 * the tokens and takes the fee and the creator tax off what comes out.
 *
 * Checked against live trades: for each, the state one block earlier put
 * through these functions gives the amounts the trade's own event reports,
 * to the unit.
 */

import { BPS, MIN_NET_BPS } from './constants';

export class PonsQuoteError extends Error {
  constructor(
    readonly code: 'GRADUATED' | 'BAD_STATE' | 'BAD_AMOUNT' | 'ROUNDS_TO_ZERO' | 'FEES_CONSUME_TRADE',
    message: string,
  ) {
    super(message);
    this.name = 'PonsQuoteError';
  }
}

/** What a quote needs to know about a curve, all read from the chain. */
export interface CurveState {
  /** The reserve the curve prices against (phantom included). */
  readonly quoteReserve: bigint;
  readonly tokenReserve: bigint;
  /** Tokens still buyable before the curve completes. */
  readonly sellableTokens: bigint;
  readonly feeBps: bigint;
  readonly creatorTaxBps: bigint;
  readonly graduated: boolean;
}

export interface BuyMaths {
  readonly tokensOut: bigint;
  /** What the buy actually takes; less than the input when the curve runs out of tokens. */
  readonly spent: bigint;
  readonly refund: bigint;
  readonly fee: bigint;
  readonly creatorTax: bigint;
  readonly snipeTax: bigint;
  /** The snipe tax applied, after the contract's cap. */
  readonly snipeTaxBps: bigint;
}

export interface SellMaths {
  readonly quoteOut: bigint;
  /** Before the fee and the creator tax. */
  readonly grossQuoteOut: bigint;
  readonly fee: bigint;
  readonly creatorTax: bigint;
}

const amountOut = (amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint => (amountIn * reserveOut) / (reserveIn + amountIn);

const amountInFor = (out: bigint, reserveIn: bigint, reserveOut: bigint): bigint => {
  const numerator = out * reserveIn;
  const denominator = reserveOut - out;
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
};

const ceilDiv = (a: bigint, b: bigint): bigint => a / b + (a % b === 0n ? 0n : 1n);

function check(state: CurveState, amount: bigint): void {
  if (state.graduated) throw new PonsQuoteError('GRADUATED', 'the curve has graduated; the token trades in its pool now');
  if (amount <= 0n) throw new PonsQuoteError('BAD_AMOUNT', 'the amount must be positive');
  if (state.quoteReserve <= 0n || state.tokenReserve <= 0n) throw new PonsQuoteError('BAD_STATE', 'the curve has no reserves');
  if (state.feeBps < 0n || state.creatorTaxBps < 0n || state.feeBps + state.creatorTaxBps >= BPS) throw new PonsQuoteError('BAD_STATE', 'the curve reports fees of 100 % or more');
}

/** What `quoteIn` buys. `snipeTaxBps` is the curve's `currentSnipeTaxBps` for the recipient; 0 after the first seconds. */
export function buyMaths(state: CurveState, quoteIn: bigint, snipeTaxBps: bigint = 0n): BuyMaths {
  check(state, quoteIn);
  if (state.sellableTokens <= 0n || state.sellableTokens >= state.tokenReserve) throw new PonsQuoteError('BAD_STATE', 'the curve has nothing left to sell');
  if (snipeTaxBps < 0n) throw new PonsQuoteError('BAD_STATE', 'the snipe tax is negative');

  let snipeBps = snipeTaxBps;
  if (snipeBps > 0n) {
    const cap = BPS - state.feeBps - state.creatorTaxBps - MIN_NET_BPS;
    if (cap < 0n) throw new PonsQuoteError('BAD_STATE', 'fees leave less than one percent of the spend');
    if (snipeBps > cap) snipeBps = cap;
  }

  let spent = quoteIn;
  const split = (amount: bigint) => ({ fee: (amount * state.feeBps) / BPS, creatorTax: (amount * state.creatorTaxBps) / BPS, snipeTax: (amount * snipeBps) / BPS });
  let parts = split(spent);
  const net = spent - parts.fee - parts.creatorTax - parts.snipeTax;
  if (net <= 0n) throw new PonsQuoteError('FEES_CONSUME_TRADE', 'fees take the whole input');
  let tokensOut = amountOut(net, state.quoteReserve, state.tokenReserve);
  if (tokensOut === 0n) throw new PonsQuoteError('ROUNDS_TO_ZERO', 'the input is too small to buy one unit');

  // The curve sells no more than it has: the buy is cut to what fills it, and the rest is refunded.
  if (tokensOut > state.sellableTokens) {
    tokensOut = state.sellableTokens;
    const netNeeded = amountInFor(state.sellableTokens, state.quoteReserve, state.tokenReserve);
    const grossed = ceilDiv(netNeeded * BPS, BPS - (state.feeBps + state.creatorTaxBps + snipeBps));
    spent = grossed < quoteIn ? grossed : quoteIn;
    parts = split(spent);
  }

  return { tokensOut, spent, refund: quoteIn - spent, ...parts, snipeTaxBps: snipeBps };
}

/** What selling `tokensIn` pays. */
export function sellMaths(state: CurveState, tokensIn: bigint): SellMaths {
  check(state, tokensIn);
  const gross = amountOut(tokensIn, state.tokenReserve, state.quoteReserve);
  if (gross === 0n) throw new PonsQuoteError('ROUNDS_TO_ZERO', 'the input is too small to sell for one unit');
  const fee = (gross * state.feeBps) / BPS;
  const creatorTax = (gross * state.creatorTaxBps) / BPS;
  const quoteOut = gross - fee - creatorTax;
  if (quoteOut <= 0n) throw new PonsQuoteError('FEES_CONSUME_TRADE', 'fees take the whole output');
  return { quoteOut, grossQuoteOut: gross, fee, creatorTax };
}

/** The least output a trade accepts at a slippage tolerance in basis points. */
export function withSlippage(amount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) throw new PonsQuoteError('BAD_AMOUNT', 'slippage is a whole number of basis points from 0 to 9999');
  return (amount * (BPS - BigInt(slippageBps))) / BPS;
}

/**
 * Progress toward graduation, 0 to 100, from the quote actually paid in. Null when the threshold is not known.
 * The curve's own quote reserve must not be used here: it includes the phantom amount, which would show every new
 * token as part of the way there.
 */
export function progressPct(realQuoteReserve: bigint, graduationThreshold: bigint): number | null {
  if (graduationThreshold <= 0n || realQuoteReserve < 0n) return null;
  return Math.min(100, Number((realQuoteReserve * 10_000n) / graduationThreshold) / 100);
}

/**
 * The curve's spot price: quote base units per token base unit, as an exact fraction. Dividing it out as a number
 * needs both assets' decimals, which `spotPrice` takes.
 */
export function spotPrice(state: Pick<CurveState, 'quoteReserve' | 'tokenReserve'>, quoteDecimals: number, tokenDecimals: number): number | null {
  if (state.quoteReserve <= 0n || state.tokenReserve <= 0n) return null;
  if (!Number.isInteger(quoteDecimals) || !Number.isInteger(tokenDecimals)) return null;
  // Scaled so the integer division keeps eighteen digits whatever the two reserves are.
  const scaled = (state.quoteReserve * 10n ** BigInt(18 + tokenDecimals)) / (state.tokenReserve * 10n ** BigInt(quoteDecimals));
  return Number(scaled) / 1e18;
}
