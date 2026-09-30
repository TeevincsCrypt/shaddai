import { describe, expect, it } from 'vitest';
import { getAbiItem, getAddress, parseUnits, toFunctionSelector } from 'viem';
import { v3QuoterAbi } from '../src/core/abi.js';
import type { Chain } from '../src/core/chain.js';
import { StaticPriceSource } from '../src/core/prices.js';
import { PANCAKE_V3_QUOTER } from '../src/core/registry.js';
import { BUY_COPY, prepareBuy, quoteText, quoteWithFallback } from '../src/core/buy.js';
import { OnchainQuoteApi } from '../src/core/onchain-quote.js';
import { TradeApiError } from '../src/core/trade-api.js';
import { DEMO_ADDRESS, DEMO_USDT } from '../src/fixtures/demo.js';
import type { FakeTradeApi } from '../src/fixtures/fake-trade-api.js';
import { createApp } from '../src/server/app.js';
import { demoContext } from '../src/server/context.js';

const NOW = Date.UTC(2026, 8, 29, 16) / 1000;
const AAPLB = getAddress('0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A');
const u = (v: string) => parseUnits(v, 18);

/** Demo context with the on-chain quoter as fallback; `keyed` keeps the (fixture) Binance API. */
function ctxWithFallback(keyed: boolean, maxUsd = 25) {
  const ctx = demoContext(NOW);
  const limits = { maxUsd, maxImpactPct: 1, slippagePct: '0.5', quoteWallet: null, usd1: null };
  ctx.buyFallback = { api: new OnchainQuoteApi(ctx.chain, ctx.prices), ...limits };
  if (!keyed) ctx.buy = undefined;
  return ctx;
}

describe('on-chain quote fallback', () => {
  it('prices a V2 pool exactly as getAmountOut with the 0.25% fee', async () => {
    const ctx = demoContext(NOW);
    const api = new OnchainQuoteApi(ctx.chain, ctx.prices);
    const [r] = await api.quote({ from: DEMO_USDT, to: AAPLB, amount: u('100') });
    // Demo pool: 2000 AAPLB / 457276.024 USDT.
    const inAfterFee = u('100') * 9975n;
    const expected = (inAfterFee * u('2000')) / (u('457276.024') * 10000n + inAfterFee);
    expect(r!.toAmount).toBe(expected);
    expect(r!.executionMode).toBe('QUOTE ONLY');
    expect(r!.priceImpactPercent!).toBeGreaterThan(0);
    expect(r!.priceImpactPercent!).toBeLessThan(0.05);
    // A pool DexScreener lists but the chain does not answer is not guessed at; the refusal names what was listed.
    await expect(
      api.quote({ from: DEMO_USDT, to: getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436'), amount: u('1') }),
    ).rejects.toThrow(
      'No PancakeSwap V2 or V3 pool prices this token against the pay-in token. Pools DexScreener lists for it: pancakeswap v2 NVDAB/USDT.',
    );
  });

  it('quotes from pools when Buy has no key, and cannot trade', async () => {
    const ctx = ctxWithFallback(false);
    const q = await quoteWithFallback(ctx, { ticker: 'AAPL', usd: 20 });
    expect(q.quoteOnly).toBe(true);
    expect(q.notes[0]).toBe('Buy is not switched on here (no Binance Web3 API key).');
    expect(q.notes[1]).toMatch(/^On-chain pool quote: a comparison only/);
    const [b, on] = q.wrappers;
    expect(b).toMatchObject({ status: 'ok', referenceSource: 'dex-mark', factorSource: 'uiMultiplier' });
    expect(b!.route!.vendor).toMatch(/^PancakeSwap V2 pool 0xde30/i);
    expect(Number(b!.shareEqOut)).toBeCloseTo(Number(b!.rawOut) * 1.000604, 12);
    expect(on!.reasons[0]).toMatch(/^No PancakeSwap V2 or V3 pool .* lists for it: pancakeswap v2 AAPLon\/USDT\.$/);
    expect(q.best).toBe(AAPLB);

    ctx.buy = ctx.buyFallback;
    await expect(prepareBuy(ctx, { token: AAPLB, usd: 20, wallet: DEMO_ADDRESS })).rejects.toThrow(
      /comparison only; buying needs the Binance Web3 API/,
    );
  });

  it('attaches the pool comparison when Binance refuses every wrapper', async () => {
    const ctx = ctxWithFallback(true);
    (ctx.buy!.api as FakeTradeApi).quote = async () => {
      throw new TradeApiError('Quote: Service not available due to compliance restriction (code 40304)', 40304);
    };
    const q = await quoteWithFallback(ctx, { ticker: 'AAPL', usd: 20 });
    expect(q.best).toBeNull();
    expect(q.fallback!.quoteOnly).toBe(true);
    expect(q.fallback!.best).toBe(AAPLB);
    expect(quoteText(q)).toContain('On-chain pools instead (comparison only; nothing can be bought through this):');

    // No fallback when Binance answers.
    const ok = await quoteWithFallback(ctxWithFallback(true), { ticker: 'AAPL', usd: 20 });
    expect(ok.fallback).toBeUndefined();
  });

  it('prices a V3 pool through QuoterV2 with the pool fee tier', async () => {
    const pool = getAddress('0x00000000000000000000000000000000000c0003');
    const seen: { to: string; fn: string; args?: readonly unknown[] }[] = [];
    const chain = {
      readMany: async (calls: { to: string; functionName: string; args?: readonly unknown[] }[]) =>
        calls.map((c) => {
          seen.push({ to: c.to, fn: c.functionName, args: c.args });
          if (c.to === pool && c.functionName === 'token0') return { ok: true, value: DEMO_USDT };
          if (c.to === pool && c.functionName === 'token1') return { ok: true, value: AAPLB };
          if (c.to === pool && c.functionName === 'fee') return { ok: true, value: 2500 };
          if (c.to === PANCAKE_V3_QUOTER) return { ok: true, value: [u('0.08'), 1n, 1, 90000n] };
          return { ok: false, error: 'revert' };
        }),
    } as unknown as Chain;
    const prices = new StaticPriceSource(
      new Map(),
      new Map([
        [AAPLB, [{ pair: pool, dex: 'pancakeswap', labels: ['v3'], token0Symbol: 'AAPLB', token1Symbol: 'USDT' }]],
      ]),
    );
    const [r] = await new OnchainQuoteApi(chain, prices).quote({ from: DEMO_USDT, to: AAPLB, amount: u('20') });
    expect(r).toMatchObject({
      toAmount: u('0.08'),
      priceImpactPercent: null,
      vendorName: expect.stringContaining('(fee 0.25%)'),
    });
    const q = seen.find((x) => x.fn === 'quoteExactInputSingle')!;
    expect(q.args![0]).toEqual({
      tokenIn: DEMO_USDT,
      tokenOut: AAPLB,
      amountIn: u('20'),
      fee: 2500,
      sqrtPriceLimitX96: 0n,
    });
    // Same function as PancakeSwap's QuoterV2 (and Uniswap's): quoteExactInputSingle((address,address,uint256,uint24,uint160)).
    expect(toFunctionSelector(getAbiItem({ abi: v3QuoterAbi, name: 'quoteExactInputSingle' }))).toBe(
      toFunctionSelector('quoteExactInputSingle((address,address,uint256,uint24,uint160))'),
    );
  });

  it('applies the 1% rule to pool quotes too', async () => {
    const q = await quoteWithFallback(ctxWithFallback(false, 10_000), { ticker: 'AAPLB', usd: 6000 });
    expect(q.wrappers[0]!.status).toBe('refused');
    expect(q.wrappers[0]!.reasons[0]).toMatch(/^Thin book: a \$6000 ticket moves the price/);
  });

  it('serves quotes over HTTP with trading off', async () => {
    const ctx = ctxWithFallback(false);
    const app = createApp({ mode: 'demo', live: () => ctx, demo: () => ctx });
    const cfg = (await (await app.request('/api/buy/config')).json()) as {
      enabled: boolean;
      trading: boolean;
      api: string;
    };
    expect(cfg).toMatchObject({ enabled: true, trading: false, api: 'On-chain pools (PancakeSwap V2/V3)' });
    const q = await app.request('/api/buy/quote?ticker=AAPL&usd=10');
    expect(((await q.json()) as { quoteOnly: boolean }).quoteOnly).toBe(true);
  });
});

describe('compliance short-circuit', () => {
  it('skips Binance quotes once the RWA list is refused with 40304', async () => {
    const ctx = ctxWithFallback(true);
    const api = ctx.buy!.api as FakeTradeApi;
    api.rwaTokens = async () => {
      throw new TradeApiError(
        'RWA token list: Service not available due to compliance restriction (code 40304)',
        40304,
      );
    };
    let quotes = 0;
    api.quote = async () => {
      quotes++;
      return [];
    };
    const q = await quoteWithFallback(ctx, { ticker: 'AAPL', usd: 20 });
    expect(quotes).toBe(0);
    expect(q.wrappers.every((w) => w.reasons[0] === BUY_COPY.compliance)).toBe(true);
    expect(q.fallback!.best).toBe(AAPLB);
  });
});
