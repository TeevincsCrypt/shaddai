import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { readBooks, v2Depth } from '../src/core/books.js';
import type { Chain } from '../src/core/chain.js';
import type { PriceSource } from '../src/core/prices.js';
import { usCashSession } from '../src/core/market-hours.js';
import { marketBadge, SPREAD_COPY, spreadFor } from '../src/core/spread.js';
import { demoContext } from '../src/server/context.js';

const NOW = Date.UTC(2026, 8, 29, 16) / 1000; // Tue 29 Sep 2026, 12:00 New York
const at = (iso: string) => Date.parse(iso);

describe('US cash session clock', () => {
  it('knows weekday hours, weekends, and the next open across a DST change', () => {
    expect(usCashSession(at('2026-09-29T16:00:00Z'))).toMatchObject({ open: true, reason: 'open' });
    expect(usCashSession(at('2026-09-29T20:30:00Z'))).toMatchObject({ open: false, reason: 'after-close' });
    expect(usCashSession(at('2026-09-29T13:00:00Z'))).toMatchObject({ open: false, reason: 'before-open' });
    // Friday 30 Oct 2026 17:00 EDT → Monday 2 Nov 09:30 EST (DST ended 1 Nov) = 14:30 UTC.
    const fri = usCashSession(at('2026-10-30T21:00:00Z'));
    expect(fri).toMatchObject({ open: false, reason: 'after-close' });
    expect(new Date(fri.nextOpenMs).toISOString()).toBe('2026-11-02T14:30:00.000Z');
    const sat = usCashSession(at('2026-10-10T15:00:00Z'));
    expect(sat.reason).toBe('weekend');
    expect(new Date(sat.nextOpenMs).toISOString()).toBe('2026-10-12T13:30:00.000Z');
  });

  it('badges a closed market as a quote, not a mispricing', () => {
    const open = usCashSession(at('2026-09-29T16:00:00Z'));
    const regular = {
      openState: true,
      marketStatus: 'regular',
      reasonCode: 'TRADING',
      reasonMsg: null,
      nextOpenTime: null,
    };
    expect(marketBadge(regular, open)).toMatchObject({ closed: false, badge: null });
    expect(marketBadge(null, usCashSession(at('2026-10-10T15:00:00Z'))).badge).toBe('Weekend quote, not a mispricing');
    const pre = { ...regular, marketStatus: 'premarket', nextOpenTime: 1_790_861_460_000 };
    expect(marketBadge(pre, open)).toMatchObject({
      closed: true,
      badge: 'Off-hours quote, not a mispricing',
      nextOpenMs: 1_790_861_460_000,
      nextOpenSource: 'binance-rwa',
    });
    const halted = { ...regular, openState: false, reasonCode: 'ASSET_PAUSED', reasonMsg: 'stock_split' };
    expect(marketBadge(halted, open)).toMatchObject({
      badge: 'Trading paused, not a mispricing',
      detail: 'stock_split',
    });
  });
});

describe('1% depth', () => {
  it('V2: the USDT a buy can spend before its average price is 1% worse than a tiny one', () => {
    // impact = 1 − R / (R + Δ·0.9975) = 1%  ⇒  Δ = R·(1/0.99 − 1)/0.9975
    expect(v2Depth(7000)).toBeCloseTo((7000 * (1 / 0.99 - 1)) / 0.9975, 9);
    // Cross-check with getAmountOut: at Δ = depth, the average rate is exactly 1% below a tiny buy's.
    const out = (dx: number) => (dx * 0.9975 * 30) / (7000 + dx * 0.9975);
    const d = v2Depth(7000);
    expect(1 - out(d) / d / (out(1e-6) / 1e-6)).toBeCloseTo(0.01, 9);
    expect(d).toBeCloseTo(70.88, 2);
  });
});

describe('share-normalized spread (demo)', () => {
  it('compares NVDA wrappers per share-equivalent, after the multiplier', async () => {
    const s = await spreadFor(demoContext(NOW), 'NVDA', { nowMs: NOW * 1000 });
    expect(s.copy).toBe(SPREAD_COPY.lead);
    expect(s.rows.map((r) => r.token.symbol)).toEqual(['NVDAB', 'NVDAon']); // sorted by share-eq price
    const [b, on] = s.rows;
    // Pool prices come from reserves on chain, then ÷ factor.
    expect(b!.book.source).toBe('onchain');
    expect(b!.book.rawPrice!).toBeCloseTo(230.79168, 6);
    expect(b!.shareEqPrice!).toBeCloseTo(230.79168 / 1.0017, 6);
    // Raw gap is the dividend factor; after the multiplier it is gone.
    expect(b!.rawGapPct!).toBeCloseTo(0.17, 6);
    expect(b!.gapPct!).toBeCloseTo(0, 6);
    expect(on!.factorSource).toBe('sValue');
    expect(on!.gapPct!).toBeCloseTo(0.3, 6);
    // Thin twin: under the $25k floor, so not liquid; depth from reserves.
    expect(on!.liquid).toBe(false);
    expect(on!.book.liquidityUsd).toBe(14_000);
    expect(on!.book.depth1pctUsd!).toBeCloseTo(v2Depth(7000), 0);
    expect(s.tightest).toBe(b!.token.address);
    expect(s.missing).toEqual(['xStocks: no verified BSC contract for NVDA in the registry, so none is shown.']);
    expect(s.session.open).toBe(true);
    expect(b!.market.badge).toBeNull();
  });

  it('never prices a wrapper whose factor is unread', async () => {
    const ctx = demoContext(NOW);
    ctx.ondoOracle = null;
    const s = await spreadFor(ctx, 'NVDA', { nowMs: NOW * 1000 });
    const on = s.rows.find((r) => r.token.symbol === 'NVDAon')!;
    expect(on).toMatchObject({ factor: null, shareEqPrice: null, gapPct: null });
    expect(on.notes).toContain(SPREAD_COPY.unread);
    expect(s.rows.at(-1)!.token.symbol).toBe('NVDAon');
  });

  it('badges every row on a weekend and falls back to DexScreener without a readable pool', async () => {
    const sat = at('2026-10-10T15:00:00Z');
    const s = await spreadFor(demoContext(sat / 1000), 'MSFT', { nowMs: sat });
    const m = s.rows[0]!;
    expect(m.market.badge).toBe('Weekend quote, not a mispricing');
    expect(m.book.source).toBe('dexscreener');
    expect(m.book.depth1pctUsd).toBeNull();
    expect(s.missing).toContain('Ondo: no verified BSC contract for MSFT in the registry, so none is shown.');
  });

  it('has no reference, and no gap, without a Binance key', async () => {
    const ctx = demoContext(NOW);
    ctx.buy = undefined;
    const s = await spreadFor(ctx, 'NVDA', { nowMs: NOW * 1000 });
    expect(s.rows.every((r) => r.gapPct === null && r.reference === null)).toBe(true);
    expect(s.rows[0]!.shareEqPrice).not.toBeNull();
    expect(s.referenceNote).toBe(SPREAD_COPY.noReference);
    expect(s.tightest).toBeNull();
  });
});

describe('V3 pool book (stubbed chain)', () => {
  it('prices from slot0 and finds 1% depth with the quoter ladder', async () => {
    const TOKEN = getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436');
    const USDT = getAddress('0x55d398326f99059fF775485246999027B3197955');
    const POOL = getAddress('0x00000000000000000000000000000000000000aa');
    const price = 230.4;
    const R = 50_000; // USDT-side virtual reserve: impact(x) = 1 − R/(R + x)
    const sqrtPriceX96 = BigInt(Math.round(Math.sqrt(price) * 2 ** 96));
    const chain = {
      readMany: async (calls: { functionName: string; args?: readonly unknown[] }[]) =>
        calls.map((c) => {
          switch (c.functionName) {
            case 'token0':
              return { ok: true, value: TOKEN };
            case 'token1':
              return { ok: true, value: USDT };
            case 'fee':
              return { ok: true, value: 2500 };
            case 'slot0':
              return { ok: true, value: [sqrtPriceX96, 0, 0, 0, 0, 0, true] };
            case 'quoteExactInputSingle': {
              const x = Number((c.args![0] as { amountIn: bigint }).amountIn) / 1e18;
              const out = ((R / price) * x) / (R + x);
              return { ok: true, value: [BigInt(Math.floor(out * 1e18)), 0n, 0, 0n] };
            }
          }
          return { ok: false, error: 'unexpected' };
        }),
    } as unknown as Chain;
    const prices: PriceSource = {
      label: 'stub',
      quote: async () => ({
        marks: new Map(),
        pools: new Map([
          [
            TOKEN,
            [
              {
                pair: POOL,
                dex: 'pancakeswap',
                labels: ['v3'],
                token0Symbol: 'NVDAB',
                token1Symbol: 'USDT',
                baseToken: TOKEN,
                quoteToken: USDT,
                liquidityUsd: 100_000,
              },
            ],
          ],
        ]),
      }),
    };
    const book = (await readBooks({ chain, prices }, [{ address: TOKEN, decimals: 18 }], USDT)).get(TOKEN)!;
    expect(book.source).toBe('onchain');
    expect(book.pool!.label).toBe('PancakeSwap V3 0x0000…00AA (fee 0.25%)');
    expect(book.rawPrice!).toBeCloseTo(price, 6);
    // Exact 1% depth for this curve is R·(1/0.99 − 1) ≈ $505; the ladder reports the largest size it proved.
    const exact = R * (1 / 0.99 - 1);
    expect(book.depth1pctUsd!).toBeLessThanOrEqual(exact);
    expect(book.depth1pctUsd!).toBeGreaterThan(0.9 * exact);
    expect(book.depthAtLeast).toBe(false);
  });
});
