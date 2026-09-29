import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileKV } from '../core/cache.js';
import { ONDO_SSO_KNOWN } from '../core/registry.js';
import { discoverOndoOracle, ONDO_ORACLE_SEARCH_HINTS } from '../core/ondo-discovery.js';
import type { ShaddaiContext } from '../core/scan.js';
import { createLiveContext, ONDO_DISCOVERY_FILE, type AppConfig } from './context.js';

export interface SnapshotOptions {
  budgetMs?: number;
  step?: bigint;
  /** Time for Ondo oracle discovery when ONDO_SSO_ADDRESS is unset (0 skips it). */
  ondoDiscoveryMs?: number;
  ondoLookbackBlocks?: bigint;
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

  // Ondo's oracle address is not published; look for it on-chain once per deploy.
  let ondoOracle: string | null = cfg.ondoOracle;
  const ondoTokens = ctx.tokens.filter((t) => t.model === 'ondo');
  const discoveryMs = opts.ondoDiscoveryMs ?? 90_000;
  // Runs unless the address was set by hand; the pinned address is checked first, so this is
  // one multicall while it keeps answering.
  if (cfg.ondoOracleSource !== 'env' && ondoTokens.length && discoveryMs > 0) {
    try {
      const d = await discoverOndoOracle(ctx.chain, ondoTokens, head, {
        budgetMs: discoveryMs,
        lookbackBlocks: opts.ondoLookbackBlocks,
        hints: [ONDO_SSO_KNOWN, ...ONDO_ORACLE_SEARCH_HINTS],
        log,
      });
      writeFileSync(join(cfg.seedDir, ONDO_DISCOVERY_FILE), JSON.stringify(d, null, 2));
      ondoOracle = d.found;
      log(
        d.found
          ? `ondo discovery: SyntheticSharesOracle ${d.found} answered getSValue() for ${d.answered}/${d.total} Ondo tokens; using it.`
          : `ondo discovery: not found (${d.notes.join(' ')})`,
      );
      for (const c of d.candidates.slice(0, 5)) {
        log(
          `ondo discovery: candidate ${c.address} (${c.source}) tokens seen ${c.tokensSeen}, getSValue answered ${c.answered}/${d.total}, topics ${c.eventTopics.join(',') || '-'}`,
        );
      }
    } catch (e) {
      log(`ondo discovery skipped: ${(e as Error).message}`);
    }
  }
  return { complete, scannedTo: s.scannedTo, events: s.decoded.length, ondoOracle };
}
