/**
 * Deploy-time snapshot of the multiplier-event index (runs in the Vercel build).
 * Never fails the build: if RPC is unreachable it says why and exits 0, and the
 * server builds the index at runtime instead.
 */
import { loadConfig } from '../src/server/context.js';
import { buildSnapshot } from '../src/server/snapshot.js';

const cfg = loadConfig();
if (cfg.mode === 'demo') {
  console.log('index snapshot: SHADDAI_MODE=demo, nothing to index.');
} else {
  buildSnapshot(cfg, { budgetMs: Number(process.env.SHADDAI_SNAPSHOT_BUDGET_MS ?? 240_000) }).catch((e: Error) => {
    console.warn(`index snapshot skipped: ${e.message}`);
  });
}
