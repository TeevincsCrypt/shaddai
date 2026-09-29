import { getAddress, type Address, type Hex } from 'viem';
import type { RawAtOptions } from './balances.js';
import { TtlCache } from './cache.js';
import type { Chain } from './chain.js';
import { scanCollateral } from './collateral.js';
import type { FeedIndexer } from './events.js';
import { tokenRef } from './events.js';
import { buildLedger } from './ledger.js';
import type { ListaMarketSource } from './lista.js';
import { buildPortfolio, toPrice } from './portfolio.js';
import type { MarkQuote, PoolRef, PriceSource } from './prices.js';
import { probeTokens, type TokenProbe } from './probe.js';
import type { TokenInfo } from './registry.js';
import type { CheckStatus, FeedResult, LedgerSection, Price, ScanResult, UnitModel } from './types.js';

export interface ShaddaiContext {
  mode: 'live' | 'demo';
  chain: Chain;
  tokens: TokenInfo[];
  prices: PriceSource;
  venus: { comptroller: Address; known: { underlying: Address; vToken: Address; symbol: string }[] } | null;
  lista: { moolah: Address; source: ListaMarketSource | null; extraMarketIds: Hex[] } | null;
  ondoOracle: Address | null;
  feed: FeedIndexer;
  rawAt?: RawAtOptions;
  /** How long a scan waits for the ledger before answering with status "indexing". */
  ledgerBudgetMs: number;
  /**
   * Keeps unfinished work alive after the response is sent. Serverless hosts
   * freeze a function once it responds unless told otherwise (Vercel: waitUntil).
   */
  background?: (work: Promise<unknown>) => void;
  /** Deployment facts for /api/status. Never holds URLs or keys. */
  diagnostics?: Record<string, string | boolean | null>;
}

const ledgerJobs = new WeakMap<ShaddaiContext, TtlCache<LedgerSection>>();

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => setTimeout(() => r(TIMEOUT), ms))]);
}
const TIMEOUT = Symbol('timeout');

function unitsRecord(probes: Map<Address, TokenProbe>): Record<string, UnitModel> {
  return Object.fromEntries([...probes].map(([a, p]) => [a, p.unit]));
}

export async function scanAddress(
  ctx: ShaddaiContext,
  input: string,
  opts: { ledgerBudgetMs?: number } = {},
): Promise<ScanResult> {
  const address = getAddress(input);
  const { chain, tokens } = ctx;
  const checks: CheckStatus[] = [];
  const warnings: string[] = [];

  const headNumber = await chain.blockNumber();
  const header = await chain.getBlock(headNumber);
  const head = { number: headNumber, timestamp: header.timestamp };

  const probes = await probeTokens(chain, tokens, address, headNumber, head.timestamp, { ondoOracle: ctx.ondoOracle });
  checks.push({ name: 'RPC', status: 'ok', detail: `${chain.rpc.label} at block ${headNumber}.` });

  let marks = new Map<Address, MarkQuote>();
  let pools = new Map<Address, PoolRef[]>();
  try {
    const q = await ctx.prices.quote(tokens.map((t) => t.address));
    marks = q.marks;
    pools = q.pools;
    checks.push({
      name: 'Prices',
      status: 'ok',
      detail: `${ctx.prices.label}: ${marks.size}/${tokens.length} tokens have a DEX mark.`,
    });
  } catch (e) {
    checks.push({ name: 'Prices', status: 'unavailable', detail: `${ctx.prices.label}: ${(e as Error).message}` });
  }
  const priceSource: Price['source'] = ctx.mode === 'demo' ? 'fixture' : 'dexscreener';
  const prices = new Map<Address, Price>();
  for (const t of tokens) {
    const p = toPrice(marks.get(t.address), probes.get(t.address)?.mult ?? null, priceSource);
    if (p) prices.set(t.address, p);
  }

  // Only look for LP positions in pools of tokens this address could plausibly be in.
  const collateral = await scanCollateral({
    chain,
    block: headNumber,
    headTimestamp: head.timestamp,
    holder: address,
    tokens,
    probes,
    marks,
    pools,
    venus: ctx.venus,
    lista: ctx.lista,
  });
  checks.push(...collateral.checks);

  const ondoTokens = tokens.filter((t) => t.model === 'ondo');
  if (ondoTokens.length) {
    const st = ondoTokens.map((t) => probes.get(t.address)?.unit.ondo?.status);
    checks.push({
      name: 'Ondo sValue',
      status: !ctx.ondoOracle
        ? 'skipped'
        : st.every((s) => s === 'ok')
          ? 'ok'
          : st.some((s) => s === 'ok')
            ? 'partial'
            : 'unavailable',
      detail: ctx.ondoOracle
        ? `SyntheticSharesOracle ${ctx.ondoOracle}: ${st.filter((s) => s === 'ok').length}/${ondoTokens.length} assets answered getSValue().`
        : 'ONDO_SSO_ADDRESS not configured; Ondo rows use the wallet multiplier if one exists, else 1:1.',
    });
  }

  for (const p of probes.values()) {
    if (p.unit.symbolMismatch) warnings.push(`${p.token.symbol}: on-chain symbol() is "${p.unit.onChainSymbol}".`);
    if (!p.readable) warnings.push(`${p.token.symbol}: no ERC-20 answered at ${p.token.address}.`);
  }

  const portfolio = buildPortfolio(probes, prices, collateral.positions);

  const exposure = new Map<Address, string[]>();
  for (const pos of collateral.positions) {
    if (pos.side === 'borrow') continue;
    const arr = exposure.get(pos.token.address) ?? [];
    arr.push(`${pos.protocol} (${pos.market.label})`);
    exposure.set(pos.token.address, arr);
  }

  let jobs = ledgerJobs.get(ctx);
  if (!jobs) {
    jobs = new TtlCache<LedgerSection>(60_000);
    ledgerJobs.set(ctx, jobs);
  }
  const job = jobs.get(address, async () => {
    let stale: string | undefined;
    try {
      await ctx.feed.refresh(head);
    } catch (e) {
      const snap = ctx.feed.snapshot();
      if (snap.scannedTo === undefined) {
        return { status: 'unavailable', rows: [], error: (e as Error).message } satisfies LedgerSection;
      }
      stale = `Multiplier index is stale (last block ${snap.scannedTo}): ${(e as Error).message}`;
    }
    const snap = ctx.feed.snapshot();
    const rows = await buildLedger({
      chain,
      holder: address,
      head,
      events: ctx.feed.timeline(head.timestamp),
      probes,
      prices,
      protocolExposure: exposure,
      rawAt: ctx.rawAt,
    });
    return {
      status: 'ready',
      rows,
      error: stale,
      scannedFrom: snap.scannedFrom?.toString(),
      scannedTo: snap.scannedTo?.toString(),
    } satisfies LedgerSection;
  });
  const settled = await withTimeout(job, opts.ledgerBudgetMs ?? ctx.ledgerBudgetMs).catch(
    (e: Error): LedgerSection => ({ status: 'unavailable', rows: [], error: e.message }),
  );
  let ledger: LedgerSection;
  if (settled === TIMEOUT) {
    ctx.background?.(job.catch(() => undefined));
    const snap = ctx.feed.snapshot();
    ledger = { status: 'indexing', rows: [], progress: snap.progress };
  } else ledger = settled;
  checks.push({
    name: 'Multiplier events',
    status: ledger.status === 'ready' ? 'ok' : ledger.status === 'indexing' ? 'partial' : 'unavailable',
    detail:
      ledger.status === 'ready'
        ? `UIMultiplierUpdated indexed for blocks ${ledger.scannedFrom}–${ledger.scannedTo}.`
        : ledger.status === 'indexing'
          ? `Indexing multiplier events (${Math.round((ledger.progress ?? 0) * 100)}%).`
          : (ledger.error ?? 'unavailable'),
  });

  return {
    mode: ctx.mode,
    address,
    block: headNumber.toString(),
    blockTime: head.timestamp,
    generatedAt: Math.floor(Date.now() / 1000),
    tokens: tokens.map(tokenRef),
    units: unitsRecord(probes),
    portfolio,
    ledger,
    collateral: { positions: collateral.positions, listings: collateral.listings },
    checks,
    warnings,
  };
}

export async function getFeed(ctx: ShaddaiContext, budgetMs = 5_000): Promise<FeedResult> {
  const { chain, tokens } = ctx;
  const headNumber = await chain.blockNumber();
  const header = await chain.getBlock(headNumber);
  const head = { number: headNumber, timestamp: header.timestamp };
  const probes = await probeTokens(chain, tokens, null, headNumber, head.timestamp, { ondoOracle: ctx.ondoOracle });
  const refresh = ctx.feed.refresh(head);
  const r = await withTimeout(refresh, budgetMs).catch((e: Error) => e);
  if (r === TIMEOUT) ctx.background?.(refresh.catch(() => undefined));
  const snap = ctx.feed.snapshot();
  return {
    mode: ctx.mode,
    status: r === TIMEOUT ? (snap.scannedTo === undefined ? 'indexing' : 'ready') : snap.status,
    progress: snap.progress,
    error: r instanceof Error ? r.message : snap.error,
    events: snap.scannedTo === undefined ? [] : ctx.feed.timeline(head.timestamp),
    scannedFrom: snap.scannedFrom?.toString(),
    scannedTo: snap.scannedTo?.toString(),
    units: unitsRecord(probes),
  };
}
