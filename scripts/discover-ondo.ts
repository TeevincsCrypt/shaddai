/**
 * Look for Ondo's SyntheticSharesOracle on BSC and print what was found.
 *   npm run discover:ondo            # last ~10 days of blocks
 *   npm run discover:ondo -- 6000000 # custom lookback in blocks
 */
import { discoverOndoOracle, ONDO_ORACLE_SEARCH_HINTS } from '../src/core/ondo-discovery.js';
import { MemoryKV } from '../src/core/cache.js';
import { createLiveContext, loadConfig } from '../src/server/context.js';

async function main() {
  const ctx = createLiveContext(loadConfig(), new MemoryKV());
  const head = await ctx.chain.blockNumber();
  const lookback = process.argv[2] ? BigInt(process.argv[2]) : undefined;
  const d = await discoverOndoOracle(
    ctx.chain,
    ctx.tokens.filter((t) => t.model === 'ondo'),
    head,
    { lookbackBlocks: lookback, budgetMs: 600_000, hints: ONDO_ORACLE_SEARCH_HINTS, log: console.log },
  );
  console.log(JSON.stringify(d, null, 2));
  if (d.found) console.log(`\nSet ONDO_SSO_ADDRESS=${d.found} (or redeploy: the build adopts it automatically).`);
}

main().catch((e: Error) => {
  console.error(`discovery failed: ${e.message}`);
  process.exitCode = 1;
});
