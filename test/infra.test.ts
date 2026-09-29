import { getAddress, isAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { oracleCheck, severityFor, sharesToAssetsDown, sharesToAssetsUp } from '../src/core/collateral.js';
import { ListaApiSource } from '../src/core/lista.js';
import { pickMarks } from '../src/core/prices.js';
import type { TokenProbe } from '../src/core/probe.js';
import { MAINNET_TOKENS, parseExtraTokens } from '../src/core/registry.js';
import {
  CallRevertedError,
  classifyRpcError,
  FallbackTransport,
  RpcError,
  StateUnavailableError,
  type RpcTransport,
} from '../src/core/rpc.js';
import { DEMO_ADDRESS } from '../src/fixtures/demo.js';
import { createApp } from '../src/server/app.js';
import { demoContext } from '../src/server/context.js';
import { u } from './helpers.js';

const fake = (label: string, impl: (method: string) => unknown): RpcTransport & { hits: number } => {
  const t = {
    label,
    hits: 0,
    async request<T>(method: string): Promise<T> {
      t.hits++;
      const r = impl(method);
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return t;
};

describe('RPC failover', () => {
  it('classifies node errors', () => {
    expect(classifyRpcError({ code: 3, message: 'execution reverted' })).toBeInstanceOf(CallRevertedError);
    expect(classifyRpcError({ code: -32000, message: 'missing trie node abc' })).toBeInstanceOf(StateUnavailableError);
    expect(classifyRpcError({ code: -32005, message: 'limit exceeded' })).toBeInstanceOf(RpcError);
  });

  it('moves to the next endpoint on transport errors', async () => {
    const a = fake('a', () => new RpcError('HTTP 429'));
    const b = fake('b', () => '0x10');
    const t = new FallbackTransport([a, b], { retries: 0 });
    expect(await t.request('eth_blockNumber', [])).toBe('0x10');
    expect(t.health[0]!.failed).toBe(1);
  });

  it('does not retry a revert elsewhere', async () => {
    const a = fake('a', () => new CallRevertedError('execution reverted'));
    const b = fake('b', () => '0x');
    const t = new FallbackTransport([a, b], { retries: 0 });
    await expect(t.request('eth_call', [])).rejects.toBeInstanceOf(CallRevertedError);
    expect(b.hits).toBe(0);
  });

  it('tries an archive endpoint after a pruned one', async () => {
    const a = fake('pruned', () => new StateUnavailableError('missing trie node'));
    const b = fake('archive', () => '0x01');
    const t = new FallbackTransport([a, b], { retries: 0 });
    expect(await t.request('eth_call', [])).toBe('0x01');
  });
});

describe('DexScreener mark selection', () => {
  const T = getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436');
  const pair = (addr: string, base: string, quote: string, priceUsd: string, priceNative: string, liq: number) => ({
    chainId: 'bsc',
    dexId: 'pancakeswap',
    pairAddress: addr,
    baseToken: { address: base, symbol: 'B' },
    quoteToken: { address: quote, symbol: 'Q' },
    priceUsd,
    priceNative,
    liquidity: { usd: liq },
  });
  const USDT = '0x55d398326f99059fF775485246999027B3197955';

  it('picks the deepest pool and prices the token when it is the quote side', () => {
    const { marks } = pickMarks(
      [T],
      [
        pair('0x0000000000000000000000000000000000000001', T, USDT, '230', '230', 5_000),
        // token is quote: base (USDT) = $1, priceNative = 0.004 NVDAB per USDT => NVDAB = $250
        pair('0x0000000000000000000000000000000000000002', USDT, T, '1', '0.004', 900_000),
      ],
    );
    expect(marks.get(T)!.rawUsd).toBeCloseTo(250, 9);
    expect(marks.get(T)!.thin).toBe(false);
  });
});

describe('registry', () => {
  it('has unique, valid addresses', () => {
    const set = new Set(MAINNET_TOKENS.map((t) => t.address.toLowerCase()));
    expect(set.size).toBe(MAINNET_TOKENS.length);
    for (const t of MAINNET_TOKENS) expect(isAddress(t.address, { strict: true })).toBe(true);
  });
  it('normalises the AMDB address whose source casing failed EIP-55', () => {
    expect(isAddress('0x75Fd4cF6f8392e41E70391d60C90c0d5211603a1', { strict: true })).toBe(false);
    expect(MAINNET_TOKENS.find((t) => t.symbol === 'AMDB')!.address).toBe('0x75Fd4cF6f8392E41E70391D60c90C0D5211603a1');
  });
  it('parses extra tokens and rejects bad ones', () => {
    const [x] = parseExtraTokens([
      { symbol: 'NVDAx', ticker: 'NVDA', issuer: 'xStocks', address: '0x000000000000000000000000000000000000aaaa' },
    ]);
    expect(x).toMatchObject({ model: 'xstocks', needsVerification: true });
    expect(() => parseExtraTokens([{ symbol: 'X', ticker: 'X', issuer: 'Nope', address: '0x' }])).toThrow();
  });
});

describe('collateral severity', () => {
  const probe = (mult: string, pending?: { m: string; kind: 'split' | 'dividend-reinvest' }): TokenProbe =>
    ({
      mult: u(mult),
      pendingMult: pending ? u(pending.m) : null,
      unit: {
        kind: 'bep677',
        pending: pending ? { multiplier: pending.m, effectiveAt: 1_790_000_000, kind: pending.kind, ratio: '0' } : null,
        ondo: null,
      },
    }) as unknown as TokenProbe;

  it('info when the multiplier is near 1 and nothing is pending', () => {
    expect(severityFor(probe('1.0017')).severity).toBe('info');
  });
  it('watch when a small update is scheduled', () => {
    expect(severityFor(probe('1.0017', { m: '1.0031', kind: 'dividend-reinvest' })).severity).toBe('watch');
  });
  it('alert when a split-sized change is scheduled or already applied', () => {
    expect(severityFor(probe('1.0017', { m: '2.0034', kind: 'split' })).severity).toBe('alert');
    expect(severityFor(probe('2.008')).severity).toBe('alert');
  });
  it('detects a per-share oracle once the multiplier is far from 1', () => {
    const mark = { rawUsd: 100, dex: 'x', pair: DEMO_ADDRESS as Address, liquidityUsd: 1e6, thin: false };
    expect(oracleCheck(50.2, mark, u('2')).basis).toBe('share');
    expect(oracleCheck(99.5, mark, u('2')).basis).toBe('raw');
    expect(oracleCheck(100, mark, u('1.001')).basis).toBe('indistinguishable');
  });
});

describe('Lista (Moolah) reads', () => {
  it('converts Morpho-style shares with virtual shares and assets', () => {
    // Fresh market: 1e6 shares per asset unit.
    expect(sharesToAssetsDown(u('2') * 10n ** 6n, u('100'), u('100') * 10n ** 6n)).toBe(u('2'));
    // After interest the exchange rate moves; down rounds against the lender, up against the borrower.
    const down = sharesToAssetsDown(10n ** 6n + 1n, 3n, 2n * 10n ** 6n);
    const up = sharesToAssetsUp(10n ** 6n + 1n, 3n, 2n * 10n ** 6n);
    expect(up - down).toBe(1n);
  });

  it('proposes markets where a registry token is the loan asset as well as the collateral', async () => {
    const id = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;
    const fetchImpl = (async (url: string) => {
      const body = url.includes('/borrow/markets')
        ? {
            code: '000000000',
            data: {
              total: 3,
              list: [
                { id: id(1), collateral: 'NVDAB', loan: 'USDT' },
                { id: id(2), collateral: 'USDT', loan: 'NVDAB' },
                { id: id(3), collateral: 'USDT', loan: 'USD1' },
              ],
            },
          }
        : {
            code: '000000000',
            data: { objs: [{ marketId: id(4), loanToken: MAINNET_TOKENS[0]!.address, collateralToken: '0x' }] },
          };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const ids = await new ListaApiSource('https://api.example', fetchImpl).candidateMarkets(
      MAINNET_TOKENS,
      DEMO_ADDRESS,
    );
    expect(ids.sort()).toEqual([id(1), id(2), id(4)]);
  });
});

describe('HTTP API', () => {
  const NOW = Date.UTC(2026, 8, 29, 16) / 1000;
  const ctx = demoContext(NOW);
  const app = createApp({ mode: 'live', live: () => ctx, demo: () => ctx });

  it('rejects a malformed address', async () => {
    const res = await app.request('/api/scan?address=0x123');
    expect(res.status).toBe(400);
  });
  it('scans the demo address', async () => {
    const res = await app.request('/api/scan?address=demo');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; portfolio: { rows: unknown[] } };
    expect(body.mode).toBe('demo');
    expect(body.portfolio.rows.length).toBeGreaterThan(5);
  });
  it('downloads the ledger as CSV', async () => {
    const res = await app.request(`/api/ledger.csv?address=${DEMO_ADDRESS}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename="shaddai-ledger-/);
    expect((await res.text()).split('\r\n')[0]).toBe(
      'date,block,issuer,symbol,contract,raw_at_event,old_mult,new_mult,delta_share_eq,est_usd,note',
    );
  });
  it('serves the feed', async () => {
    const res = await app.request('/api/feed?demo=1');
    expect(res.status).toBe(200);
  });
});
