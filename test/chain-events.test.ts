import { encodeAbiParameters, getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { TOPICS } from '../src/core/abi.js';
import { rawAtBlocks } from '../src/core/balances.js';
import { MemoryKV } from '../src/core/cache.js';
import { buildTimeline, decodeMultiplierLog, FeedIndexer, MULTIPLIER_TOPICS } from '../src/core/events.js';
import { probeTokens } from '../src/core/probe.js';
import type { TokenInfo } from '../src/core/registry.js';
import { blockOf, chainFor, day, HOLDER, OTHER, scenario, TOKEN, u } from './helpers.js';

const info: TokenInfo = {
  symbol: 'TESTB',
  ticker: 'TEST',
  name: 'Test',
  issuer: 'bStocks',
  address: TOKEN,
  model: 'bep677',
};

describe('multiplier log decoding', () => {
  const base = {
    address: TOKEN,
    blockNumber: 5n,
    transactionHash: `0x${'ab'.repeat(32)}` as const,
    logIndex: 3,
  };
  it('decodes the 3-word BEP-677 reference layout', () => {
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [u('1'), u('1.000604'), 1_786_000_000n],
    );
    const d = decodeMultiplierLog({ ...base, topics: [TOPICS.multiplierUpdated3], data });
    expect(d).toMatchObject({
      type: 'updated',
      layout: 'bep677-3',
      oldMultiplier: u('1'),
      newMultiplier: u('1.000604'),
    });
  });
  it('decodes the 4-word variant from the brief', () => {
    const data = encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [u('1'), u('2'), 1_785_000_000n, 1_786_000_000n],
    );
    const d = decodeMultiplierLog({ ...base, topics: [TOPICS.multiplierUpdated4], data });
    expect(d).toMatchObject({ layout: 'variant-4', newMultiplier: u('2'), effectiveAt: 1_786_000_000n });
  });
  it('ignores unrelated topics', () => {
    expect(decodeMultiplierLog({ ...base, topics: [TOPICS.transfer], data: '0x' })).toBeNull();
  });
});

describe('Chain.getLogs', () => {
  it('splits ranges the node rejects and still returns every log in order', async () => {
    const transfers = Array.from({ length: 40 }, (_, i) => ({
      block: blockOf(day(1) + i * 50_000),
      from: OTHER,
      to: HOLDER,
      value: u('1'),
    }));
    const s = scenario({ maxLogRange: 100_000n, token: { transfers } });
    const { chain } = chainFor(s, { logChunk: 1_000_000, maxLogChunk: 1_000_000, minLogChunk: 1000 });
    const logs = await chain.getLogs({
      address: TOKEN,
      topics: [TOPICS.transfer],
      fromBlock: blockOf(day(0)),
      toBlock: blockOf(day(40)),
    });
    expect(logs).toHaveLength(40);
    expect(chain.stats.logSplits).toBeGreaterThan(0);
    for (let i = 1; i < logs.length; i++) expect(logs[i]!.blockNumber > logs[i - 1]!.blockNumber).toBe(true);
  });

  it('finds the first block at or after a timestamp', async () => {
    const { chain } = chainFor(scenario());
    const head = blockOf(day(60));
    expect(await chain.blockAtOrAfter(day(10) + 7, 1_000_000n, head)).toBe(blockOf(day(10) + 7));
    expect(await chain.blockAtOrAfter(day(99), 1_000_000n, head)).toBe(head + 1n);
  });
});

describe('timeline semantics (mirrors ERC8056BaseUpgradeable)', () => {
  const schedules = [
    { block: blockOf(day(5)), newMultiplier: u('1.001'), effectiveAt: day(6) },
    // scheduled then overwritten before activation
    { block: blockOf(day(20)), newMultiplier: u('1.0025'), effectiveAt: day(25) },
    { block: blockOf(day(21)), newMultiplier: u('1.002'), effectiveAt: day(25) },
    // pending at head (day 60)
    { block: blockOf(day(59)), newMultiplier: u('2.004'), effectiveAt: day(62) },
  ];

  it('marks effective, overwritten and pending schedules', async () => {
    const s = scenario({ token: { schedules } });
    const { chain } = chainFor(s);
    const head = { number: blockOf(day(60)), timestamp: day(60) };
    const feed = new FeedIndexer(chain, [info], new MemoryKV(), async () => blockOf(day(0)));
    await feed.refresh(head);
    const tl = feed.timeline(head.timestamp);
    const rows = tl.filter((e) => e.kind !== 'init').sort((a, b) => a.scheduledAt - b.scheduledAt);
    expect(rows.map((r) => [r.newMultiplier, r.status, r.kind])).toEqual([
      ['1.001', 'effective', 'dividend-reinvest'],
      ['1.0025', 'overwritten', 'dividend-reinvest'],
      ['1.002', 'effective', 'dividend-reinvest'],
      ['2.004', 'pending', 'split'],
    ]);
    // old multiplier of the overwriting event is the value before the overwritten one.
    expect(rows[2]!.oldMultiplier).toBe('1.001');
    expect(rows[3]!.oldMultiplier).toBe('1.002');
    expect(rows[0]!.effectiveBlock).toBe(blockOf(day(6)).toString());
    expect(rows[3]!.effectiveBlock).toBeNull();
  });

  it('agrees with the contract view functions at head', async () => {
    const s = scenario({ token: { schedules } });
    const { chain } = chainFor(s);
    const probes = await probeTokens(chain, [info], HOLDER, blockOf(day(60)), day(60));
    const p = probes.get(TOKEN)!;
    expect(p.unit.multiplier).toBe('1.002');
    expect(p.unit.pending).toMatchObject({
      multiplier: '2.004',
      effectiveAt: day(62),
      kind: 'split',
      splitLabel: '2-for-1',
    });
    expect(p.unit.kind).toBe('bep677');
  });

  it('resumes incrementally from the persisted index', async () => {
    const s = scenario({ token: { schedules } });
    const { chain } = chainFor(s);
    const kv = new MemoryKV();
    const f1 = new FeedIndexer(chain, [info], kv, async () => blockOf(day(0)));
    await f1.refresh({ number: blockOf(day(30)), timestamp: day(30) });
    const { chain: chain2, fake } = chainFor(s);
    const f2 = new FeedIndexer(chain2, [info], kv, async () => blockOf(day(0)));
    await f2.refresh({ number: blockOf(day(60)), timestamp: day(60) });
    expect(f2.timeline(day(60)).filter((e) => e.kind !== 'init')).toHaveLength(4);
    // Only the new range was requested.
    expect(fake.calls.eth_getLogs).toBe(1);
  });

  it('buildTimeline ignores tokens outside the registry', () => {
    const tl = buildTimeline(
      [
        {
          token: getAddress('0x0000000000000000000000000000000000009999'),
          type: 'updated',
          layout: 'bep677-3',
          oldMultiplier: u('1'),
          newMultiplier: u('2'),
          effectiveAt: 10n,
          blockNumber: 1n,
          logIndex: 0,
          txHash: `0x${'00'.repeat(32)}`,
          scheduledAt: 1,
        },
      ],
      new Map([[TOKEN, info]]),
      100,
      new Map(),
    );
    expect(tl).toHaveLength(0);
    expect(MULTIPLIER_TOPICS).toHaveLength(4);
  });
});

describe('raw balance at a past block', () => {
  const transfers = [
    {
      block: blockOf(day(0)),
      from: '0x0000000000000000000000000000000000000000' as const,
      to: OTHER,
      value: u('1000'),
    },
    { block: blockOf(day(2)), from: OTHER, to: HOLDER, value: u('10') },
    { block: blockOf(day(12)), from: OTHER, to: HOLDER, value: u('5') },
    { block: blockOf(day(15)), from: HOLDER, to: OTHER, value: u('3') },
    { block: blockOf(day(15)), from: HOLDER, to: HOLDER, value: u('1') },
  ];
  const targets = [blockOf(day(1)), blockOf(day(10)), blockOf(day(13)), blockOf(day(20))];
  const expected = [u('0'), u('10'), u('15'), u('12')];

  it('reads it from archive state when available', async () => {
    const { chain } = chainFor(scenario({ token: { transfers } }));
    const r = await rawAtBlocks(chain, TOKEN, HOLDER, targets, blockOf(day(60)), u('12'));
    expect(targets.map((t) => r.get(t)!.raw)).toEqual(expected);
    expect(r.get(targets[0]!)!.source).toBe('archive');
  });

  it('replays Transfer logs when the node is pruned, with the same answer', async () => {
    const { chain } = chainFor(scenario({ archive: false, maxLogRange: 2_000_000n, token: { transfers } }));
    const r = await rawAtBlocks(chain, TOKEN, HOLDER, targets, blockOf(day(60)), u('12'));
    expect(targets.map((t) => r.get(t)!.raw)).toEqual(expected);
    expect(r.get(targets[0]!)!.source).toBe('replay');
  });

  it('falls back to the current balance when replay would be too large', async () => {
    const { chain } = chainFor(scenario({ archive: false, token: { transfers } }));
    const r = await rawAtBlocks(chain, TOKEN, HOLDER, targets, blockOf(day(60)), u('12'), { maxLogs: 1 });
    expect(r.get(targets[1]!)).toMatchObject({ raw: u('12'), source: 'assumed-current' });
  });
});

describe('share factor not read', () => {
  it('never fakes 1:1 for Ondo without an oracle answer or for xStocks without a factor', async () => {
    const plain = (address: `0x${string}`, symbol: string) => ({
      address,
      symbol,
      decimals: 18,
      bep677: false,
      deployBlock: blockOf(day(0)),
      schedules: [],
      transfers: [{ block: blockOf(day(1)), from: OTHER, to: HOLDER, value: u('5') }],
    });
    const ONDO_T = getAddress('0x0000000000000000000000000000000000007002');
    const XS_T = getAddress('0x0000000000000000000000000000000000007003');
    const s = scenario();
    s.tokens.push(plain(ONDO_T, 'TESTon'), plain(XS_T, 'TESTx'));
    const { chain } = chainFor(s);
    const infos: TokenInfo[] = [
      { ...info, address: ONDO_T, symbol: 'TESTon', issuer: 'Ondo', model: 'ondo' },
      { ...info, address: XS_T, symbol: 'TESTx', issuer: 'xStocks', model: 'xstocks' },
    ];
    const probes = await probeTokens(chain, infos, HOLDER, blockOf(day(60)), day(60), { ondoOracle: null });
    const o = probes.get(ONDO_T)!;
    const x = probes.get(XS_T)!;
    expect(o).toMatchObject({ raw: u('5'), shareEq: null, shareEqSource: 'unread' });
    expect(o.unit.unreadReason).toMatch(/Ondo total-return factor not read .*Do not treat 1 token as 1 share/);
    expect(x).toMatchObject({ shareEq: null, shareEqSource: 'unread' });
    expect(x.unit.unreadReason).toBe('Display factor not on this token. Shaddai does not invent one.');
  });
});
