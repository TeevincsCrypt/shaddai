import { getAddress, parseUnits, type Address } from 'viem';
import { Chain } from '../src/core/chain.js';
import { FakeChain, type FakeScenario, type FakeToken } from '../src/fixtures/fake-chain.js';

export const u = (v: string) => parseUnits(v, 18);
export const BASE_TS = Date.UTC(2026, 5, 1) / 1000;
export const BASE_BLOCK = 1_000_000n;
export const HOLDER: Address = getAddress('0x00000000000000000000000000000000000a11ce');
export const OTHER: Address = getAddress('0x0000000000000000000000000000000000000b0b');
export const TOKEN: Address = getAddress('0x0000000000000000000000000000000000007001');
export const ZERO: Address = '0x0000000000000000000000000000000000000000';

/** Block time 1s for easy arithmetic: block = BASE_BLOCK + (ts - BASE_TS). */
export const blockOf = (ts: number) => BASE_BLOCK + BigInt(ts - BASE_TS);
export const day = (n: number) => BASE_TS + n * 86_400;

export function scenario(over: Partial<FakeScenario> & { token?: Partial<FakeToken> } = {}): FakeScenario {
  const token: FakeToken = {
    address: TOKEN,
    symbol: 'TESTB',
    decimals: 18,
    bep677: true,
    deployBlock: BASE_BLOCK,
    schedules: [],
    transfers: [{ block: BASE_BLOCK, from: ZERO, to: OTHER, value: u('1000') }],
    ...over.token,
  };
  const { token: _t, ...rest } = over;
  return {
    baseBlock: BASE_BLOCK,
    baseTimestamp: BASE_TS,
    blockTimeMs: 1000,
    head: () => blockOf(day(60)),
    tokens: [token],
    archive: true,
    ...rest,
  };
}

export function chainFor(s: FakeScenario, opts: ConstructorParameters<typeof Chain>[1] = {}) {
  const fake = new FakeChain(s);
  return { fake, chain: new Chain(fake, { logChunk: 10_000_000, maxLogChunk: 10_000_000, ...opts }) };
}
