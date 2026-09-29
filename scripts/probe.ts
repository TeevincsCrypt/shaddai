/**
 * Live smoke test against BSC mainnet, no server needed.
 *
 *   npm run probe                 # registry health + time-to-first-uiMultiplier
 *   npm run probe -- 0xYourAddr   # full scan of one address
 *   npm run probe -- demo         # same, on the demo fixture chain
 */
import { scanAddress } from '../src/core/scan.js';
import { probeTokens } from '../src/core/probe.js';
import { scaledUiAbi } from '../src/core/abi.js';
import { DEMO_ADDRESS } from '../src/fixtures/demo.js';
import { createLiveContext, demoContext, loadConfig } from '../src/server/context.js';
import { MemoryKV } from '../src/core/cache.js';

const arg = process.argv[2];
const cfg = loadConfig();
const ctx = arg === 'demo' || cfg.mode === 'demo' ? demoContext() : createLiveContext(cfg, new MemoryKV());
const t0 = performance.now();
const ms = () => `${Math.round(performance.now() - t0)}ms`;

const first = ctx.tokens[0]!;
try {
  const m = await ctx.chain.read<bigint>({ to: first.address, abi: scaledUiAbi, functionName: 'uiMultiplier' });
  console.log(`time-to-first-uiMultiplier: ${ms()} (${first.symbol} = ${m})`);
} catch (e) {
  console.log(`first uiMultiplier() on ${first.symbol} failed after ${ms()}: ${(e as Error).message}`);
}

async function main() {
if (!arg) {
  const head = await ctx.chain.blockNumber();
  const hdr = await ctx.chain.getBlock(head);
  const probes = await probeTokens(ctx.chain, ctx.tokens, null, head, hdr.timestamp, { ondoOracle: ctx.ondoOracle });
  console.log(`registry probe at block ${head} (${ms()})`);
  for (const p of probes.values()) {
    const u = p.unit;
    console.log(
      [
        p.token.symbol.padEnd(8),
        (u.onChainSymbol ?? '—').padEnd(8),
        u.kind.padEnd(12),
        (u.multiplier ?? '—').padEnd(12),
        u.pending ? `pending ${u.pending.multiplier} @ ${new Date(u.pending.effectiveAt * 1000).toISOString()}` : '',
        u.notes.join(' | '),
      ].join(' '),
    );
  }
} else {
  const address = arg === 'demo' ? DEMO_ADDRESS : arg;
  const r = await scanAddress(ctx, address, { ledgerBudgetMs: 300_000 });
  console.log(`scan of ${r.address} at block ${r.block} took ${ms()}`);
  for (const c of r.checks) console.log(`  [${c.status}] ${c.name}: ${c.detail}`);
  for (const w of r.warnings) console.log(`  warning: ${w}`);
  for (const row of r.portfolio.rows) {
    console.log(`  ${row.token.symbol.padEnd(8)} ${row.location.label.padEnd(32)} raw ${row.raw.padEnd(14)} share-eq ${row.shareEq}`);
  }
  for (const l of r.ledger.rows) {
    console.log(`  ledger ${l.token.symbol} ${l.kind} ${l.status} ${l.oldMultiplier}→${l.newMultiplier} raw@event ${l.rawAtEvent} (${l.rawAtEventSource}) Δ ${l.deltaShareEq}`);
  }
  for (const p of r.collateral.positions) console.log(`  [${p.severity}] ${p.lines.join(' ')}`);
}
console.log('rpc stats', ctx.chain.stats);
}

main().catch((e: Error) => {
  console.error(`probe failed after ${ms()}: ${e.message}`);
  process.exitCode = 1;
});
