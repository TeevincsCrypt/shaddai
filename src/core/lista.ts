import { isHex, type Address, type Hex } from 'viem';
import type { TokenInfo } from './registry.js';

export interface ListaMarketSource {
  readonly label: string;
  /** Candidate Moolah market ids whose collateral may be a registry token. Verified on-chain afterwards. */
  candidateMarkets(tokens: TokenInfo[], holder: Address): Promise<Hex[]>;
}

interface ApiEnvelope<T> {
  code: string;
  msg?: string;
  data: T;
}

const isMarketId = (v: unknown): v is Hex => typeof v === 'string' && isHex(v) && v.length === 66;

/**
 * Lista's public API (the one lista-dao/lending-sdk wraps). Matching here is
 * deliberately loose (symbol or address); idToMarketParams() on Moolah is the
 * source of truth for which token a market actually takes as collateral.
 */
export class ListaApiSource implements ListaMarketSource {
  readonly label = 'Lista API';
  private marketsCache: { at: number; list: { id: Hex; collateral: string }[] } | null = null;

  constructor(
    private readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Lista API HTTP ${res.status} for ${path.split('?')[0]}`);
    const body = (await res.json()) as ApiEnvelope<T>;
    if (body.code !== '000000000') throw new Error(`Lista API code ${body.code}: ${body.msg ?? ''}`);
    return body.data;
  }

  private async allMarkets() {
    if (this.marketsCache && Date.now() - this.marketsCache.at < 10 * 60_000) return this.marketsCache.list;
    const list: { id: Hex; collateral: string }[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.get<{ total: number; list: { id: string; collateral: string }[] }>(
        `/api/moolah/borrow/markets?page=${page}&pageSize=100&chain=bsc`,
      );
      for (const m of data.list ?? [])
        if (isMarketId(m.id)) list.push({ id: m.id, collateral: String(m.collateral ?? '') });
      if ((data.list ?? []).length < 100 || list.length >= data.total) break;
    }
    this.marketsCache = { at: Date.now(), list };
    return list;
  }

  async candidateMarkets(tokens: TokenInfo[], holder: Address): Promise<Hex[]> {
    const wanted = new Set(tokens.flatMap((t) => [t.symbol.toLowerCase(), t.address.toLowerCase()]));
    const ids = new Set<Hex>();
    const errors: string[] = [];
    await Promise.all([
      this.allMarkets()
        .then((list) => {
          for (const m of list) if (wanted.has(m.collateral.toLowerCase())) ids.add(m.id);
        })
        .catch((e: Error) => errors.push(e.message)),
      this.get<{ objs?: { marketId?: string; collateralToken?: string; collateralSymbol?: string }[] }>(
        `/api/moolah/one/holding?userAddress=${holder}&type=market`,
      )
        .then((d) => {
          for (const o of d.objs ?? []) {
            const hit =
              wanted.has(String(o.collateralToken ?? '').toLowerCase()) ||
              wanted.has(String(o.collateralSymbol ?? '').toLowerCase());
            if (hit && isMarketId(o.marketId)) ids.add(o.marketId);
          }
        })
        .catch((e: Error) => errors.push(e.message)),
    ]);
    if (errors.length === 2) throw new Error(errors.join('; '));
    return [...ids];
  }
}

export class StaticListaSource implements ListaMarketSource {
  readonly label = 'fixture';
  constructor(private readonly ids: Hex[]) {}
  async candidateMarkets() {
    return this.ids;
  }
}
