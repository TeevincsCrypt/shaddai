import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileKV } from '../core/cache.js';
import type { ShaddaiContext } from '../core/scan.js';
import { createLiveContext, type AppConfig } from './context.js';

export interface SnapshotOptions {
  budgetMs?: number;
  step?: bigint;
  log?: (line: string) => void;
  /** Override pieces of the live context (tests). */
  tweak?: (ctx: ShaddaiContext) => void;
}

/**
 * Deploy-time snapshot of the multiplier-event index, written to cfg.seedDir.
 * Walks forward in steps so every finished step is saved even if the time
 * budget runs out; the server indexes whatever is left at runtime.
 */
export async function buildSnapshot(cfg: AppConfig, opts: SnapshotOptions = {}) {
  const log = opts.log ?? console.log;
  const budget = opts.budgetMs ?? 240_000;
  const step = opts.step ?? 2_000_000n;
  const started = Date.now();
  // The directory always exists so the deploy's includeFiles glob has a target,
  // even when RPC is unreachable and no snapshot gets written.
  mkdirSync(cfg.seedDir, { recursive: true });
  writeFileSync(
    join(cfg.seedDir, 'README.txt'),
    'Deploy-time multiplier-event index. Written by npm run index:snapshot.\n',
  );
  const ctx = createLiveContext(cfg, new FileKV(cfg.seedDir));
  opts.tweak?.(ctx);
  const head = await ctx.chain.blockNumber();
  log(`index snapshot: head ${head}, writing to ${cfg.seedDir}`);
  let complete = false;
  for (;;) {
    const next = await ctx.feed.nextBlock();
    if (next > head) {
      complete = true;
      break;
    }
    const target = next + step - 1n < head ? next + step - 1n : head;
    const hdr = await ctx.chain.getBlock(target);
    await ctx.feed.refresh({ number: target, timestamp: hdr.timestamp });
    const s = ctx.feed.snapshot();
    const secs = Math.round((Date.now() - started) / 1000);
    log(`index snapshot: blocks ${s.scannedFrom}–${s.scannedTo}, ${s.decoded.length} events (${secs}s)`);
    if (target >= head) {
      complete = true;
      break;
    }
    if (Date.now() - started > budget) {
      log('index snapshot: time budget reached; the server indexes the remaining blocks at runtime.');
      break;
    }
  }
  const s = ctx.feed.snapshot();
  return { complete, scannedTo: s.scannedTo, events: s.decoded.length };
}
