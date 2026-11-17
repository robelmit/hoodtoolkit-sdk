/**
 * Live checks against Robinhood Chain. They run only with LIVE=1, read the chain and simulate, and never send.
 *
 *   LIVE=1 pnpm --filter @hoodtoolkit/pons test
 *   HOOD_RPC_URL=<your endpoint> picks the endpoint (default: the public one, which rate-limits)
 */

import { FILTERED_LOG_SPAN, ROBINHOOD_CHAIN_ID, ROBINHOOD_PUBLIC_RPC, blockNumber, chainId, createEvmRpc, getLogs, toQuantity, uintAt } from '@hoodtoolkit/evm';
import { describe, expect, it } from 'vitest';
import { PONS_FACTORY, PONS_TOPICS, buildTrade, decodeLaunch, decodeTrade, findLaunch, progressPct, quote, readCurve, verifyTrade } from '../src';

const live = process.env['LIVE'] === '1';
const rpc = createEvmRpc({ url: process.env['HOOD_RPC_URL'] ?? ROBINHOOD_PUBLIC_RPC });
const WALLET = '0x000000000000000000000000000000000000dEaD';

describe.runIf(live)('Pons on Robinhood Chain, live', () => {
  it('finds recent launches, reads a live curve, and quotes what the chain itself would give', async () => {
    expect(await chainId(rpc)).toBe(ROBINHOOD_CHAIN_ID);
    const head = await blockNumber(rpc);

    // Launches of the last few hours, from the factory.
    const launches = (await getLogs(rpc, { address: PONS_FACTORY, topics: [PONS_TOPICS.tokenLaunched] }, head - 200_000, head, FILTERED_LOG_SPAN)).map(decodeLaunch).filter((l) => l !== null);
    expect(launches.length).toBeGreaterThan(0);
    console.log(`launches in the last 200,000 blocks: ${launches.length}`);

    // The newest launch that still trades on its curve.
    let picked = null;
    for (const launch of launches.reverse()) {
      const state = await readCurve(rpc, launch.curve);
      if (!state.graduated && state.sellableTokens > 0n) {
        picked = { launch, state };
        break;
      }
    }
    expect(picked).not.toBeNull();
    const { launch, state } = picked!;
    expect(state.token).toBe(launch.token);
    expect(state.pairToken).toBe(launch.pairToken);
    expect(state.graduationThreshold).toBe(launch.graduationThreshold);
    console.log(`curve ${state.curve} of ${state.token}: quote asset ${state.pairSymbol} (${state.pairDecimals} decimals), fee ${state.feeBps} bps, creator tax ${state.creatorTaxBps} bps, progress ${progressPct(state.realQuoteReserve, state.graduationThreshold)} %`);

    // The factory's own record agrees.
    const record = await findLaunch(rpc, launch.token);
    expect(record).toMatchObject({ curve: launch.curve, pairToken: launch.pairToken, graduationThreshold: launch.graduationThreshold });
    expect(await findLaunch(rpc, WALLET)).toBeNull();

    // A small buy: a thousandth of the threshold.
    const amountIn = state.graduationThreshold / 1000n;
    const q = await quote(rpc, { side: 'buy', curve: launch.curve, amountIn, slippageBps: 300, wallet: WALLET });
    const tx = buildTrade(q);
    verifyTrade(tx, q);
    console.log(`buy ${amountIn} of the quote asset -> ${q.amountOut} token units (fee ${q.fee}, creator tax ${q.creatorTax}, snipe tax ${q.snipeTax})`);

    // Ask the node what the buy would return, at the block the quote was made from. A native-coin buy is simulated
    // with a balance override; a token-paid buy needs an allowance the wallet does not have, so only the maths is
    // checked for those (the recorded-trade tests cover it).
    if (q.native) {
      const simulated = await rpc.call<string>('eth_call', [{ from: WALLET, to: tx.to, data: tx.data, value: toQuantity(tx.value) }, 'latest', { [WALLET]: { balance: toQuantity(tx.value * 2n + 10n ** 18n) } }]);
      const tokensOut = uintAt(simulated, 0);
      // The curve can have traded between the two reads; when it has not, the answer is exact.
      const drift = tokensOut > q.amountOut ? tokensOut - q.amountOut : q.amountOut - tokensOut;
      console.log(`simulated ${tokensOut}, quoted ${q.amountOut}, difference ${drift}`);
      expect(tokensOut).toBeGreaterThanOrEqual(q.minAmountOut);
    }
  }, 180_000);

  it('decodes the trades of the last minutes', async () => {
    const head = await blockNumber(rpc);
    const logs = await getLogs(rpc, { topics: [[PONS_TOPICS.curveBuy, PONS_TOPICS.curveSell]] }, head - 3_000, head, 500);
    const trades = logs.map(decodeTrade).filter((t) => t !== null);
    console.log(`trades in the last 3,000 blocks: ${trades.length} on ${new Set(logs.map((l) => l.address)).size} curves`);
    expect(trades.length).toBe(logs.length);
    for (const trade of trades) expect(trade.quoteAmount > 0n && trade.tokenAmount > 0n).toBe(true);
  }, 180_000);
});
