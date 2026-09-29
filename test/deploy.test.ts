/**
 * The Vercel path end to end over real HTTP: a local JSON-RPC server backed by
 * the fixture chain stands in for BSC, the deploy-time snapshot is built through
 * it, and a cold "function" then answers from the snapshot plus a small top-up.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FileKV, LayeredKV, MemoryKV } from '../src/core/cache.js';
import { StaticListaSource } from '../src/core/lista.js';
import { StaticPriceSource } from '../src/core/prices.js';
import { scanAddress, type ShaddaiContext } from '../src/core/scan.js';
import { buildDemoScenario, DEMO_ADDRESS } from '../src/fixtures/demo.js';
import { FakeChain } from '../src/fixtures/fake-chain.js';
import { createLiveContext, defaultKV, loadConfig } from '../src/server/context.js';
import { buildSnapshot } from '../src/server/snapshot.js';

const NOW = Date.UTC(2026, 8, 29, 16) / 1000;

let server: Server;
let fake: FakeChain;
let rpcUrl: string;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'shaddai-'));
  dirs.push(d);
  return d;
};

beforeAll(async () => {
  fake = new FakeChain({ ...buildDemoScenario(NOW, () => NOW), maxLogRange: 1_000_000n });
  server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: unknown[] };
    let out: object;
    try {
      out = { jsonrpc: '2.0', id, result: await fake.request(method, params) };
    } catch (e) {
      const err = e as { code?: number; message: string };
      out = { jsonrpc: '2.0', id, error: { code: err.code ?? -32000, message: err.message } };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Live context pointed at the local RPC, with offline price and Lista sources. */
const hermetic = (ctx: ShaddaiContext) => {
  ctx.prices = new StaticPriceSource(new Map());
  ctx.lista = { ...ctx.lista!, source: new StaticListaSource([]) };
};

describe('config', () => {
  it('uses /tmp for the cache on Vercel and accepts inline extra tokens', () => {
    const cfg = loadConfig({
      VERCEL: '1',
      SHADDAI_EXTRA_TOKENS:
        '[{"symbol":"NVDAx","ticker":"NVDA","issuer":"xStocks","address":"0x000000000000000000000000000000000000aaaa"}]',
    });
    expect(cfg.cacheDir).toBe('/tmp/shaddai-cache');
    expect(cfg.extraTokens.map((t) => t.symbol)).toEqual(['NVDAx']);
  });
});

describe('LayeredKV', () => {
  it('reads through layers and writes to the first', async () => {
    const top = new MemoryKV();
    const seed = new MemoryKV();
    await seed.set('k', { v: 1 });
    const kv = new LayeredKV([top, seed]);
    expect(await kv.get('k')).toEqual({ v: 1 });
    await kv.set('k', { v: 2 });
    expect(await kv.get('k')).toEqual({ v: 2 });
    expect(await seed.get('k')).toEqual({ v: 1 });
  });
});

describe('deploy-time snapshot + cold function', () => {
  it('builds the snapshot in steps over HTTP, then a cold instance only tops up', async () => {
    const seedDir = tmp();
    const env = {
      BSC_RPC_URLS: rpcUrl,
      SHADDAI_SEED_DIR: seedDir,
      SHADDAI_CACHE_DIR: tmp(),
      SHADDAI_SCAN_FROM_DATE: '2026-05-01',
      SHADDAI_LOG_CHUNK: '1000000',
    };
    const cfg = loadConfig(env);
    const lines: string[] = [];
    const snap = await buildSnapshot(cfg, { step: 5_000_000n, log: (l) => lines.push(l), tweak: hermetic });
    expect(snap.complete).toBe(true);
    expect(snap.events).toBeGreaterThan(10);
    expect(lines.filter((l) => l.includes('events')).length).toBeGreaterThan(2); // stepped

    // The snapshot file is what vercel.json ships via includeFiles.
    expect(await new FileKV(seedDir).get('feed-bsc')).toBeDefined();

    // Cold instance: empty /tmp, read-only seed.
    const before = fake.calls.eth_getLogs ?? 0;
    const ctx = createLiveContext(loadConfig(env), defaultKV(loadConfig(env)));
    hermetic(ctx);
    const r = await scanAddress(ctx, DEMO_ADDRESS);
    expect(r.ledger.status).toBe('ready');
    const nvda = r.ledger.rows.filter((l) => l.token.symbol === 'NVDAB' && l.status === 'effective');
    expect(nvda.map((l) => l.deltaShareEq)).toEqual(['0.0085', '0.0085']);
    // Index top-up needed at most one range request (plus none for replay: archive state is available).
    expect((fake.calls.eth_getLogs ?? 0) - before).toBeLessThanOrEqual(1);
    expect(r.portfolio.rows.find((x) => x.token.symbol === 'NVDAB' && x.location.kind === 'venus')).toBeDefined();

    // /api/status on a cold instance reports the snapshot and config facts, never the endpoint URL.
    const keyed = { ...env, BSC_RPC_URLS: `${rpcUrl}/v1/SECRET-KEY` };
    const cold = createLiveContext(loadConfig(keyed), defaultKV(loadConfig(keyed)));
    const { createApp } = await import('../src/server/app.js');
    const app = createApp({ mode: 'live', live: () => cold, demo: () => cold });
    const res = await app.request('/api/status');
    const text = await res.text();
    const status = JSON.parse(text) as {
      config: Record<string, unknown>;
      feed: { status: string; scannedTo?: string; events: number };
    };
    expect(status.feed.status).toBe('ready');
    expect(status.feed.scannedTo).toBe(snap.scannedTo?.toString());
    expect(status.feed.events).toBe(snap.events);
    expect(status.config).toMatchObject({ customRpc: true, snapshotFile: true });
    expect(text).not.toContain('SECRET-KEY');
  });

  it('reports a fresh instance without a snapshot as not started', async () => {
    const env = { SHADDAI_SEED_DIR: tmp(), SHADDAI_CACHE_DIR: tmp() };
    const ctx = createLiveContext(loadConfig(env), defaultKV(loadConfig(env)));
    const { createApp } = await import('../src/server/app.js');
    const app = createApp({ mode: 'live', live: () => ctx, demo: () => ctx });
    const status = (await (await app.request('/api/status')).json()) as {
      config: Record<string, unknown>;
      feed: { status: string };
    };
    expect(status.feed.status).toBe('not started');
    expect(status.config).toMatchObject({ customRpc: false, snapshotFile: false });
  });

  it('keeps an unfinished ledger alive through the background hook', async () => {
    const env = {
      BSC_RPC_URLS: rpcUrl,
      SHADDAI_SEED_DIR: tmp(),
      SHADDAI_CACHE_DIR: tmp(),
      SHADDAI_LOG_CHUNK: '200000',
    };
    const kept: Promise<unknown>[] = [];
    const ctx = createLiveContext(loadConfig(env), new MemoryKV(), (p) => kept.push(p));
    hermetic(ctx);
    ctx.ledgerBudgetMs = 1; // force the "indexing" answer
    const r = await scanAddress(ctx, DEMO_ADDRESS);
    expect(r.ledger.status).toBe('indexing');
    expect(kept.length).toBe(1);
    await Promise.all(kept);
    const again = await scanAddress(ctx, DEMO_ADDRESS);
    expect(again.ledger.status).toBe('ready');
  });
});

describe('Vercel handler', () => {
  it('serves the API through @hono/node-server/vercel', async () => {
    process.env.BSC_RPC_URLS = rpcUrl;
    process.env.SHADDAI_CACHE_DIR = tmp();
    process.env.SHADDAI_SEED_DIR = tmp();
    const { default: handler } = await import('../api/index.js');
    const fnServer = createServer((req, res) => void handler(req, res));
    await new Promise<void>((r) => fnServer.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(fnServer.address() as AddressInfo).port}`;
    try {
      expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true });
      const res = await fetch(`${base}/api/scan?address=demo`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { mode: string }).mode).toBe('demo');
      expect((await fetch(`${base}/api/scan?address=nope`)).status).toBe(400);
    } finally {
      fnServer.close();
    }
  });
});
