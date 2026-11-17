/** Reading a Pons launch and its curve from the chain. Everything per-launch is read; nothing is assumed. */

import { ZERO_ADDRESS, address, addressAt, addressWord, boolAt, encodeCall, ethCall, isAddress, readErc20, sameAddress, uintAt, wordCount, type Erc20Facts, type EvmRpc } from '@hood-toolkit/evm';
import { CURVE, FACTORY, PONS_FACTORY, PONS_TOKEN_DECIMALS } from './constants';
import type { CurveState } from './curve';

export interface LaunchRecord {
  readonly token: string;
  readonly curve: string;
  readonly deployer: string;
  /** The zero address means the native coin. */
  readonly pairToken: string;
  readonly graduationThreshold: bigint;
  readonly creatorTaxBps: bigint;
}

/** The factory's record of a token it launched, or null when it did not launch that token. */
export async function findLaunch(rpc: EvmRpc, token: string, factory: string = PONS_FACTORY): Promise<LaunchRecord | null> {
  const data = await ethCall(rpc, factory, encodeCall(FACTORY.getLaunchedToken, [addressWord(token)]));
  // (token, curve, deployer, creatorFeeRecipient, pairToken, graduationThreshold, poolFee, tickSpacing, creatorTaxBps,
  //  buybackEnabled, phase, sweptQuote, sweptTokens, sweptAt, exists)
  if (wordCount(data) < 15 || !boolAt(data, 14)) return null;
  const curve = addressAt(data, 1);
  if (sameAddress(curve, ZERO_ADDRESS)) return null;
  return { token: addressAt(data, 0), curve, deployer: addressAt(data, 2), pairToken: addressAt(data, 4), graduationThreshold: uintAt(data, 5), creatorTaxBps: uintAt(data, 8) };
}

export interface Curve extends CurveState {
  readonly curve: string;
  readonly token: string;
  /** The zero address means the native coin. */
  readonly pairToken: string;
  readonly native: boolean;
  /** The quote asset's decimals: 18 for the native coin, read from the token otherwise; null when it does not say. */
  readonly pairDecimals: number | null;
  readonly pairSymbol: string | null;
  readonly tokenDecimals: number;
  /** Quote actually paid in. */
  readonly realQuoteReserve: bigint;
  readonly graduationThreshold: bigint;
  readonly readyToGraduate: boolean;
  /** The block the state was read at. */
  readonly block: string;
}

/**
 * A curve's whole state at one block. Pass `block` (a hex block number) to read the past; every value comes from
 * that same block, so the quote built on it is consistent.
 */
export async function readCurve(rpc: EvmRpc, curve: string, block: string = 'latest', readToken: (token: string) => Promise<Erc20Facts> = (token) => readErc20(rpc, token)): Promise<Curve> {
  const to = address(curve);
  const view = (selector: string): Promise<string> => ethCall(rpc, to, selector, block);
  const [quoteReserve, tokenReserve, sellable, real, threshold, feeBps, creatorTaxBps, pairToken, token, graduated, ready] = await Promise.all([
    view(CURVE.quoteReserve),
    view(CURVE.tokenReserve),
    view(CURVE.sellableTokens),
    view(CURVE.realQuoteReserve),
    view(CURVE.graduationThreshold),
    view(CURVE.feeBps),
    view(CURVE.creatorTaxBps),
    view(CURVE.pairToken),
    view(CURVE.token),
    view(CURVE.graduated),
    view(CURVE.readyToGraduate),
  ]);
  const pair = addressAt(pairToken, 0);
  const native = sameAddress(pair, ZERO_ADDRESS);
  // A quote asset's symbol and decimals do not change; a caller that follows many curves passes a cached reader.
  const pairFacts = native ? null : await readToken(pair);
  return {
    curve: to,
    token: addressAt(token, 0),
    pairToken: pair,
    native,
    pairDecimals: native ? 18 : (pairFacts?.decimals ?? null),
    pairSymbol: native ? 'ETH' : (pairFacts?.symbol ?? null),
    tokenDecimals: PONS_TOKEN_DECIMALS,
    quoteReserve: uintAt(quoteReserve, 0),
    tokenReserve: uintAt(tokenReserve, 0),
    sellableTokens: uintAt(sellable, 0),
    realQuoteReserve: uintAt(real, 0),
    graduationThreshold: uintAt(threshold, 0),
    feeBps: uintAt(feeBps, 0),
    creatorTaxBps: uintAt(creatorTaxBps, 0),
    graduated: boolAt(graduated, 0),
    readyToGraduate: boolAt(ready, 0),
    block,
  };
}

/** The part of a curve that moves with every trade. */
export interface CurveReserves {
  readonly quoteReserve: bigint;
  readonly tokenReserve: bigint;
  readonly realQuoteReserve: bigint;
  readonly graduated: boolean;
}

/** Only what trades change: four reads, where `readCurve` makes eleven. For following a curve after its first read. */
export async function readReserves(rpc: EvmRpc, curve: string, block: string = 'latest'): Promise<CurveReserves> {
  const to = address(curve);
  const [quoteReserve, tokenReserve, real, graduated] = await Promise.all([ethCall(rpc, to, CURVE.quoteReserve, block), ethCall(rpc, to, CURVE.tokenReserve, block), ethCall(rpc, to, CURVE.realQuoteReserve, block), ethCall(rpc, to, CURVE.graduated, block)]);
  return { quoteReserve: uintAt(quoteReserve, 0), tokenReserve: uintAt(tokenReserve, 0), realQuoteReserve: uintAt(real, 0), graduated: boolAt(graduated, 0) };
}

/** The snipe tax a buy for `recipient` would carry right now, in basis points. It decays to zero within seconds of launch. */
export async function readSnipeTaxBps(rpc: EvmRpc, curve: string, recipient: string, block: string = 'latest'): Promise<bigint> {
  if (!isAddress(recipient)) throw new Error('the recipient is not an address');
  return uintAt(await ethCall(rpc, address(curve), encodeCall(CURVE.currentSnipeTaxBps, [addressWord(recipient)]), block), 0);
}
