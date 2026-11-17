# hoodtoolkit-sdk

Trade-building tools for Pons, the launchpad on Robinhood Chain, from the team behind the Hexa trading terminal. Quote a buy or a sell to the unit, build the unsigned transaction, and verify the bytes before a wallet signs.

| Package | What it does |
|---|---|
| [`@hoodtoolkit/pons`](packages/pons) | Decode Pons events, read a token's curve with everything that differs per launch, quote in the contract's own arithmetic, build the unsigned trade and its exact-amount approval, and verify them |
| [`@hoodtoolkit/evm`](packages/evm) | The small EVM client the hoodtoolkit packages share: paced, retrying, with log ranges that are split when refused and never skipped. No dependencies |

## How it was checked

- The quote arithmetic reproduces 24 recorded live trades to the unit (`packages/pons/test/fixtures/trades.json`).
- A live test (`LIVE=1`) quotes a buy on the newest open curve and has the chain's node simulate the built transaction; when last run, the simulated output equalled the quote exactly.

```bash
LIVE=1 pnpm --filter @hoodtoolkit/pons test   # reads the chain and simulates; never sends
```

## Principles

- **Nothing here signs, sends or holds a key.**
- **Unknown is never zero.** A value that could not be read stays `null`.
- **Read, never assume.** Pons sets the graduation threshold and the paired asset per launch, and pairs tokens with ETH, a 6-decimal dollar coin, or tokenized stocks.
- **No API key needed.** Everything runs against a Robinhood Chain RPC endpoint you choose.

## Develop

Node 22.13 or newer and pnpm to work on the repository; the published packages run on Node 20 or newer.

```bash
pnpm install
pnpm check        # build, typecheck, test, lint
```

## The hoodtoolkit family

| Repository | What it holds |
|---|---|
| **hoodtoolkit-sdk** (this one) | The Pons SDK and the shared EVM client |
| [hoodtoolkit-feed](https://github.com/robelmit/hoodtoolkit-feed) | The launch feed: launches, curve trades and graduations as a stream of events |
| [hoodtoolkit-bots](https://github.com/robelmit/hoodtoolkit-bots) | Telegram and Discord community bots |
| [hoodtoolkit-agents](https://github.com/robelmit/hoodtoolkit-agents) | A read-only MCP server for AI agents, and an HTTP API |

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [SECURITY.md](SECURITY.md) to report a vulnerability.

## Licence

[MIT](LICENSE)
