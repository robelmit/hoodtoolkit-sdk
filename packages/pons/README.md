# @hood-toolkit/pons

Pons V2 on Robinhood Chain, for builders: decode its events, read a token's curve, quote a buy or a sell to the unit, build the unsigned transaction, and verify the bytes before a wallet signs.

Pons publishes no API. Everything here is read from the chain.

```ts
import { createEvmRpc, ROBINHOOD_PUBLIC_RPC } from '@hood-toolkit/evm';
import { approvalFor, buildTrade, quote, verifyTrade } from '@hood-toolkit/pons';

const rpc = createEvmRpc({ url: ROBINHOOD_PUBLIC_RPC });

// 1. Quote: 0.01 ETH of a token, 3 % slippage.
const q = await quote(rpc, { side: 'buy', token: '0x…', amountIn: 10n ** 16n, slippageBps: 300, wallet: '0x…' });
console.log(q.amountOut, q.minAmountOut, q.fee, q.creatorTax, q.snipeTax);

// 2. Build the unsigned transaction (and the approval it needs first, if any).
const approval = approvalFor(q); // null for a buy paid in ETH
const tx = buildTrade(q); // { chainId, from, to, data, value }

// 3. On the signing side, check the bytes are that trade and nothing else.
verifyTrade(tx, q); // throws TradeMismatch with the reason

// Your wallet signs and sends. Nothing here does.
```

## Install

```
npm i @hood-toolkit/pons @hood-toolkit/evm
```

Node 20 or later. No other dependencies.

## What Pons makes you read

Three things differ per launch. Assuming any of them gives wrong numbers that look plausible.

| Per launch | Why it matters |
|---|---|
| **Graduation threshold** | It is set per launch and carried in the `TokenLaunched` event |
| **Quote asset** | Often ETH (the zero address), but also a dollar coin or a tokenized stock |
| **Quote decimals** | A dollar coin has 6, not 18. `readCurve` reads them from the token; unknown stays `null` |

Also: the curve's fee and the creator's tax are per curve, and buys in the first seconds after a launch carry a snipe tax that decays to zero.

## Reading

| Function | Gives |
|---|---|
| `findLaunch(rpc, token)` | The factory's record: curve, deployer, quote asset, threshold. `null` when the factory did not launch the token |
| `readCurve(rpc, curve, block?)` | Reserves, sellable tokens, fee, creator tax, threshold, quote asset with its decimals and symbol, graduated or not, all from one block |
| `readSnipeTaxBps(rpc, curve, wallet)` | The snipe tax a buy for that wallet would carry now |
| `progressPct(realQuoteReserve, threshold)` | Progress toward graduation, 0 to 100 |
| `spotPrice(state, quoteDecimals, tokenDecimals)` | The curve's price in quote per token |

Progress uses the quote actually paid in. The curve's pricing reserve includes a phantom amount, and using it would show every new token as part-way to graduation.

## Events

`decodeLaunch`, `decodeTrade`, `decodeGraduation`, `decodeSweep` take a raw log and return the event or `null`. The topics are in `PONS_TOPICS`.

Curves are deployed per token, so trades are found by topic with no address filter. On the public endpoint that works over short block ranges only; `@hood-toolkit/evm`'s `getLogs` handles the ranges. Launches and graduations come from the factory and can be read over long ranges.

`isSnipeTaxed(trade)` marks a buy whose tax is a tenth of the trade or more. Keep those in a trade list and out of a price series.

## Quoting

`quote` reads the curve and applies the contract's own arithmetic in integers:

- **Buy:** the fee, the creator tax and any snipe tax come off what is spent; the rest is priced on the curve. A buy larger than what the curve has left is cut down and the remainder comes back as `refund`.
- **Sell:** the tokens are priced on the curve; the fee and the creator tax come off what comes out.

`buyMaths` and `sellMaths` are the same arithmetic as pure functions, for when you hold the state yourself.

It refuses with a `PonsQuoteError` and a code: `GRADUATED`, `BAD_STATE`, `BAD_AMOUNT`, `ROUNDS_TO_ZERO`, `FEES_CONSUME_TRADE`. `NotAPonsToken` means the factory did not launch the token.

## Building and verifying

`buildTrade(quote)` returns `{ chainId, from, to, data, value }`. Gas and nonce are the signer's.

`approvalFor(quote)` returns the approval a trade needs first: a buy paid in a token, or any sell. The amount is exactly the trade's, never unlimited.

`verifyTrade(tx, quote)` refuses a transaction unless it calls the quote's curve, the right function, with the quoted amount, a floor no lower than the quote's, the wallet as recipient, and the right value. `verifyApproval` does the same for an approval and refuses an unlimited one or another spender.

## How it was checked

- **Against real trades.** For 24 recorded trades on live curves, the state one block earlier put through this arithmetic gives exactly the amounts each trade's own event reports. They are fixtures in `test/fixtures/trades.json`.
- **Against the node.** With `LIVE=1`, the test quotes a buy on the newest live curve and asks the node to simulate the built transaction. The simulated output matched the quote exactly when this was last run.
- 17 unit tests and 2 live tests.

```
pnpm --filter @hood-toolkit/pons test
LIVE=1 pnpm --filter @hood-toolkit/pons test    # reads the chain and simulates; never sends
```

## What it does not do

- It does not sign or send, and it holds no key.
- It covers the curve. Once a token graduates it trades in a Uniswap v4 pool, which this package does not quote.
- It does not launch tokens.
- Pons V1 (no curve) is not covered.
- Pons can change its contracts. The addresses and selectors here are the ones live when this was written; the live test is the check.

## Licence

MIT
