import { Hono } from 'hono';
import { getAddress, isAddress } from 'viem';
import { TtlCache } from '../core/cache.js';
import { ledgerToCsv } from '../core/csv.js';
import { LINKS, LISTA_MOOLAH, VENUS_KNOWN_VTOKENS } from '../core/registry.js';
import { FallbackTransport } from '../core/rpc.js';
import { getFeed, scanAddress, type ShaddaiContext } from '../core/scan.js';
import type { ScanResult } from '../core/types.js';
import { DEMO_ADDRESS } from '../fixtures/demo.js';

export interface AppDeps {
  mode: 'live' | 'demo';
  live: () => ShaddaiContext;
  demo: () => ShaddaiContext;
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

  app.get('/api/status', (c) => {
    const ctx = deps.mode === 'demo' ? deps.demo() : deps.live();
    const snap = ctx.feed.snapshot();
    const rpc = ctx.chain.rpc instanceof FallbackTransport ? ctx.chain.rpc.health : [];
    return c.json({
      mode: ctx.mode,
      feed: {
        status: snap.status,
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

  return app;
}
