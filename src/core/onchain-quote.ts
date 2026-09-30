/**
 * Quote-only fallback for Buy: prices a ticket against PancakeSwap pools read on
 * BSC, so the share-true comparison still has live numbers when the Binance Web3
 * API refuses this server. Nothing can be traded through it.
 *
 * V2 pools: Uniswap V2 getAmountOut with PancakeSwap's 0.25% fee, from reserves.
 * V3 pools: PancakeSwap's QuoterV2 (address from their deployments file), which
 * simulates the swap in the canonical pool for that token pair and fee tier.
 * Only pools DexScreener labels PancakeSwap are used; others are listed, not guessed.
 */
import { getAddress, type Address } from 'viem';
import { v2PairAbi, v3PoolAbi, v3QuoterAbi } from './abi.js';
import type { Chain, ReadCall, ReadResult } from './chain.js';
import type { PoolRef, PriceSource } from './prices.js';
import { PANCAKE_V3_QUOTER } from './registry.js';
import { TradeApiError, type Route, type TradeApi } from './trade-api.js';

/** PancakeSwap V2 swap fee, in basis points. */
export const PANCAKE_V2_FEE_BPS = 25n;

const notHere = (what: string) => async (): Promise<never> => {
  throw new TradeApiError(`${what}: needs the Binance Web3 API; on-chain pools only give quotes`);
};

const isV3 = (p: PoolRef) => p.labels.some((l) => /^v3$/i.test(l));
const isOtherCl = (p: PoolRef) => p.labels.some((l) => /v4|infinity|cl/i.test(l));
const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const val = <T>(r: ReadResult | undefined) => (r?.ok ? (r.value as T) : undefined);

export class OnchainQuoteApi implements TradeApi {
  readonly label = 'On-chain pools (PancakeSwap V2/V3)';
  readonly quoteOnly = true;

  constructor(
    private readonly chain: Chain,
    private readonly prices: PriceSource,
    private readonly quoter: Address = PANCAKE_V3_QUOTER,
  ) {}

  async quote(p: { from: Address; to: Address; amount: bigint }): Promise<Route[]> {
    const { pools } = await this.prices.quote([p.to]);
    const listed = pools.get(p.to) ?? [];
    const pcs = listed.filter((x) => x.dex === 'pancakeswap' && !isOtherCl(x));
    const v2 = pcs.filter((x) => !isV3(x));
    const v3 = pcs.filter(isV3);
    const pairs = (t0?: string, t1?: string) => {
      if (!t0 || !t1) return false;
      const [a, b] = [getAddress(t0), getAddress(t1)];
      return (a === p.from && b === p.to) || (a === p.to && b === p.from);
    };

    const heads = await this.chain.readMany([
      ...v2.flatMap((c) => [
        { to: c.pair, abi: v2PairAbi, functionName: 'token0' } as ReadCall,
        { to: c.pair, abi: v2PairAbi, functionName: 'token1' } as ReadCall,
        { to: c.pair, abi: v2PairAbi, functionName: 'getReserves' } as ReadCall,
      ]),
      ...v3.flatMap((c) => [
        { to: c.pair, abi: v3PoolAbi, functionName: 'token0' } as ReadCall,
        { to: c.pair, abi: v3PoolAbi, functionName: 'token1' } as ReadCall,
        { to: c.pair, abi: v3PoolAbi, functionName: 'fee' } as ReadCall,
      ]),
    ]);
    const routes: Route[] = [];

    v2.forEach((c, i) => {
      const [t0, t1] = [val<string>(heads[i * 3]), val<string>(heads[i * 3 + 1])];
      const r = val<readonly [bigint, bigint, number]>(heads[i * 3 + 2]);
      if (!r || !pairs(t0, t1)) return;
      const [rIn, rOut] = getAddress(t0!) === p.from ? [r[0], r[1]] : [r[1], r[0]];
      if (rIn === 0n || rOut === 0n) return;
      // Uniswap V2 getAmountOut with PancakeSwap's fee.
      const inAfterFee = p.amount * (10_000n - PANCAKE_V2_FEE_BPS);
      const out = (inAfterFee * rOut) / (rIn * 10_000n + inAfterFee);
      const atSpot = (inAfterFee * rOut) / (rIn * 10_000n);
      routes.push(
        route(
          p,
          `PancakeSwap V2 pool ${short(c.pair)}`,
          out,
          atSpot > 0n ? (1 - Number(out) / Number(atSpot)) * 100 : null,
        ),
      );
    });

    const off = v2.length * 3;
    const v3Live = v3
      .map((c, i) => ({
        c,
        t0: val<string>(heads[off + i * 3]),
        t1: val<string>(heads[off + i * 3 + 1]),
        fee: val<number>(heads[off + i * 3 + 2]),
      }))
      .filter((x) => x.fee !== undefined && pairs(x.t0, x.t1));
    if (v3Live.length) {
      const quotes = await this.chain.readMany(
        v3Live.map(
          (x) =>
            ({
              to: this.quoter,
              abi: v3QuoterAbi,
              functionName: 'quoteExactInputSingle',
              args: [{ tokenIn: p.from, tokenOut: p.to, amountIn: p.amount, fee: x.fee!, sqrtPriceLimitX96: 0n }],
            }) as ReadCall,
        ),
      );
      v3Live.forEach((x, i) => {
        const q = val<readonly [bigint, bigint, number, bigint]>(quotes[i]);
        if (!q || q[0] <= 0n) return;
        // Impact is measured by the caller against a smaller probe quote.
        routes.push(route(p, `PancakeSwap V3 pool ${short(x.c.pair)} (fee ${x.fee! / 10_000}%)`, q[0], null));
      });
    }

    if (!routes.length) {
      const seen = listed.length
        ? listed.map((x) => `${x.dex} ${x.labels.join('/') || 'pool'} ${x.token0Symbol}/${x.token1Symbol}`).join(', ')
        : 'none';
      throw new TradeApiError(
        `No PancakeSwap V2 or V3 pool prices this token against the pay-in token. Pools DexScreener lists for it: ${seen}.`,
      );
    }
    return routes;
  }

  rwaTokens = notHere('RWA token list');
  approveTx = notHere('Approve transaction');
  buildSwap = notHere('Build swap');
  submitOrder = notHere('Submit order');
  orderStatus = notHere('Order status');
  simulate = notHere('Simulate');
  searchToken = notHere('Token search');
  defiPositions = notHere('DeFi positions');
}

function route(p: { from: Address; amount: bigint }, vendor: string, out: bigint, impact: number | null): Route {
  return {
    quoteId: `onchain:${vendor}`,
    vendorName: vendor,
    fromAmount: p.amount,
    toAmount: out,
    priceImpactPercent: impact,
    executionMode: 'QUOTE ONLY',
    approveTarget: null,
    isBest: false,
    tradeFeeUsd: null,
  };
}
