/**
 * Quote-only fallback for Buy: prices a ticket against PancakeSwap V2 pool
 * reserves read on BSC, so the share-true comparison still has live numbers
 * when the Binance Web3 API refuses this server. Nothing can be traded through
 * it. Only pools DexScreener labels PancakeSwap V2 are used, because their swap
 * fee is known (0.25%); other pools are skipped rather than guessed.
 */
import { getAddress, type Address } from 'viem';
import { v2PairAbi } from './abi.js';
import type { Chain, ReadCall } from './chain.js';
import type { PriceSource } from './prices.js';
import { TradeApiError, type Route, type TradeApi } from './trade-api.js';

/** PancakeSwap V2 swap fee, in basis points. */
export const PANCAKE_V2_FEE_BPS = 25n;

const notHere = (what: string) => async (): Promise<never> => {
  throw new TradeApiError(`${what}: needs the Binance Web3 API; on-chain pools only give quotes`);
};

export class OnchainQuoteApi implements TradeApi {
  readonly label = 'On-chain pools (PancakeSwap V2 reserves)';
  readonly quoteOnly = true;

  constructor(
    private readonly chain: Chain,
    private readonly prices: PriceSource,
  ) {}

  async quote(p: { from: Address; to: Address; amount: bigint }): Promise<Route[]> {
    const { pools } = await this.prices.quote([p.to]);
    const candidates = (pools.get(p.to) ?? []).filter(
      (x) => x.dex === 'pancakeswap' && !x.labels.some((l) => /v3|v4|infinity|cl/i.test(l)),
    );
    if (!candidates.length) return [];
    const res = await this.chain.readMany(
      candidates.flatMap((c) => [
        { to: c.pair, abi: v2PairAbi, functionName: 'token0' } as ReadCall,
        { to: c.pair, abi: v2PairAbi, functionName: 'token1' } as ReadCall,
        { to: c.pair, abi: v2PairAbi, functionName: 'getReserves' } as ReadCall,
      ]),
    );
    const routes: Route[] = [];
    candidates.forEach((c, i) => {
      const [a, b, r] = [res[i * 3], res[i * 3 + 1], res[i * 3 + 2]];
      if (!a?.ok || !b?.ok || !r?.ok) return;
      const t0 = getAddress(a.value as string);
      const t1 = getAddress(b.value as string);
      if (!((t0 === p.from && t1 === p.to) || (t0 === p.to && t1 === p.from))) return;
      const [r0, r1] = r.value as readonly [bigint, bigint, number];
      const [rIn, rOut] = t0 === p.from ? [r0, r1] : [r1, r0];
      if (rIn === 0n || rOut === 0n) return;
      // Uniswap V2 getAmountOut with PancakeSwap's fee.
      const inAfterFee = p.amount * (10_000n - PANCAKE_V2_FEE_BPS);
      const out = (inAfterFee * rOut) / (rIn * 10_000n + inAfterFee);
      // Impact against the pool's own spot price after fee.
      const atSpot = (inAfterFee * rOut) / (rIn * 10_000n);
      const impact = atSpot > 0n ? (1 - Number(out) / Number(atSpot)) * 100 : null;
      routes.push({
        quoteId: `onchain:${c.pair}`,
        vendorName: `PancakeSwap V2 pool ${c.pair.slice(0, 6)}…${c.pair.slice(-4)}`,
        fromAmount: p.amount,
        toAmount: out,
        priceImpactPercent: impact,
        executionMode: 'QUOTE ONLY',
        approveTarget: null,
        isBest: false,
        tradeFeeUsd: null,
      });
    });
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
