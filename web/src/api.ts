import type { BuyQuote, PayInSymbol, PrepareResult, WrapperQuote } from '../../src/core/buy';
import type { DividendAnswer } from '../../src/core/dividend';
import type { PreviewResult } from '../../src/core/preview';
import type { SpreadResult, SpreadRow } from '../../src/core/spread';
import type { OrderStatus } from '../../src/core/trade-api';
import type { FeedResult, ScanResult } from '../../src/core/types';

export type {
  BuyQuote,
  DividendAnswer,
  FeedResult,
  OrderStatus,
  PayInSymbol,
  PrepareResult,
  PreviewResult,
  ScanResult,
  SpreadResult,
  SpreadRow,
  WrapperQuote,
};

export interface BuyConfigResponse {
  mode: 'live' | 'demo';
  enabled: boolean;
  /** False when only quotes are available (no trading API). */
  trading: boolean;
  api: string | null;
  limits: { maxUsd: number; maxImpactPct: number; slippagePct: string; minLiquidityUsd: number } | null;
  payIn: PayInSymbol[];
  tickers: { ticker: string; name: string; wrappers: { symbol: string; issuer: string; address: string }[] }[];
}

export interface AppConfigResponse {
  mode: 'live' | 'demo';
  demoAddress: string;
  examples: { label: string; address: string }[];
  links: Record<string, string>;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  config: () => getJson<AppConfigResponse>('/api/config'),
  scan: (address: string, poll = false) =>
    getJson<ScanResult>(`/api/scan?address=${encodeURIComponent(address)}${poll ? '&poll=1' : ''}`),
  feed: (demo: boolean) => getJson<FeedResult>(`/api/feed${demo ? '?demo=1' : ''}`),
  spreadTickers: (demo: boolean) =>
    getJson<{ tickers: string[]; mode: 'live' | 'demo' }>(`/api/spread${demo ? '?demo=1' : ''}`),
  spread: (ticker: string, demo: boolean) =>
    getJson<SpreadResult>(`/api/spread?ticker=${encodeURIComponent(ticker)}${demo ? '&demo=1' : ''}`),
  preview: (address: string, demo: boolean) =>
    getJson<PreviewResult>(`/api/preview?address=${encodeURIComponent(address)}${demo ? '&demo=1' : ''}`),
  dividend: (address: string, ticker: string, demo: boolean) =>
    getJson<DividendAnswer>(
      `/api/dividend?address=${encodeURIComponent(address)}&ticker=${encodeURIComponent(ticker)}${demo ? '&demo=1' : ''}`,
    ),
  csvUrl: (address: string) => `/api/ledger.csv?address=${encodeURIComponent(address)}`,
  buyConfig: (demo: boolean) => getJson<BuyConfigResponse>(`/api/buy/config${demo ? '?demo=1' : ''}`),
  buyQuote: (p: { ticker: string; usd: number; payIn: PayInSymbol; wallet?: string | null }, demo: boolean) => {
    const q = new URLSearchParams({ ticker: p.ticker, usd: String(p.usd), payIn: p.payIn });
    if (p.wallet) q.set('wallet', p.wallet);
    if (demo) q.set('demo', '1');
    return getJson<BuyQuote>(`/api/buy/quote?${q}`);
  },
  buyPrepare: (
    body: { token: string; usd: number; payIn: PayInSymbol; wallet: string; demoSkipAllowance?: boolean },
    demo: boolean,
  ) => getJson<PrepareResult>(`/api/buy/prepare${demo ? '?demo=1' : ''}`, post(body)),
  buySubmit: (body: {
    requestId: string;
    signature: string;
    vendor: string;
    quoteId: string;
    signingScheme: string | null;
  }) => getJson<{ orderId: string; status: string }>('/api/buy/submit', post(body)),
  buyOrder: (id: string) => getJson<OrderStatus>(`/api/buy/order/${encodeURIComponent(id)}`),
};

function post(body: object): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}
