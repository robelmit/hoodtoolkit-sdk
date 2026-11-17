/**
 * Quote, build, verify.
 *
 * `quote` reads the curve and says exactly what a trade gives. `buildTrade`
 * turns that into an unsigned transaction. `verifyTrade` re-reads the bytes
 * of any transaction and refuses it unless it is that quote's trade for that
 * wallet and nothing else: run it on the side that signs, on bytes that may
 * have passed through anything in between.
 *
 * Nothing here signs, sends or holds a key.
 */

import { ERC20, ROBINHOOD_CHAIN_ID, address, addressWord, decodeCall, encodeCall, isAddress, sameAddress, uintWord, type EvmRpc } from '@hoodtoolkit/evm';
import { CURVE } from './constants';
import { PonsQuoteError, buyMaths, sellMaths, withSlippage } from './curve';
import { findLaunch, readCurve, readSnipeTaxBps, type Curve } from './read';

export type Side = 'buy' | 'sell';

export interface QuoteRequest {
  readonly side: Side;
  /** The token. Give this or `curve`. */
  readonly token?: string;
  /** The token's curve contract, when you already know it. */
  readonly curve?: string;
  /** Base units of what goes in: the quote asset for a buy, the token for a sell. */
  readonly amountIn: bigint;
  /** Tolerance in basis points (100 = 1 %). */
  readonly slippageBps: number;
  /** The wallet that will sign, and receive what the trade pays. */
  readonly wallet: string;
}

export interface PonsQuote {
  readonly side: Side;
  readonly curve: string;
  readonly token: string;
  /** The quote asset; the zero address is the native coin. */
  readonly pairToken: string;
  readonly native: boolean;
  readonly wallet: string;
  readonly amountIn: bigint;
  /** What the trade is expected to pay: tokens for a buy, quote for a sell. */
  readonly amountOut: bigint;
  /** The floor the transaction carries. */
  readonly minAmountOut: bigint;
  readonly slippageBps: number;
  /** In the quote asset. */
  readonly fee: bigint;
  readonly creatorTax: bigint;
  /** Buys only; zero after the first seconds of a launch. */
  readonly snipeTax: bigint;
  /** A buy that would take more than the curve has left is cut down; this is what comes back. */
  readonly refund: bigint;
  /** The state the numbers come from. */
  readonly state: Curve;
}

export class NotAPonsToken extends Error {
  constructor(token: string) {
    super(`${token} was not launched by the Pons factory`);
    this.name = 'NotAPonsToken';
  }
}

export async function quote(rpc: EvmRpc, request: QuoteRequest): Promise<PonsQuote> {
  if (!isAddress(request.wallet)) throw new PonsQuoteError('BAD_AMOUNT', 'the wallet is not an address');
  if (typeof request.amountIn !== 'bigint') throw new PonsQuoteError('BAD_AMOUNT', 'amountIn is a bigint of base units');
  let curveAddress = request.curve;
  if (!curveAddress) {
    if (!request.token) throw new PonsQuoteError('BAD_AMOUNT', 'give a token or a curve');
    const launch = await findLaunch(rpc, request.token);
    if (!launch) throw new NotAPonsToken(request.token);
    curveAddress = launch.curve;
  }
  const state = await readCurve(rpc, curveAddress);
  if (request.token && !sameAddress(request.token, state.token)) throw new PonsQuoteError('BAD_STATE', 'the curve is not this token\'s curve');
  const common = { side: request.side, curve: state.curve, token: state.token, pairToken: state.pairToken, native: state.native, wallet: address(request.wallet), amountIn: request.amountIn, slippageBps: request.slippageBps, state };
  if (request.side === 'buy') {
    const snipe = await readSnipeTaxBps(rpc, state.curve, request.wallet);
    const m = buyMaths(state, request.amountIn, snipe);
    return { ...common, amountOut: m.tokensOut, minAmountOut: withSlippage(m.tokensOut, request.slippageBps), fee: m.fee, creatorTax: m.creatorTax, snipeTax: m.snipeTax, refund: m.refund };
  }
  const m = sellMaths(state, request.amountIn);
  return { ...common, amountOut: m.quoteOut, minAmountOut: withSlippage(m.quoteOut, request.slippageBps), fee: m.fee, creatorTax: m.creatorTax, snipeTax: 0n, refund: 0n };
}

/** An unsigned transaction, as a wallet or a signing library takes it. */
export interface UnsignedTx {
  readonly chainId: number;
  readonly from: string;
  readonly to: string;
  readonly data: string;
  /** Wei sent with the call. */
  readonly value: bigint;
}

/** The quote's trade as an unsigned transaction. Gas and nonce are the signer's to set. */
export function buildTrade(q: PonsQuote): UnsignedTx {
  const selector = q.side === 'buy' ? CURVE.buy : CURVE.sell;
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    from: q.wallet,
    to: q.curve,
    data: encodeCall(selector, [uintWord(q.amountIn), uintWord(q.minAmountOut), addressWord(q.wallet)]),
    // Only a buy paid in the native coin carries value.
    value: q.side === 'buy' && q.native ? q.amountIn : 0n,
  };
}

/**
 * The approval a trade needs first, or null when it needs none: a buy paid in a token lets the curve take that
 * token, and a sell lets the curve take the token sold. The amount is exactly the trade's, never unlimited.
 */
export function approvalFor(q: PonsQuote): UnsignedTx | null {
  if (q.side === 'buy' && q.native) return null;
  const asset = q.side === 'buy' ? q.pairToken : q.token;
  return { chainId: ROBINHOOD_CHAIN_ID, from: q.wallet, to: asset, data: encodeCall(ERC20.approve, [addressWord(q.curve), uintWord(q.amountIn)]), value: 0n };
}

export class TradeMismatch extends Error {
  constructor(readonly reason: string) {
    super(`the transaction is not the quoted trade: ${reason}`);
    this.name = 'TradeMismatch';
  }
}

/**
 * Refuses a transaction unless it is exactly the quote's trade: the quote's curve, the right function, the quoted
 * amount, a floor no lower than the quote's, the wallet as the recipient, and the right value. Throws
 * `TradeMismatch` with the reason; returns nothing when the bytes are right.
 */
export function verifyTrade(tx: { readonly chainId?: number; readonly to: string; readonly data: string; readonly value?: bigint }, q: PonsQuote): void {
  if (tx.chainId !== undefined && tx.chainId !== ROBINHOOD_CHAIN_ID) throw new TradeMismatch(`chain ${tx.chainId} is not Robinhood Chain`);
  if (!isAddress(tx.to) || !sameAddress(tx.to, q.curve)) throw new TradeMismatch('it does not call the quote\'s curve');
  let call: ReturnType<typeof decodeCall>;
  try {
    call = decodeCall(tx.data);
  } catch {
    throw new TradeMismatch('the calldata cannot be read');
  }
  if (call.selector !== (q.side === 'buy' ? CURVE.buy : CURVE.sell)) throw new TradeMismatch(`it does not call ${q.side}`);
  if (call.words.length !== 3) throw new TradeMismatch('it has extra or missing arguments');
  if (BigInt(`0x${call.words[0]}`) !== q.amountIn) throw new TradeMismatch('the amount is not the quoted amount');
  if (BigInt(`0x${call.words[1]}`) < q.minAmountOut) throw new TradeMismatch('the floor is lower than the quote\'s');
  if (call.words[2] !== addressWord(q.wallet)) throw new TradeMismatch('the recipient is not the wallet');
  const expectedValue = q.side === 'buy' && q.native ? q.amountIn : 0n;
  if ((tx.value ?? 0n) !== expectedValue) throw new TradeMismatch('the value sent is not what the trade needs');
}

/**
 * Refuses an approval unless it lets the quote's curve take exactly the trade's amount of the right asset. An
 * unlimited approval, or one to any other spender, is refused.
 */
export function verifyApproval(tx: { readonly to: string; readonly data: string; readonly value?: bigint }, q: PonsQuote): void {
  const asset = q.side === 'buy' ? q.pairToken : q.token;
  if (q.side === 'buy' && q.native) throw new TradeMismatch('a buy paid in the native coin needs no approval');
  if (!isAddress(tx.to) || !sameAddress(tx.to, asset)) throw new TradeMismatch('it does not approve the trade\'s asset');
  let call: ReturnType<typeof decodeCall>;
  try {
    call = decodeCall(tx.data);
  } catch {
    throw new TradeMismatch('the calldata cannot be read');
  }
  if (call.selector !== ERC20.approve || call.words.length !== 2) throw new TradeMismatch('it is not an approval');
  if (call.words[0] !== addressWord(q.curve)) throw new TradeMismatch('the spender is not the quote\'s curve');
  if (BigInt(`0x${call.words[1]}`) !== q.amountIn) throw new TradeMismatch('the approved amount is not the trade\'s amount');
  if ((tx.value ?? 0n) !== 0n) throw new TradeMismatch('an approval sends no value');
}
