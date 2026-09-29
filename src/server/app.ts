import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { getAddress, isAddress } from 'viem';
import {
  BuyError,
  buyOrderStatus,
  diagnoseBuy,
  PAY_IN_SYMBOLS,
  prepareBuy,
  quoteShareTrueBuy,
  submitBuy,
  type PayInSymbol,
} from '../core/buy.js';
import { TtlCache } from '../core/cache.js';
import { ledgerToCsv } from '../core/csv.js';
import { LINKS, LISTA_MOOLAH, VENUS_KNOWN_VTOKENS } from '../core/registry.js';
import { buildPreview } from '../core/preview.js';
import { FallbackTransport } from '../core/rpc.js';
import { getFeed, scanAddress, type ShaddaiContext } from '../core/scan.js';
import { TradeApiError } from '../core/trade-api.js';
import type { ScanResult } from '../core/types.js';
import { DEMO_ADDRESS } from '../fixtures/demo.js';
import { createMcpServer, type McpDeps } from '../mcp/server.js';

export interface AppDeps {
  mode: 'live' | 'demo';
  live: () => ShaddaiContext;
  demo: () => ShaddaiContext;
  quoteBuy?: McpDeps['quoteBuy'];
}

const LIVE_EXAMPLES = [
  {
    label: 'Venus vNVDAB market (holds NVDAB)',
    address: VENUS_KNOWN_VTOKENS.find((v) => v.symbol === 'vNVDAB')!.vToken,
  },
  { label: 'Lista Moolah (holds bStock collateral)', address: LISTA_MOOLAH },
];

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const scans = new TtlCache<ScanResult>(15_000);

  const pick = (address: string, demoFlag?: string) => {
    const isDemo = deps.mode === 'demo' || demoFlag === '1' || address.toLowerCase() === DEMO_ADDRESS.toLowerCase();
    return isDemo ? deps.demo() : deps.live();
  };

  const parseAddress = (raw: string | undefined) => {
    const s = (raw ?? '').trim();
    if (s.toLowerCase() === 'demo') return DEMO_ADDRESS;
    if (!isAddress(s, { strict: false })) return null;
    return getAddress(s.toLowerCase());
  };

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/config', (c) =>
    c.json({
      mode: deps.mode,
      demoAddress: DEMO_ADDRESS,
      examples: deps.mode === 'demo' ? [] : LIVE_EXAMPLES,
      links: {
        bep677: LINKS.bep677,
        erc8056: LINKS.erc8056,
        bstocks: LINKS.bstocks,
        bstocksProof: LINKS.bstocksProof,
        ondo: LINKS.ondo,
        xstocks: LINKS.xstocks,
        venus: LINKS.venus,
        lista: LINKS.lista,
      },
    }),
  );

  app.get('/api/scan', async (c) => {
    const address = parseAddress(c.req.query('address'));
    if (!address) return c.json({ error: 'Not a BSC address. Paste a 0x… address (40 hex characters).' }, 400);
    const ctx = pick(address, c.req.query('demo'));
    const key = `${ctx.mode}:${address}`;
    try {
      let result = await scans.get(key, () => scanAddress(ctx, address));
      // A cached "indexing" ledger is re-asked so polling clients see progress.
      if (result.ledger.status === 'indexing' && c.req.query('poll') === '1') {
        result = await scanAddress(ctx, address);
      }
      return c.json(result);
    } catch (e) {
      return c.json({ error: `Scan failed: ${(e as Error).message}` }, 502);
    }
  });

  app.get('/api/preview', async (c) => {
    const address = parseAddress(c.req.query('address'));
    if (!address) return c.json({ error: 'Not a BSC address. Paste a 0x… address (40 hex characters).' }, 400);
    const ctx = pick(address, c.req.query('demo'));
    try {
      const result = await scans.get(`${ctx.mode}:${address}`, () => scanAddress(ctx, address));
      return c.json(await buildPreview(ctx, result));
    } catch (e) {
      return c.json({ error: `Preview failed: ${(e as Error).message}` }, 502);
    }
  });

  app.get('/api/ledger.csv', async (c) => {
    const address = parseAddress(c.req.query('address'));
    if (!address) return c.text('invalid address', 400);
    const ctx = pick(address, c.req.query('demo'));
    try {
      const result = await scanAddress(ctx, address, { ledgerBudgetMs: 120_000 });
      if (result.ledger.status !== 'ready') {
        return c.text(`Ledger not ready: ${result.ledger.error ?? result.ledger.status}`, 503);
      }
      const csv = ledgerToCsv(result.ledger.rows, { demo: result.mode === 'demo' });
      const date = new Date().toISOString().slice(0, 10);
      c.header('content-type', 'text/csv; charset=utf-8');
      c.header('content-disposition', `attachment; filename="shaddai-ledger-${address.slice(0, 10)}-${date}.csv"`);
      return c.body(csv);
    } catch (e) {
      return c.text(`CSV export failed: ${(e as Error).message}`, 502);
    }
  });

  app.get('/api/feed', async (c) => {
    const ctx = c.req.query('demo') === '1' || deps.mode === 'demo' ? deps.demo() : deps.live();
    try {
      return c.json(await getFeed(ctx));
    } catch (e) {
      return c.json({ error: `Feed failed: ${(e as Error).message}` }, 502);
    }
  });

  app.get('/api/status', async (c) => {
    const ctx = deps.mode === 'demo' ? deps.demo() : deps.live();
    // A fresh serverless instance has not read its index yet; load it so the
    // answer reflects the deploy-time snapshot rather than an empty process.
    await ctx.feed.loadPersisted().catch(() => undefined);
    const snap = ctx.feed.snapshot();
    const loaded = snap.scannedTo !== undefined;
    const rpc = ctx.chain.rpc instanceof FallbackTransport ? ctx.chain.rpc.health : [];
    return c.json({
      mode: ctx.mode,
      config: ctx.diagnostics ?? {},
      feed: {
        status: loaded ? snap.status : ctx.feed.running ? 'indexing' : 'not started',
        running: ctx.feed.running,
        progress: snap.progress,
        error: snap.error,
        scannedFrom: snap.scannedFrom?.toString(),
        scannedTo: snap.scannedTo?.toString(),
        events: snap.decoded.length,
      },
      rpc,
      stats: ctx.chain.stats,
    });
  });

  // ---- Share-true Buy. Quotes and order building run here; signing happens in the user's wallet.
  const buyCtx = (demoFlag?: string) => (deps.mode === 'demo' || demoFlag === '1' ? deps.demo() : deps.live());
  const buyFail = (e: unknown) => {
    if (e instanceof BuyError) return { status: e.status, error: e.message };
    if (e instanceof TradeApiError) return { status: 502 as const, error: e.message };
    return { status: 500 as const, error: `Buy failed: ${(e as Error).message}` };
  };
  const payInOf = (v: unknown): PayInSymbol | undefined =>
    PAY_IN_SYMBOLS.includes(v as PayInSymbol) ? (v as PayInSymbol) : undefined;

  app.get('/api/buy/config', (c) => {
    const ctx = buyCtx(c.req.query('demo'));
    const tickers = new Map<
      string,
      { ticker: string; name: string; wrappers: { symbol: string; issuer: string; address: string }[] }
    >();
    for (const t of ctx.tokens) {
      if (t.demoOnly && ctx.mode !== 'demo') continue;
      const e = tickers.get(t.ticker) ?? { ticker: t.ticker, name: t.name, wrappers: [] };
      e.wrappers.push({ symbol: t.symbol, issuer: t.issuer, address: t.address });
      tickers.set(t.ticker, e);
    }
    return c.json({
      mode: ctx.mode,
      enabled: Boolean(ctx.buy),
      api: ctx.buy?.api.label ?? null,
      limits: ctx.buy
        ? { maxUsd: ctx.buy.maxUsd, maxImpactPct: ctx.buy.maxImpactPct, slippagePct: ctx.buy.slippagePct }
        : null,
      payIn: PAY_IN_SYMBOLS,
      tickers: [...tickers.values()].sort((a, b) => a.ticker.localeCompare(b.ticker)),
    });
  });

  app.get('/api/buy/diagnose', async (c) => {
    try {
      return c.json(await diagnoseBuy(buyCtx(c.req.query('demo')), process.env.VERCEL_REGION ?? null));
    } catch (e) {
      const f = buyFail(e);
      return c.json({ error: f.error }, f.status);
    }
  });

  app.get('/api/buy/quote', async (c) => {
    try {
      const q = await quoteShareTrueBuy(buyCtx(c.req.query('demo')), {
        ticker: c.req.query('ticker') ?? '',
        usd: c.req.query('usd') ?? '',
        payIn: payInOf(c.req.query('payIn')),
        wallet: c.req.query('wallet') || null,
      });
      return c.json(q);
    } catch (e) {
      const f = buyFail(e);
      return c.json({ error: f.error }, f.status);
    }
  });

  app.post('/api/buy/prepare', async (c) => {
    try {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const r = await prepareBuy(buyCtx(c.req.query('demo')), {
        token: String(b.token ?? ''),
        usd: b.usd as number,
        payIn: payInOf(b.payIn),
        wallet: String(b.wallet ?? ''),
        demoSkipAllowance: b.demoSkipAllowance === true,
      });
      return c.json(r);
    } catch (e) {
      const f = buyFail(e);
      return c.json({ error: f.error }, f.status);
    }
  });

  app.post('/api/buy/submit', async (c) => {
    try {
      const b = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const r = await submitBuy(buyCtx(c.req.query('demo')), {
        requestId: String(b.requestId ?? ''),
        signature: String(b.signature ?? ''),
        vendor: String(b.vendor ?? ''),
        quoteId: String(b.quoteId ?? ''),
        signingScheme: typeof b.signingScheme === 'string' ? b.signingScheme : null,
      });
      return c.json(r);
    } catch (e) {
      const f = buyFail(e);
      return c.json({ error: f.error }, f.status);
    }
  });

  app.get('/api/buy/order/:id', async (c) => {
    try {
      return c.json(await buyOrderStatus(buyCtx(c.req.query('demo')), c.req.param('id')));
    } catch (e) {
      const f = buyFail(e);
      return c.json({ error: f.error }, f.status);
    }
  });

  // MCP over Streamable HTTP, stateless: a fresh server per request, JSON replies.
  app.post('/api/mcp', async (c) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const server = createMcpServer(deps);
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      void server.close();
    }
  });
  app.on(['GET', 'DELETE'], '/api/mcp', (c) =>
    c.json(
      { jsonrpc: '2.0', error: { code: -32000, message: 'Stateless server: POST JSON-RPC only.' }, id: null },
      405,
    ),
  );

  return app;
}
