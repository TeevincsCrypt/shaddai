import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ShaddaiContext } from '../core/scan.js';
import { createApp } from './app.js';
import { createLiveContext, demoContext, loadConfig } from './context.js';

// `--demo` instead of SHADDAI_MODE=demo so the same command works on Windows.
const cfg = loadConfig(process.argv.includes('--demo') ? { ...process.env, SHADDAI_MODE: 'demo' } : process.env);
let live: ShaddaiContext | null = null;
const getLive = () => (live ??= createLiveContext(cfg));

const app = createApp({ mode: cfg.mode, live: getLive, demo: () => demoContext() });

const webRoot = resolve('dist/web');
if (existsSync(webRoot)) {
  app.use('/*', serveStatic({ root: 'dist/web' }));
  const index = readFileSync(resolve(webRoot, 'index.html'), 'utf8');
  app.get('*', (c) => (c.req.path.startsWith('/api/') ? c.notFound() : c.html(index)));
} else {
  app.get('/', (c) => c.text('Shaddai API is running. Build the web app with `npm run build`, or use `npm run dev`.'));
}

serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`Shaddai (${cfg.mode}) listening on http://localhost:${info.port}`);
  if (cfg.mode === 'live') {
    // Warm the multiplier index so the first ledger request is not a cold scan.
    const ctx = getLive();
    ctx.chain
      .blockNumber()
      .then(async (n) => ctx.feed.refresh({ number: n, timestamp: (await ctx.chain.getBlock(n)).timestamp }))
      .then(() => console.log('Multiplier index ready.'))
      .catch((e: Error) => console.warn(`Multiplier index warm-up failed: ${e.message}`));
  }
});
