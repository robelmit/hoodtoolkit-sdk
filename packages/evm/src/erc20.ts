/** What an ERC-20 says about itself. Anything it does not answer stays `null`; nothing is assumed. */

import { address, addressWord, decodeString, encodeCall, wordCount, uintAt } from './abi';
import { EvmRpcError, ethCall, type EvmRpc } from './rpc';

export const ERC20 = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  totalSupply: '0x18160ddd',
  balanceOf: '0x70a08231',
  allowance: '0xdd62ed3e',
  approve: '0x095ea7b3',
} as const;

export interface Erc20Facts {
  readonly address: string;
  readonly name: string | null;
  readonly symbol: string | null;
  /** Null when the token does not say. Never assumed to be 18. */
  readonly decimals: number | null;
  readonly totalSupply: bigint | null;
}

/** A view that reverts or answers nothing is "unknown"; a transport failure is still an error. */
async function view(rpc: EvmRpc, to: string, data: string): Promise<string | null> {
  try {
    const answer = await ethCall(rpc, to, data);
    return typeof answer === 'string' && answer.length > 2 ? answer : null;
  } catch (error) {
    if (error instanceof EvmRpcError) return null;
    throw error;
  }
}

export async function readErc20(rpc: EvmRpc, token: string): Promise<Erc20Facts> {
  const to = address(token);
  const [name, symbol, decimals, supply] = await Promise.all([view(rpc, to, ERC20.name), view(rpc, to, ERC20.symbol), view(rpc, to, ERC20.decimals), view(rpc, to, ERC20.totalSupply)]);
  const dec = decimals !== null && wordCount(decimals) >= 1 ? uintAt(decimals, 0) : null;
  return {
    address: to,
    name: name === null ? null : decodeString(name),
    symbol: symbol === null ? null : decodeString(symbol),
    decimals: dec !== null && dec <= 77n ? Number(dec) : null,
    totalSupply: supply !== null && wordCount(supply) >= 1 ? uintAt(supply, 0) : null,
  };
}

export async function balanceOf(rpc: EvmRpc, token: string, owner: string): Promise<bigint> {
  return uintAt(await ethCall(rpc, address(token), encodeCall(ERC20.balanceOf, [addressWord(owner)])), 0);
}

export async function allowance(rpc: EvmRpc, token: string, owner: string, spender: string): Promise<bigint> {
  return uintAt(await ethCall(rpc, address(token), encodeCall(ERC20.allowance, [addressWord(owner), addressWord(spender)])), 0);
}
