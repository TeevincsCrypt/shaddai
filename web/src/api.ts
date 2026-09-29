import type { FeedResult, ScanResult } from '../../src/core/types';

export type { FeedResult, ScanResult };

export interface AppConfigResponse {
  mode: 'live' | 'demo';
  demoAddress: string;
  examples: { label: string; address: string }[];
  links: Record<string, string>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => ({ error: `HTTP ${res.status}` }))) as T & { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const api = {
  config: () => getJson<AppConfigResponse>('/api/config'),
  scan: (address: string, poll = false) =>
    getJson<ScanResult>(`/api/scan?address=${encodeURIComponent(address)}${poll ? '&poll=1' : ''}`),
  feed: (demo: boolean) => getJson<FeedResult>(`/api/feed${demo ? '?demo=1' : ''}`),
  csvUrl: (address: string) => `/api/ledger.csv?address=${encodeURIComponent(address)}`,
};
