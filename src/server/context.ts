import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem';
import { FileKV, LayeredKV, MemoryKV, type KV } from '../core/cache.js';
import { Chain } from '../core/chain.js';
import { FeedIndexer } from '../core/events.js';
import { ListaApiSource, StaticListaSource } from '../core/lista.js';
import { DexScreenerSource, StaticPriceSource } from '../core/prices.js';
import {
  DEFAULT_RPC_URLS,
  LISTA_API_BASE,
  LISTA_MOOLAH,
  MAINNET_TOKENS,
  ONDO_SSO_KNOWN,
  parseExtraTokens,
  VENUS_COMPTROLLER,
  VENUS_KNOWN_VTOKENS,
  type TokenInfo,
} from '../core/registry.js';
import { FallbackTransport, httpTransport } from '../core/rpc.js';
import type { ShaddaiContext } from '../core/scan.js';
import {
  buildDemoScenario,
  DEMO_LISTA_MARKET_NVDAB,
  DEMO_LISTA_MARKET_NVDAB_BORROW,
  DEMO_LISTA_MARKET_NVDAB_LEND,
  DEMO_LISTA_MARKET_XMPLB,
  DEMO_ONDO_ORACLE,
  DEMO_TOKENS,
  demoMarks,
} from '../fixtures/demo.js';
import { FakeChain } from '../fixtures/fake-chain.js';

export interface AppConfig {
  port: number;
  mode: 'live' | 'demo';
  rpcUrls: string[];
  /** True when BSC_RPC_URLS was set, i.e. not the public defaults. */
  customRpc: boolean;
  logRpcUrls: string[];
  scanFromBlock: bigint | null;
  scanFromDate: string;
  logChunk: number;
  ondoOracle: Address | null;
  /** Where ondoOracle came from: the env var, or on-chain discovery at deploy time. */
  ondoOracleSource: 'env' | 'discovered' | 'registry' | null;
  listaMarketIds: Hex[];
  extraTokens: TokenInfo[];
  cacheDir: string;
  /** Read-only index snapshot built at deploy time (npm run index:snapshot). */
  seedDir: string;
  maxReplayLogs: number;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rpcUrls = list(env.BSC_RPC_URLS);
  const ondo = env.ONDO_SSO_ADDRESS?.trim();
  if (ondo && !isAddress(ondo, { strict: false })) throw new Error(`ONDO_SSO_ADDRESS is not an address: ${ondo}`);
  const ids = list(env.LISTA_MARKET_IDS);
  for (const id of ids)
    if (!isHex(id) || id.length !== 66) throw new Error(`LISTA_MARKET_IDS entry is not bytes32: ${id}`);
  // Either inline JSON (handy in a hosting dashboard) or a path to a JSON file.
  const extra = env.SHADDAI_EXTRA_TOKENS?.trim();
  const extraTokens = extra
    ? parseExtraTokens(JSON.parse(extra.startsWith('[') ? extra : readFileSync(extra, 'utf8')))
    : [];
  const seedDir = resolve(env.SHADDAI_SEED_DIR ?? 'dist/index-cache');
  const discovered = ondo ? null : readDiscoveredOracle(seedDir);
  return {
    port: Number(env.PORT ?? 8787),
    mode: env.SHADDAI_MODE === 'demo' ? 'demo' : 'live',
    rpcUrls: rpcUrls.length ? rpcUrls : DEFAULT_RPC_URLS,
    customRpc: rpcUrls.length > 0,
    logRpcUrls: list(env.BSC_LOGS_RPC_URLS),
    scanFromBlock: env.SHADDAI_SCAN_FROM_BLOCK ? BigInt(env.SHADDAI_SCAN_FROM_BLOCK) : null,
    scanFromDate: env.SHADDAI_SCAN_FROM_DATE ?? '2026-05-01',
    logChunk: Number(env.SHADDAI_LOG_CHUNK ?? 50_000),
    // Env var wins; then what this deploy's discovery verified; then the pinned mainnet address.
    ondoOracle: ondo ? getAddress(ondo.toLowerCase()) : (discovered ?? ONDO_SSO_KNOWN),
    ondoOracleSource: ondo ? 'env' : discovered ? 'discovered' : 'registry',
    listaMarketIds: ids as Hex[],
    extraTokens,
    // Serverless file systems are read-only except /tmp.
    cacheDir: env.SHADDAI_CACHE_DIR ?? (env.VERCEL ? '/tmp/shaddai-cache' : '.cache'),
    seedDir,
    maxReplayLogs: Number(env.SHADDAI_MAX_REPLAY_LOGS ?? 20_000),
  };
}

export const ONDO_DISCOVERY_FILE = 'ondo-oracle.json';

/** Oracle address found and verified by the deploy-time discovery, if any. */
function readDiscoveredOracle(seedDir: string): Address | null {
  try {
    const r = JSON.parse(readFileSync(join(seedDir, ONDO_DISCOVERY_FILE), 'utf8')) as { found?: string | null };
    return r.found && isAddress(r.found, { strict: false }) ? getAddress(r.found.toLowerCase()) : null;
  } catch {
    return null;
  }
}

function startBlockFor(chain: Chain, fromBlock: bigint | null, fromDate: string) {
  return async () => {
    if (fromBlock !== null) return fromBlock;
    const ts = Math.floor(Date.parse(`${fromDate}T00:00:00Z`) / 1000);
    if (!Number.isFinite(ts)) throw new Error(`SHADDAI_SCAN_FROM_DATE is not a date: ${fromDate}`);
    const head = await chain.blockNumber();
    return chain.blockAtOrAfter(ts, 1n, head);
  };
}

/** Writable cache first, then the deploy-time snapshot if one was built. */
export function defaultKV(cfg: AppConfig): KV {
  const writable = new FileKV(cfg.cacheDir);
  return existsSync(cfg.seedDir) ? new LayeredKV([writable, new FileKV(cfg.seedDir)]) : writable;
}

export function createLiveContext(
  cfg: AppConfig,
  kv: KV = defaultKV(cfg),
  background?: ShaddaiContext['background'],
): ShaddaiContext {
  const rpc = new FallbackTransport(cfg.rpcUrls.map((u) => httpTransport(u)));
  const logRpc = cfg.logRpcUrls.length
    ? new FallbackTransport(
        cfg.logRpcUrls.map((u) => httpTransport(u)),
        { concurrency: 4 },
      )
    : rpc;
  const chain = new Chain(rpc, { logRpc, logChunk: cfg.logChunk });
  const tokens = [...MAINNET_TOKENS, ...cfg.extraTokens];
  return {
    mode: 'live',
    chain,
    tokens,
    prices: new DexScreenerSource(),
    venus: { comptroller: VENUS_COMPTROLLER, known: VENUS_KNOWN_VTOKENS },
    lista: { moolah: LISTA_MOOLAH, source: new ListaApiSource(LISTA_API_BASE), extraMarketIds: cfg.listaMarketIds },
    ondoOracle: cfg.ondoOracle,
    feed: new FeedIndexer(chain, tokens, kv, startBlockFor(chain, cfg.scanFromBlock, cfg.scanFromDate), 'feed-bsc'),
    rawAt: { maxLogs: cfg.maxReplayLogs },
    ledgerBudgetMs: 12_000,
    background,
    diagnostics: {
      customRpc: cfg.customRpc,
      logRpc: cfg.logRpcUrls.length > 0,
      snapshotFile: existsSync(join(cfg.seedDir, 'feed-bsc.json')),
      ondoOracle: cfg.ondoOracleSource ?? 'none',
      extraTokens: String(cfg.extraTokens.length),
      scanStart: cfg.scanFromBlock !== null ? `block ${cfg.scanFromBlock}` : `date ${cfg.scanFromDate}`,
    },
  };
}

let demo: { day: number; ctx: ShaddaiContext } | null = null;

/**
 * The demo chain is rebuilt once per UTC day so its pending event stays in the
 * future. Passing `frozenAt` pins the fixture clock (tests) and skips the cache.
 */
export function demoContext(frozenAt?: number): ShaddaiContext {
  const nowSec = frozenAt ?? Math.floor(Date.now() / 1000);
  const day = Math.floor(nowSec / 86_400);
  if (frozenAt === undefined && demo && demo.day === day) return demo.ctx;
  const fake = new FakeChain(
    frozenAt === undefined ? buildDemoScenario(nowSec) : buildDemoScenario(nowSec, () => frozenAt),
  );
  const chain = new Chain(fake, { logChunk: 5_000_000, maxLogChunk: 5_000_000 });
  const { marks, pools } = demoMarks();
  const ctx: ShaddaiContext = {
    mode: 'demo',
    chain,
    tokens: DEMO_TOKENS,
    prices: new StaticPriceSource(marks, pools, 'Demo marks (fixture)'),
    venus: { comptroller: VENUS_COMPTROLLER, known: VENUS_KNOWN_VTOKENS },
    lista: {
      moolah: LISTA_MOOLAH,
      source: new StaticListaSource([
        DEMO_LISTA_MARKET_XMPLB,
        DEMO_LISTA_MARKET_NVDAB,
        DEMO_LISTA_MARKET_NVDAB_LEND,
        DEMO_LISTA_MARKET_NVDAB_BORROW,
      ]),
      extraMarketIds: [],
    },
    ondoOracle: DEMO_ONDO_ORACLE,
    feed: new FeedIndexer(
      chain,
      DEMO_TOKENS,
      new MemoryKV(),
      async () => fake.blockAt(Date.UTC(2026, 4, 1) / 1000),
      'feed-demo',
    ),
    ledgerBudgetMs: 15_000,
  };
  if (frozenAt === undefined) demo = { day, ctx };
  return ctx;
}
