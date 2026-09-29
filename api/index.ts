/**
 * Vercel entry point: every /api/* request is rewritten here (see vercel.json)
 * and handled by the same Hono app `npm start` serves locally. The web app is
 * served by Vercel as static files from dist/web.
 */
import { handle } from '@hono/node-server/vercel';
import { waitUntil } from '@vercel/functions';
import type { ShaddaiContext } from '../src/core/scan.js';
import { createApp } from '../src/server/app.js';
import { createLiveContext, defaultKV, demoContext, loadConfig } from '../src/server/context.js';

const cfg = loadConfig();
let live: ShaddaiContext | null = null;

const app = createApp({
  mode: cfg.mode,
  // One context per warm instance; its in-memory index survives between requests.
  live: () => (live ??= createLiveContext(cfg, defaultKV(cfg), waitUntil)),
  demo: () => demoContext(),
});

export default handle(app);
