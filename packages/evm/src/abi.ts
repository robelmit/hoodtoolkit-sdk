/**
 * The little ABI work this toolkit needs, without a dependency: 32-byte words
 * in and out of hex. Everything is checked; a malformed value throws here
 * instead of becoming a wrong number further on.
 */

const HEX = /^0x[0-9a-fA-F]*$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** The zero address. Launchpads on this chain use it to mean the native coin. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const isAddress = (value: unknown): value is string => typeof value === 'string' && ADDRESS.test(value);

/** Addresses compare without regard to case (checksums are a display matter). */
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** An address as lower case, or an error when it is not one. */
export function address(value: string): string {
  if (!isAddress(value)) throw new Error(`not an address: ${String(value).slice(0, 60)}`);
  return value.toLowerCase();
}

const strip = (hex: string): string => {
  if (typeof hex !== 'string' || !HEX.test(hex)) throw new Error('not a hex string');
  return hex.slice(2);
};

/** The `index`th 32-byte word of hex data (after an optional `offset` in bytes), as 64 hex characters. */
export function wordAt(data: string, index: number, offset = 0): string {
  const body = strip(data);
  const start = offset * 2 + index * 64;
  const word = body.slice(start, start + 64);
  if (word.length !== 64) throw new Error(`data ends before word ${index}`);
  return word;
}

/** How many whole 32-byte words the data holds. */
export const wordCount = (data: string): number => Math.floor(strip(data).length / 64);

export const uintAt = (data: string, index: number, offset = 0): bigint => BigInt(`0x${wordAt(data, index, offset)}`);

/** The address in a word. The upper twelve bytes must be zero, or the word is not an address. */
export function addressAt(data: string, index: number, offset = 0): string {
  const word = wordAt(data, index, offset);
  if (!/^0{24}/.test(word)) throw new Error(`word ${index} is not an address`);
  return `0x${word.slice(24).toLowerCase()}`;
}

export const boolAt = (data: string, index: number, offset = 0): boolean => uintAt(data, index, offset) !== 0n;

/** The address an indexed event topic carries. */
export function topicAddress(topic: string): string {
  return addressAt(topic, 0);
}

const MAX_UINT256 = (1n << 256n) - 1n;

/** A uint256 as a 32-byte word. */
export function uintWord(value: bigint): string {
  if (typeof value !== 'bigint' || value < 0n || value > MAX_UINT256) throw new Error('not a uint256');
  return value.toString(16).padStart(64, '0');
}

export const addressWord = (value: string): string => address(value).slice(2).padStart(64, '0');

/** Calldata: a 4-byte selector followed by static words. */
export function encodeCall(selector: string, words: readonly string[] = []): string {
  if (!/^0x[0-9a-f]{8}$/.test(selector)) throw new Error('a selector is 4 bytes of lower-case hex');
  for (const word of words) if (!/^[0-9a-f]{64}$/.test(word)) throw new Error('a word is 32 bytes of lower-case hex');
  return selector + words.join('');
}

/** The selector and the static words of calldata; throws when the length is not a selector plus whole words. */
export function decodeCall(data: string): { selector: string; words: string[] } {
  const body = strip(data).toLowerCase();
  if (body.length < 8 || (body.length - 8) % 64 !== 0) throw new Error('calldata is not a selector plus whole words');
  const words: string[] = [];
  for (let i = 8; i < body.length; i += 64) words.push(body.slice(i, i + 64));
  return { selector: `0x${body.slice(0, 8)}`, words };
}

/**
 * A string a contract returned: the usual dynamic `string`, or the `bytes32` some older tokens return for a name or
 * symbol. Null when it is neither. Control characters are dropped, so the text is safe to print.
 */
export function decodeString(data: string): string | null {
  let body: string;
  try {
    body = strip(data);
  } catch {
    return null;
  }
  let bytes: Buffer | null = null;
  if (body.length === 64) {
    bytes = Buffer.from(body, 'hex');
    const end = bytes.indexOf(0);
    bytes = bytes.subarray(0, end < 0 ? bytes.length : end);
  } else if (body.length >= 128) {
    const offset = Number(BigInt(`0x${body.slice(0, 64)}`));
    if (!Number.isSafeInteger(offset) || offset * 2 + 64 > body.length) return null;
    const length = Number(BigInt(`0x${body.slice(offset * 2, offset * 2 + 64)}`));
    if (!Number.isSafeInteger(length) || length > 4096 || offset * 2 + 64 + length * 2 > body.length) return null;
    bytes = Buffer.from(body.slice(offset * 2 + 64, offset * 2 + 64 + length * 2), 'hex');
  }
  if (!bytes) return null;
  // eslint-disable-next-line no-control-regex
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text.length > 0 ? text : null;
}

/** A hex quantity (`0x1a`) as a number; throws past the safe integer range. */
export function quantity(hex: string): number {
  const value = BigInt(hex);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('quantity exceeds the safe integer range');
  return Number(value);
}

export const toQuantity = (value: number | bigint): string => `0x${BigInt(value).toString(16)}`;
