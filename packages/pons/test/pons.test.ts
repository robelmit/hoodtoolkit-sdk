import { readFileSync } from 'node:fs';
import { ERC20, ROBINHOOD_CHAIN_ID, ZERO_ADDRESS, addressWord, encodeCall, uintWord, type EvmRpc } from '@hoodtoolkit/evm';
import { describe, expect, it } from 'vitest';
import {
  CURVE,
  FACTORY,
  PONS_FACTORY,
  NotAPonsToken,
  PonsQuoteError,
  TradeMismatch,
  approvalFor,
  buildTrade,
  buyMaths,
  decodeGraduation,
  decodeLaunch,
  decodeSweep,
  decodeTrade,
  findLaunch,
  isSnipeTaxed,
  progressPct,
  quote,
  readCurve,
  sellMaths,
  spotPrice,
  verifyApproval,
  verifyTrade,
  withSlippage,
  type CurveState,
} from '../src';

interface TradeCase {
  side: 'buy' | 'sell';
  curve: string;
  log: { topics: string[]; data: string };
  state: Record<string, string>;
}
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T;
const TRADES = fixture<TradeCase[]>('trades.json');
const FACTORY_LOGS = fixture<{ launches: { topics: string[]; data: string }[]; graduations: { topics: string[]; data: string }[]; sweeps: { topics: string[]; data: string }[] }>('factory.json');

const stateOf = (c: TradeCase): CurveState => ({
  quoteReserve: BigInt(c.state['quoteReserve']!),
  tokenReserve: BigInt(c.state['tokenReserve']!),
  sellableTokens: BigInt(c.state['sellableTokens']!),
  feeBps: BigInt(c.state['feeBps']!),
  creatorTaxBps: BigInt(c.state['creatorTaxBps']!),
  graduated: false,
});

describe('the curve maths against real trades', () => {
  it('gives, from the state one block before, exactly what each recorded trade reports', () => {
    expect(TRADES.length).toBe(24);
    for (const c of TRADES) {
      const trade = decodeTrade(c.log)!;
      expect(trade.side).toBe(c.side);
      if (c.side === 'buy') {
        const m = buyMaths(stateOf(c), trade.quoteAmount, BigInt(c.state['snipeTaxBps']!));
        expect(m.tokensOut, c.curve).toBe(trade.tokenAmount);
        expect(m.fee).toBe(trade.fee);
        expect(m.creatorTax + m.snipeTax).toBe(trade.tax);
        expect(m.refund).toBe(0n);
      } else {
        const m = sellMaths(stateOf(c), trade.tokenAmount);
        expect(m.quoteOut, c.curve).toBe(trade.quoteAmount);
        expect(m.fee).toBe(trade.fee);
        expect(m.creatorTax).toBe(trade.tax);
      }
    }
    // The recording covers curves with and without a creator tax, and both sides.
    expect(new Set(TRADES.map((c) => c.state['creatorTaxBps'])).size).toBeGreaterThan(1);
    expect(TRADES.some((c) => c.side === 'sell')).toBe(true);
  });
});

describe('the curve maths at its edges', () => {
  const state: CurveState = { quoteReserve: 1_000n * 10n ** 18n, tokenReserve: 1_000_000n * 10n ** 18n, sellableTokens: 700_000n * 10n ** 18n, feeBps: 100n, creatorTaxBps: 200n, graduated: false };

  it('cuts a buy that would take more than the curve has, and refunds the rest', () => {
    const huge = 10n ** 24n;
    const m = buyMaths(state, huge);
    expect(m.tokensOut).toBe(state.sellableTokens);
    expect(m.spent).toBeLessThan(huge);
    expect(m.refund).toBe(huge - m.spent);
    // What was spent, net of fees, buys at least the whole remainder.
    const net = m.spent - m.fee - m.creatorTax - m.snipeTax;
    expect((net * state.tokenReserve) / (state.quoteReserve + net)).toBeGreaterThanOrEqual(state.sellableTokens);
  });

  it('caps the snipe tax so the curve always keeps one percent of the spend', () => {
    const m = buyMaths(state, 10n ** 18n, 9_900n);
    expect(m.snipeTaxBps).toBe(10_000n - 100n - 200n - 100n);
    expect(m.spent - m.fee - m.creatorTax - m.snipeTax).toBe(10n ** 16n);
    expect(buyMaths(state, 10n ** 18n, 0n).snipeTax).toBe(0n);
  });

  it('refuses what it cannot quote, with a code', () => {
    const code = (run: () => unknown): string => {
      try {
        run();
        return 'quoted';
      } catch (error) {
        return error instanceof PonsQuoteError ? error.code : 'other';
      }
    };
    expect(code(() => buyMaths({ ...state, graduated: true }, 1n))).toBe('GRADUATED');
    expect(code(() => sellMaths({ ...state, graduated: true }, 1n))).toBe('GRADUATED');
    expect(code(() => buyMaths(state, 0n))).toBe('BAD_AMOUNT');
    // One unit of a quote asset worth far more than a token unit buys nothing.
    expect(code(() => buyMaths({ ...state, quoteReserve: 10n ** 30n, tokenReserve: 10n ** 6n, sellableTokens: 10n ** 5n }, 1n))).toBe('ROUNDS_TO_ZERO');
    expect(code(() => sellMaths(state, 1n))).toBe('ROUNDS_TO_ZERO');
    expect(code(() => buyMaths({ ...state, quoteReserve: 0n }, 10n ** 18n))).toBe('BAD_STATE');
    expect(code(() => buyMaths({ ...state, sellableTokens: 0n }, 10n ** 18n))).toBe('BAD_STATE');
    expect(code(() => buyMaths({ ...state, feeBps: 9_000n, creatorTaxBps: 1_000n }, 10n ** 18n))).toBe('BAD_STATE');
    expect(code(() => withSlippage(100n, 10_000))).toBe('BAD_AMOUNT');
  });

  it('applies slippage, reads progress from the real reserve, and prices with both assets\' decimals', () => {
    expect(withSlippage(1_000_000n, 300)).toBe(970_000n);
    expect(withSlippage(1_000_000n, 0)).toBe(1_000_000n);
    expect(progressPct(21n * 10n ** 17n, 42n * 10n ** 17n)).toBe(50);
    expect(progressPct(10n ** 30n, 42n * 10n ** 17n)).toBe(100);
    expect(progressPct(1n, 0n)).toBeNull();
    // 1,000 ETH against 1,000,000 tokens, both 18 decimals: 0.001 ETH a token.
    expect(spotPrice(state, 18, 18)).toBeCloseTo(0.001, 12);
    // The same reserves read as a 6-decimal dollar coin are a very different price: decimals are never assumed.
    expect(spotPrice({ quoteReserve: 8_090_000_000n, tokenReserve: 10n ** 27n }, 6, 18)).toBeCloseTo(0.00000809, 12);
    expect(spotPrice({ quoteReserve: 0n, tokenReserve: 1n }, 18, 18)).toBeNull();
  });
});

describe('events', () => {
  it('decodes real launches, with the quote asset and threshold each one carries', () => {
    const launches = FACTORY_LOGS.launches.map(decodeLaunch);
    expect(launches.every((l) => l !== null)).toBe(true);
    const native = launches.find((l) => l!.pairToken === ZERO_ADDRESS)!;
    expect(native.graduationThreshold).toBe(4_200_000_000_000_000_000n);
    const tokenPaired = launches.at(-1)!;
    expect(tokenPaired.pairToken).not.toBe(ZERO_ADDRESS);
    expect(tokenPaired.pairToken).toMatch(/^0x[0-9a-f]{40}$/);
    for (const l of launches) expect(l!.curve).not.toBe(l!.token);
  });

  it('decodes a real graduation and a real sweep', () => {
    const graduation = decodeGraduation(FACTORY_LOGS.graduations[0]!)!;
    expect(graduation.token).toMatch(/^0x[0-9a-f]{40}$/);
    expect(graduation.tokenAmount > 0n && graduation.pairTokenAmount > 0n).toBe(true);
    const sweep = decodeSweep(FACTORY_LOGS.sweeps[0]!)!;
    expect(sweep.quoteOut > 0n && sweep.tokenOut > 0n).toBe(true);
  });

  it('returns null for a log that is not the event, is short, or carries a non-address', () => {
    const launch = FACTORY_LOGS.launches[0]!;
    expect(decodeTrade(launch)).toBeNull();
    expect(decodeLaunch(TRADES[0]!.log)).toBeNull();
    expect(decodeLaunch({ topics: launch.topics.slice(0, 3), data: launch.data })).toBeNull();
    expect(decodeLaunch({ topics: launch.topics, data: launch.data.slice(0, 100) })).toBeNull();
    expect(decodeLaunch({ topics: launch.topics, data: `0x${'f'.repeat(192)}` })).toBeNull();
    expect(decodeTrade({ topics: TRADES[0]!.log.topics, data: '0x' })).toBeNull();
    expect(decodeGraduation(launch)).toBeNull();
  });

  it('marks a buy whose tax is a tenth of the trade or more', () => {
    expect(isSnipeTaxed({ tax: 10n, quoteAmount: 100n })).toBe(true);
    expect(isSnipeTaxed({ tax: 9n, quoteAmount: 100n })).toBe(false);
    expect(isSnipeTaxed({ tax: 1n, quoteAmount: 0n })).toBe(false);
  });
});

// A fake chain with one native-quoted curve and one paid in a 6-decimal dollar coin.
const CURVE_A = '0x00000000000000000000000000000000000000a1';
const CURVE_B = '0x00000000000000000000000000000000000000b1';
const TOKEN_A = '0x00000000000000000000000000000000000000a2';
const TOKEN_B = '0x00000000000000000000000000000000000000b2';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WALLET = '0x00000000000000000000000000000000000000ee';

function fakeChain(over: { graduated?: boolean; snipe?: bigint } = {}): { rpc: EvmRpc; calls: string[] } {
  const calls: string[] = [];
  const word = (v: bigint | string): string => (typeof v === 'bigint' ? uintWord(v) : addressWord(v));
  const curves: Record<string, Record<string, string>> = {
    [CURVE_A]: { [CURVE.quoteReserve]: word(1_000n * 10n ** 18n), [CURVE.tokenReserve]: word(10n ** 24n), [CURVE.sellableTokens]: word(7n * 10n ** 23n), [CURVE.realQuoteReserve]: word(21n * 10n ** 17n), [CURVE.graduationThreshold]: word(42n * 10n ** 17n), [CURVE.feeBps]: word(100n), [CURVE.creatorTaxBps]: word(200n), [CURVE.pairToken]: word(ZERO_ADDRESS), [CURVE.token]: word(TOKEN_A), [CURVE.graduated]: word(over.graduated ? 1n : 0n), [CURVE.readyToGraduate]: word(0n) },
    [CURVE_B]: { [CURVE.quoteReserve]: word(5_000_000_000n), [CURVE.tokenReserve]: word(10n ** 27n), [CURVE.sellableTokens]: word(7n * 10n ** 26n), [CURVE.realQuoteReserve]: word(1_000_000n), [CURVE.graduationThreshold]: word(8_090_000_000n), [CURVE.feeBps]: word(100n), [CURVE.creatorTaxBps]: word(0n), [CURVE.pairToken]: word(USDG), [CURVE.token]: word(TOKEN_B), [CURVE.graduated]: word(0n), [CURVE.readyToGraduate]: word(0n) },
  };
  const record = (token: string, curve: string, pair: string): string => `0x${[word(token), word(curve), word(WALLET), word(WALLET), word(pair), word(42n), word(0n), word(0n), word(200n), word(0n), word(0n), word(0n), word(0n), word(0n), word(1n)].join('')}`;
  const rpc: EvmRpc = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push(method);
      if (method !== 'eth_call') throw new Error(`unexpected ${method}`);
      const { to, data } = params[0] as { to: string; data: string };
      const selector = data.slice(0, 10);
      if (to === PONS_FACTORY && selector === FACTORY.getLaunchedToken) {
        const token = `0x${data.slice(34)}`;
        if (token === TOKEN_A) return record(TOKEN_A, CURVE_A, ZERO_ADDRESS) as T;
        if (token === TOKEN_B) return record(TOKEN_B, CURVE_B, USDG) as T;
        return `0x${'0'.repeat(64 * 15)}` as T;
      }
      if (to === USDG) {
        if (selector === ERC20.decimals) return `0x${word(6n)}` as T;
        if (selector === ERC20.symbol) return `0x${word(32n)}${word(4n)}${Buffer.from('USDG').toString('hex').padEnd(64, '0')}` as T;
        return '0x' as T;
      }
      if (selector === CURVE.currentSnipeTaxBps) return `0x${word(over.snipe ?? 0n)}` as T;
      const answer = curves[to]?.[selector];
      if (!answer) throw new Error(`no fake for ${to} ${selector}`);
      return `0x${answer}` as T;
    },
  };
  return { rpc, calls };
}

describe('reading a launch and its curve', () => {
  it('reads the factory\'s record, and answers null for a token the factory did not launch', async () => {
    const { rpc } = fakeChain();
    expect(await findLaunch(rpc, TOKEN_A)).toEqual({ token: TOKEN_A, curve: CURVE_A, deployer: WALLET, pairToken: ZERO_ADDRESS, graduationThreshold: 42n, creatorTaxBps: 200n });
    expect(await findLaunch(rpc, WALLET)).toBeNull();
  });

  it('reads the quote asset\'s own decimals and symbol, and never assumes eighteen', async () => {
    const { rpc } = fakeChain();
    expect(await readCurve(rpc, CURVE_A)).toMatchObject({ native: true, pairDecimals: 18, pairSymbol: 'ETH', token: TOKEN_A, feeBps: 100n });
    const usdg = await readCurve(rpc, CURVE_B);
    expect(usdg).toMatchObject({ native: false, pairToken: USDG, pairDecimals: 6, pairSymbol: 'USDG' });
    // 8,090 dollars, not 8.09e-9 of something: one million units paid in is 0.01 % of the way.
    expect(progressPct(usdg.realQuoteReserve, usdg.graduationThreshold)).toBe(0.01);
  });
});

describe('quote, build, verify', () => {
  it('quotes a native-coin buy and builds exactly that call', async () => {
    const { rpc } = fakeChain();
    const q = await quote(rpc, { side: 'buy', token: TOKEN_A, amountIn: 10n ** 18n, slippageBps: 300, wallet: WALLET });
    const m = buyMaths(q.state, 10n ** 18n);
    expect(q).toMatchObject({ side: 'buy', curve: CURVE_A, token: TOKEN_A, native: true, amountOut: m.tokensOut, minAmountOut: withSlippage(m.tokensOut, 300), fee: 10n ** 16n, creatorTax: 2n * 10n ** 16n, snipeTax: 0n });
    const tx = buildTrade(q);
    expect(tx).toEqual({ chainId: ROBINHOOD_CHAIN_ID, from: WALLET, to: CURVE_A, value: 10n ** 18n, data: encodeCall(CURVE.buy, [uintWord(10n ** 18n), uintWord(q.minAmountOut), addressWord(WALLET)]) });
    expect(approvalFor(q)).toBeNull();
    expect(() => verifyTrade(tx, q)).not.toThrow();
  });

  it('carries the snipe tax of the moment into the quote', async () => {
    const { rpc } = fakeChain({ snipe: 5_000n });
    const q = await quote(rpc, { side: 'buy', curve: CURVE_A, amountIn: 10n ** 18n, slippageBps: 100, wallet: WALLET });
    expect(q.snipeTax).toBe(5n * 10n ** 17n);
    expect(q.amountOut).toBe(buyMaths(q.state, 10n ** 18n, 5_000n).tokensOut);
  });

  it('builds a token-paid buy with no value and an approval for exactly the amount', async () => {
    const { rpc } = fakeChain();
    const q = await quote(rpc, { side: 'buy', token: TOKEN_B, amountIn: 25_000_000n, slippageBps: 300, wallet: WALLET });
    expect(buildTrade(q).value).toBe(0n);
    const approval = approvalFor(q)!;
    expect(approval).toMatchObject({ to: USDG, value: 0n, data: encodeCall(ERC20.approve, [addressWord(CURVE_B), uintWord(25_000_000n)]) });
    expect(() => verifyApproval(approval, q)).not.toThrow();
    const unlimited = { ...approval, data: encodeCall(ERC20.approve, [addressWord(CURVE_B), uintWord((1n << 256n) - 1n)]) };
    expect(() => verifyApproval(unlimited, q)).toThrow(/approved amount/);
    expect(() => verifyApproval({ ...approval, data: encodeCall(ERC20.approve, [addressWord(WALLET), uintWord(25_000_000n)]) }, q)).toThrow(/spender/);
    expect(() => verifyApproval({ ...approval, to: TOKEN_B }, q)).toThrow(/asset/);
  });

  it('quotes a sell, which approves the token sold', async () => {
    const { rpc } = fakeChain();
    const q = await quote(rpc, { side: 'sell', token: TOKEN_A, amountIn: 10n ** 21n, slippageBps: 300, wallet: WALLET });
    expect(q.amountOut).toBe(sellMaths(q.state, 10n ** 21n).quoteOut);
    const tx = buildTrade(q);
    expect(tx.value).toBe(0n);
    expect(tx.data.startsWith(CURVE.sell)).toBe(true);
    expect(approvalFor(q)).toMatchObject({ to: TOKEN_A });
    expect(() => verifyTrade(tx, q)).not.toThrow();
  });

  it('refuses a transaction that is not the quoted trade, and says why', async () => {
    const { rpc } = fakeChain();
    const q = await quote(rpc, { side: 'buy', token: TOKEN_A, amountIn: 10n ** 18n, slippageBps: 300, wallet: WALLET });
    const tx = buildTrade(q);
    const why = (changed: Partial<typeof tx>): string => {
      try {
        verifyTrade({ ...tx, ...changed }, q);
        return 'accepted';
      } catch (error) {
        return error instanceof TradeMismatch ? error.reason : 'other';
      }
    };
    const call = (amount: bigint, floor: bigint, recipient: string, selector: string = CURVE.buy): string => encodeCall(selector, [uintWord(amount), uintWord(floor), addressWord(recipient)]);
    expect(why({ to: CURVE_B })).toContain('curve');
    expect(why({ data: call(2n * 10n ** 18n, q.minAmountOut, WALLET) })).toContain('amount');
    expect(why({ data: call(10n ** 18n, q.minAmountOut - 1n, WALLET) })).toContain('floor');
    expect(why({ data: call(10n ** 18n, 0n, WALLET) })).toContain('floor');
    expect(why({ data: call(10n ** 18n, q.minAmountOut, CURVE_B) })).toContain('recipient');
    expect(why({ data: call(10n ** 18n, q.minAmountOut, WALLET, CURVE.sell) })).toContain('does not call buy');
    expect(why({ data: `${tx.data}${'0'.repeat(64)}` })).toContain('arguments');
    expect(why({ data: '0x1234' })).toContain('cannot be read');
    expect(why({ value: 0n })).toContain('value');
    expect(why({ value: 2n * 10n ** 18n })).toContain('value');
    expect(why({ chainId: 1 })).toContain('chain');
    // A higher floor only protects the wallet more.
    expect(why({ data: call(10n ** 18n, q.minAmountOut + 1n, WALLET) })).toBe('accepted');
  });

  it('refuses a token the factory did not launch, a graduated curve, and a curve that is not the token\'s', async () => {
    await expect(quote(fakeChain().rpc, { side: 'buy', token: WALLET, amountIn: 1n, slippageBps: 100, wallet: WALLET })).rejects.toBeInstanceOf(NotAPonsToken);
    await expect(quote(fakeChain({ graduated: true }).rpc, { side: 'buy', token: TOKEN_A, amountIn: 10n ** 18n, slippageBps: 100, wallet: WALLET })).rejects.toMatchObject({ code: 'GRADUATED' });
    await expect(quote(fakeChain().rpc, { side: 'buy', token: TOKEN_B, curve: CURVE_A, amountIn: 10n ** 18n, slippageBps: 100, wallet: WALLET })).rejects.toMatchObject({ code: 'BAD_STATE' });
    await expect(quote(fakeChain().rpc, { side: 'buy', token: TOKEN_A, amountIn: 10n ** 18n, slippageBps: 100, wallet: 'nope' })).rejects.toMatchObject({ code: 'BAD_AMOUNT' });
  });
});
