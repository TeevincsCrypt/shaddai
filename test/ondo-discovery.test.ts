import { getAddress, keccak256, pad, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { discoverOndoOracle } from '../src/core/ondo-discovery.js';
import type { TokenInfo } from '../src/core/registry.js';
import type { FakeToken } from '../src/fixtures/fake-chain.js';
import { BASE_BLOCK, blockOf, chainFor, day, OTHER, scenario, u, ZERO } from './helpers.js';

const ORACLE: Address = getAddress('0x00000000000000000000000000000000000005a0');
const DECOY: Address = getAddress('0x0000000000000000000000000000000000000dec');
const UPDATED: Hex = keccak256(toHex('SValueUpdated(address,uint128)'));
const topicOf = (a: Address) => pad(a.toLowerCase() as Hex, { size: 32 });

const ondo = [1, 2, 3].map((i) => getAddress(`0x00000000000000000000000000000000000${i}0000`));
const infos: TokenInfo[] = ondo.map((address, i) => ({
  symbol: `T${i}on`,
  ticker: `T${i}`,
  name: `Token ${i}`,
  issuer: 'Ondo',
  address,
  model: 'ondo',
}));
const tokens: FakeToken[] = ondo.map((address, i) => ({
  address,
  symbol: `T${i}on`,
  decimals: 18,
  bep677: false,
  deployBlock: BASE_BLOCK,
  schedules: [],
  transfers: [{ block: BASE_BLOCK, from: ZERO, to: OTHER, value: u('1') }],
}));

const oracle = {
  address: ORACLE,
  values: new Map(ondo.map((a) => [a, { sValue: u('1.0021'), paused: false }])),
};
const update = (from: Address, token: Address, block: bigint) => ({
  address: from,
  topics: [UPDATED, topicOf(token)],
  data: '0x' as Hex,
  block,
});
const HEAD = blockOf(day(60));

describe('Ondo oracle discovery', () => {
  it('finds the oracle from logs that index Ondo tokens and ignores a decoy', async () => {
    const { chain } = chainFor(
      scenario({
        tokens,
        ondoOracle: oracle,
        extraLogs: [
          update(ORACLE, ondo[0]!, blockOf(day(55))),
          update(ORACLE, ondo[1]!, blockOf(day(58))),
          update(DECOY, ondo[0]!, blockOf(day(57))),
          update(DECOY, ondo[2]!, blockOf(day(59))),
        ],
        maxLogRange: 100_000n,
      }),
      { logChunk: 100_000 },
    );
    const d = await discoverOndoOracle(chain, infos, HEAD, { lookbackBlocks: 10n * 86_400n, window: 200_000n });
    expect(d.found).toBe(ORACLE);
    expect(d.answered).toBe(3);
    const decoy = d.candidates.find((c) => c.address === DECOY)!;
    expect(decoy).toMatchObject({ tokensSeen: 2, answered: 0 });
    expect(d.candidates.find((c) => c.address === ORACLE)!.eventTopics).toEqual([UPDATED]);
  });

  it('accepts a hint only after it answers getSValue', async () => {
    const { chain } = chainFor(scenario({ tokens, ondoOracle: oracle }));
    const d = await discoverOndoOracle(chain, infos, HEAD, { hints: [DECOY, ORACLE], lookbackBlocks: 10n });
    expect(d.found).toBe(ORACLE);
    expect(d.candidates.find((c) => c.address === DECOY)).toMatchObject({ source: 'hint', answered: 0 });
  });

  it('reports why when nothing qualifies', async () => {
    const { chain } = chainFor(
      scenario({
        tokens,
        extraLogs: [update(DECOY, ondo[0]!, blockOf(day(59))), update(DECOY, ondo[1]!, blockOf(day(59)))],
      }),
    );
    const d = await discoverOndoOracle(chain, infos, HEAD, { lookbackBlocks: 5n * 86_400n });
    expect(d.found).toBeNull();
    expect(d.notes.join(' ')).toMatch(/No candidate answered getSValue/);
  });
});
