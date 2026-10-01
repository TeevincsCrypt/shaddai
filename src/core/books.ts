/**
 * Per-wrapper order book, read from its highest-liquidity USDT pool on BSC.
 *
 * Pools come from DexScreener's listing (it knows which pools exist); the price
 * and depth come from the pool itself when it is a PancakeSwap V2 or V3 pool:
 * V2 from reserves, V3 from slot0 and PancakeSwap's QuoterV2. Anything else
 * falls back to DexScreener's price and says so. Prices here are per RAW token;
 * share-equivalent prices are derived by the caller with the on-chain factor.
 *
 * "1% depth" is the USDT a buy can spend before its average price is 1% worse
 * than a tiny buy's (fees cancel out), the same measure Buy uses for impact.
 */
import { getAddress, type Address } from 'viem';
import { v2PairAbi, v3PoolAbi, v3QuoterAbi } from './abi.js';
import type { Chain, ReadCall, ReadResult } from './chain.js';
import { PANCAKE_V2_FEE_BPS } from './onchain-quote.js';
import type { MarkQuote, PoolRef, PriceSource } from './prices.js';
import { PANCAKE_V3_QUOTER } from './registry.js';

export const DEPTH_IMPACT = 0.01;
/** Pools below this are too thin to quote a wrapper from (Spread marks them, Buy refuses them). */
export const MIN_LIQUIDITY_USD = 25_000;
const USDT_DECIMALS = 18;

export interface WrapperBook {
  token: Address;
  source: 'onchain' | 'dexscreener' | 'none';
  pool: { pair: Address; dex: string; kind: 'v2' | 'v3' | 'other'; label: string; url?: string } | null;
  /** USD per raw token. */
  rawPrice: number | null;
  liquidityUsd: number | null;
  /** USDT a buy can spend within 1% average impact; null when not measured. */
  depth1pctUsd: number | null;
  /** True when the largest amount tried still stayed within 1%. */
  depthAtLeast: boolean;
  notes: string[];
}

const isV3 = (p: PoolRef) => p.labels.some((l) => /^v3$/i.test(l));
const isOtherCl = (p: PoolRef) => p.labels.some((l) => /v4|infinity|cl/i.test(l));
const short = (a: Address) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const val = <T>(r: ReadResult | undefined) => (r?.ok ? (r.value as T) : undefined);
const pow10 = (d: number) => 10 ** d;

/** Pools that pair the token with USDT, deepest first (DexScreener liquidity). */
export function usdtPools(token: Address, refs: PoolRef[], usdt: Address): PoolRef[] {
  const other = (p: PoolRef) => {
    if (p.baseToken && p.quoteToken) return p.baseToken === token ? p.quoteToken : p.baseToken;
    return null;
  };
  return refs
    .filter((p) => {
      const o = other(p);
      return o ? o === usdt : [p.token0Symbol, p.token1Symbol].includes('USDT');
    })
    .sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));
}

/** V2 (no fee in the measure): impact(Δ) = 1 − R/(R + Δ·(1−f)), so 1% depth = R·(1/0.99 − 1)/(1−f). */
export function v2Depth(usdtReserve: number): number {
  const keep = 1 - Number(PANCAKE_V2_FEE_BPS) / 10_000;
  return (usdtReserve * (1 / (1 - DEPTH_IMPACT) - 1)) / keep;
}

/** Amounts tried for a V3 pool: $1 reference, then $25 doubling to about $820k. */
const LADDER = [1, ...Array.from({ length: 16 }, (_, i) => 25 * 2 ** i)];

async function v3Depth(
  chain: Chain,
  quoter: Address,
  usdt: Address,
  token: Address,
  fee: number,
): Promise<{ usd: number | null; atLeast: boolean }> {
  const call = (usd: number): ReadCall => ({
    to: quoter,
    abi: v3QuoterAbi,
    functionName: 'quoteExactInputSingle',
    args: [
      {
        tokenIn: usdt,
        tokenOut: token,
        amountIn: BigInt(Math.round(usd * 1e6)) * 10n ** BigInt(USDT_DECIMALS - 6),
        fee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const outs = async (amounts: number[]) =>
    (await chain.readMany(amounts.map(call))).map((r) => {
      const q = val<readonly [bigint, bigint, number, bigint]>(r);
      return q && q[0] > 0n ? Number(q[0]) : null;
    });
  const first = await outs(LADDER);
  const ref = first[0];
  if (!ref) return { usd: null, atLeast: false };
  const within = (usd: number, out: number | null) => out !== null && 1 - out / usd / ref <= DEPTH_IMPACT;
  let pass = 0; // index into LADDER of the last amount within 1%
  for (let i = 1; i < LADDER.length; i++) {
    if (!within(LADDER[i]!, first[i]!)) break;
    pass = i;
  }
  if (pass === LADDER.length - 1) return { usd: LADDER[pass]!, atLeast: true };
  // Refine between the last pass and the first fail with six geometric steps.
  const lo = LADDER[pass]!;
  const hi = LADDER[pass + 1]!;
  const steps = Array.from({ length: 6 }, (_, i) => lo * (hi / lo) ** ((i + 1) / 7));
  const fine = await outs(steps);
  // Below the first refinement step the book is effectively empty: report 0, not "unread".
  let best = pass === 0 ? 0 : lo;
  steps.forEach((usd, i) => {
    if (within(usd, fine[i]!)) best = usd;
  });
  return { usd: best, atLeast: false };
}

/**
 * Reads each token's highest-liquidity USDT pool. One DexScreener call for all
 * tokens; one multicall for pool heads; quoter ladders only for V3 pools.
 */
export async function readBooks(
  deps: { chain: Chain; prices: PriceSource; quoter?: Address },
  tokens: { address: Address; decimals: number }[],
  usdt: Address,
): Promise<Map<Address, WrapperBook>> {
  const out = new Map<Address, WrapperBook>();
  let marks = new Map<Address, MarkQuote>();
  let pools = new Map<Address, PoolRef[]>();
  try {
    ({ marks, pools } = await deps.prices.quote(tokens.map((t) => t.address)));
  } catch (e) {
    for (const t of tokens) {
      out.set(t.address, {
        token: t.address,
        source: 'none',
        pool: null,
        rawPrice: null,
        liquidityUsd: null,
        depth1pctUsd: null,
        depthAtLeast: false,
        notes: [`Pool listing unavailable (${deps.prices.label}: ${(e as Error).message}).`],
      });
    }
    return out;
  }

  const picks = tokens.map((t) => {
    const best = usdtPools(t.address, pools.get(t.address) ?? [], usdt)[0] ?? null;
    const pcs = best && best.dex === 'pancakeswap' && !isOtherCl(best) ? best : null;
    return { t, best, pcs, v3: pcs ? isV3(pcs) : false };
  });

  const heads = await deps.chain.readMany(
    picks.flatMap(({ pcs, v3 }) =>
      !pcs
        ? []
        : v3
          ? [
              { to: pcs.pair, abi: v3PoolAbi, functionName: 'token0' } as ReadCall,
              { to: pcs.pair, abi: v3PoolAbi, functionName: 'token1' } as ReadCall,
              { to: pcs.pair, abi: v3PoolAbi, functionName: 'fee' } as ReadCall,
              { to: pcs.pair, abi: v3PoolAbi, functionName: 'slot0' } as ReadCall,
            ]
          : [
              { to: pcs.pair, abi: v2PairAbi, functionName: 'token0' } as ReadCall,
              { to: pcs.pair, abi: v2PairAbi, functionName: 'token1' } as ReadCall,
              { to: pcs.pair, abi: v2PairAbi, functionName: 'getReserves' } as ReadCall,
            ],
    ),
  );

  let at = 0;
  for (const { t, best, pcs, v3 } of picks) {
    const mark = marks.get(t.address);
    const fallback = (why: string): WrapperBook => ({
      token: t.address,
      source: best?.rawUsd ? 'dexscreener' : mark ? 'dexscreener' : 'none',
      pool: best
        ? {
            pair: best.pair,
            dex: best.dex,
            kind: isV3(best) ? 'v3' : isOtherCl(best) ? 'other' : 'v2',
            label: `${best.dex} ${best.labels.join('/') || 'pool'} ${best.token0Symbol}/${best.token1Symbol}`,
            url: best.url,
          }
        : mark
          ? {
              pair: mark.pair,
              dex: mark.dex,
              kind: 'other',
              label: `${mark.dex} pool ${short(mark.pair)}`,
              url: mark.url,
            }
          : null,
      rawPrice: best?.rawUsd ?? mark?.rawUsd ?? null,
      liquidityUsd: best?.liquidityUsd ?? mark?.liquidityUsd ?? null,
      depth1pctUsd: null,
      depthAtLeast: false,
      notes: [why],
    });

    if (!best) {
      out.set(
        t.address,
        fallback(
          mark
            ? `No USDT pool listed; price is DexScreener's deepest pool (${mark.dex} ${short(mark.pair)}). Depth not measured.`
            : 'No pool listed for this token.',
        ),
      );
      continue;
    }
    if (!pcs) {
      out.set(
        t.address,
        fallback(`Deepest USDT pool is not a PancakeSwap V2/V3 pool; price from DexScreener, depth not measured.`),
      );
      continue;
    }

    const n = v3 ? 4 : 3;
    const h = heads.slice(at, at + n);
    at += n;
    const [t0, t1] = [val<string>(h[0]), val<string>(h[1])];
    const matches =
      t0 &&
      t1 &&
      [getAddress(t0), getAddress(t1)].includes(t.address) &&
      [getAddress(t0), getAddress(t1)].includes(usdt);
    if (!matches) {
      out.set(
        t.address,
        fallback(`Pool ${short(pcs.pair)} did not answer as a token/USDT pool on chain; price from DexScreener.`),
      );
      continue;
    }
    const tokenIs0 = getAddress(t0!) === t.address;
    const kind = v3 ? 'v3' : 'v2';
    const pool = {
      pair: pcs.pair,
      dex: 'pancakeswap',
      kind,
      label: v3
        ? `PancakeSwap V3 ${short(pcs.pair)} (fee ${(val<number>(h[2]) ?? 0) / 10_000}%)`
        : `PancakeSwap V2 ${short(pcs.pair)}`,
      url: pcs.url,
    } as const;

    if (!v3) {
      const r = val<readonly [bigint, bigint, number]>(h[2]);
      if (!r || r[0] === 0n || r[1] === 0n) {
        out.set(t.address, fallback(`Pool ${short(pcs.pair)} returned no reserves; price from DexScreener.`));
        continue;
      }
      const [rTok, rUsd] = tokenIs0 ? [r[0], r[1]] : [r[1], r[0]];
      const tok = Number(rTok) / pow10(t.decimals);
      const usd = Number(rUsd) / pow10(USDT_DECIMALS);
      out.set(t.address, {
        token: t.address,
        source: 'onchain',
        pool,
        rawPrice: usd / tok,
        liquidityUsd: pcs.liquidityUsd ?? 2 * usd,
        depth1pctUsd: v2Depth(usd),
        depthAtLeast: false,
        notes: [],
      });
      continue;
    }

    const fee = val<number>(h[2]);
    const slot = val<readonly [bigint, ...unknown[]]>(h[3]);
    if (fee === undefined || !slot || slot[0] === 0n) {
      out.set(t.address, fallback(`Pool ${short(pcs.pair)} returned no price (slot0); price from DexScreener.`));
      continue;
    }
    const sqrt = Number(slot[0]) / 2 ** 96;
    const dec0 = tokenIs0 ? t.decimals : USDT_DECIMALS;
    const dec1 = tokenIs0 ? USDT_DECIMALS : t.decimals;
    const p1per0 = sqrt * sqrt * pow10(dec0 - dec1);
    const rawPrice = tokenIs0 ? p1per0 : 1 / p1per0;
    const depth = await v3Depth(deps.chain, deps.quoter ?? PANCAKE_V3_QUOTER, usdt, t.address, fee).catch(() => ({
      usd: null,
      atLeast: false,
    }));
    out.set(t.address, {
      token: t.address,
      source: 'onchain',
      pool,
      rawPrice,
      liquidityUsd: pcs.liquidityUsd ?? null,
      depth1pctUsd: depth.usd,
      depthAtLeast: depth.atLeast,
      notes: depth.usd === null ? ['QuoterV2 did not price a small buy in this pool; depth not measured.'] : [],
    });
  }
  return out;
}
