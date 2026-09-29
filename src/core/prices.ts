import { getAddress, type Address } from 'viem';

/** A price per raw token (what a DEX pool trades), plus the pools it came from. */
export interface MarkQuote {
  rawUsd: number;
  dex: string;
  pair: Address;
  liquidityUsd: number;
  url?: string;
  thin: boolean;
}

export interface PoolRef {
  pair: Address;
  dex: string;
  labels: string[];
  token0Symbol: string;
  token1Symbol: string;
  url?: string;
}

export interface PriceSource {
  readonly label: string;
  quote(tokens: Address[]): Promise<{ marks: Map<Address, MarkQuote>; pools: Map<Address, PoolRef[]> }>;
}

interface DexPair {
  chainId: string;
  dexId: string;
  url?: string;
  pairAddress: string;
  labels?: string[];
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
}

const THIN_LIQUIDITY_USD = 10_000;

/**
 * DexScreener marks. DEX pools trade raw tokens, so `priceUsd` is a price per
 * raw token; per-share price is derived later as rawUsd / multiplier.
 */
export class DexScreenerSource implements PriceSource {
  readonly label = 'DexScreener';
  private cache = new Map<string, { at: number; pairs: DexPair[] }>();

  constructor(private readonly opts: { fetchImpl?: typeof fetch; ttlMs?: number; base?: string } = {}) {}

  private get f() {
    return this.opts.fetchImpl ?? fetch;
  }

  private async fetchPairs(tokens: Address[]): Promise<DexPair[]> {
    const base = this.opts.base ?? 'https://api.dexscreener.com';
    const ttl = this.opts.ttlMs ?? 60_000;
    const out: DexPair[] = [];
    for (let i = 0; i < tokens.length; i += 30) {
      const chunk = tokens.slice(i, i + 30);
      const key = chunk.join(',').toLowerCase();
      const hit = this.cache.get(key);
      if (hit && Date.now() - hit.at < ttl) {
        out.push(...hit.pairs);
        continue;
      }
      const res = await this.f(`${base}/tokens/v1/bsc/${chunk.join(',')}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
      const body = (await res.json()) as DexPair[] | { pairs?: DexPair[] };
      const pairs = Array.isArray(body) ? body : (body.pairs ?? []);
      this.cache.set(key, { at: Date.now(), pairs });
      out.push(...pairs);
    }
    return out;
  }

  async quote(tokens: Address[]) {
    const pairs = (await this.fetchPairs(tokens)).filter((p) => p.chainId === 'bsc');
    return pickMarks(tokens, pairs);
  }
}

export function pickMarks(tokens: Address[], pairs: DexPair[]) {
  const marks = new Map<Address, MarkQuote>();
  const pools = new Map<Address, PoolRef[]>();
  for (const token of tokens) {
    const lc = token.toLowerCase();
    let best: MarkQuote | null = null;
    const refs: PoolRef[] = [];
    for (const p of pairs) {
      const isBase = p.baseToken.address.toLowerCase() === lc;
      const isQuote = p.quoteToken.address.toLowerCase() === lc;
      if (!isBase && !isQuote) continue;
      refs.push({
        pair: getAddress(p.pairAddress),
        dex: p.dexId,
        labels: p.labels ?? [],
        token0Symbol: p.baseToken.symbol,
        token1Symbol: p.quoteToken.symbol,
        url: p.url,
      });
      const baseUsd = Number(p.priceUsd);
      const native = Number(p.priceNative);
      if (!Number.isFinite(baseUsd) || baseUsd <= 0) continue;
      // priceNative = base price in quote units, so quote USD = baseUsd / priceNative.
      const rawUsd = isBase ? baseUsd : native > 0 ? baseUsd / native : NaN;
      if (!Number.isFinite(rawUsd) || rawUsd <= 0) continue;
      const liq = p.liquidity?.usd ?? 0;
      if (!best || liq > best.liquidityUsd) {
        best = {
          rawUsd,
          dex: p.dexId,
          pair: getAddress(p.pairAddress),
          liquidityUsd: liq,
          url: p.url,
          thin: liq < THIN_LIQUIDITY_USD,
        };
      }
    }
    if (best) marks.set(token, best);
    pools.set(token, refs);
  }
  return { marks, pools };
}

/** Fixed marks for demo mode and tests. */
export class StaticPriceSource implements PriceSource {
  readonly label: string;
  constructor(
    private readonly marks: Map<Address, MarkQuote>,
    private readonly pools: Map<Address, PoolRef[]> = new Map(),
    label = 'fixture',
  ) {
    this.label = label;
  }
  async quote(tokens: Address[]) {
    const marks = new Map<Address, MarkQuote>();
    const pools = new Map<Address, PoolRef[]>();
    for (const t of tokens) {
      const m = this.marks.get(t);
      if (m) marks.set(t, m);
      pools.set(t, this.pools.get(t) ?? []);
    }
    return { marks, pools };
  }
}
