# @hood-toolkit/evm

The small EVM client the hoodtoolkit packages share. It reads a JSON-RPC endpoint and nothing else: no signing, no sending, no dependencies.

```ts
import { ROBINHOOD_PUBLIC_RPC, blockNumber, createEvmRpc, getLogs, readErc20 } from '@hood-toolkit/evm';

const rpc = createEvmRpc({ url: ROBINHOOD_PUBLIC_RPC });
const head = await blockNumber(rpc);
const usdg = await readErc20(rpc, '0x5fc5360d0400a0fd4f2af552add042d716f1d168');
// { symbol: 'USDG', decimals: 6, ... }
```

## Install

```
npm i @hood-toolkit/evm
```

Node 20 or later.

## What is in it

| Part | What it does |
|---|---|
| `createEvmRpc` | A paced client (8 calls a second by default) that retries what was throttled or failed in transit, with a time limit per attempt. A node error such as a revert is reported at once as `EvmRpcError`; an endpoint that stays down is `EvmRpcUnavailable` |
| `getLogs` | Reads event logs over a block range in spans. A span the endpoint refuses is halved and read again, never skipped |
| `readErc20`, `balanceOf`, `allowance` | What a token says about itself. What it does not answer is `null`; decimals are never assumed |
| `encodeCall`, `decodeCall`, `uintAt`, `addressAt`, `decodeString` | 32-byte words in and out of hex, checked |

## Robinhood Chain and logs

The chain makes about ten blocks a second. Its public endpoint limits `eth_getLogs` by the size of the answer:

- A query with no address works over about ten blocks (`UNFILTERED_LOG_SPAN`).
- A query that names its contract works over very long ranges (`FILTERED_LOG_SPAN`).

So pick the span per query. For anything that must keep up with the chain, use an endpoint of your own.

## Rules it keeps

- **Unknown is never zero.** A token that does not report its decimals has `decimals: null`.
- **A gap is an error.** A refused log range is split until it is served, or the error reaches you.
- **An endpoint that is down is not "unknown".** `readErc20` returns `null` for a view that reverts, and throws when the endpoint itself fails.
- **Text from a contract is cleaned.** `decodeString` drops control characters.

## Tests

```
pnpm --filter @hood-toolkit/evm test
```

15 tests, with no network.

## Licence

MIT
