/**
 * Demo scenario. Every number here is illustrative and runs on the in-process
 * fixture chain, never on BSC. The UI and the CSV label it as a demo.
 *
 * It reuses real registry addresses so the same scan code runs unchanged, and
 * adds one fictional instrument (XMPLB, "Example Corp") for the split case so
 * no real ticker is shown with a made-up split.
 */
import { getAddress, parseUnits, type Address, type Hex } from 'viem';
import type { MarkQuote, PoolRef } from '../core/prices.js';
import type { DefiPosition, RwaToken } from '../core/trade-api.js';
import {
  BSTOCKS,
  LISTA_MOOLAH,
  MAINNET_TOKENS,
  ONDO,
  VENUS_COMPTROLLER,
  VENUS_KNOWN_VTOKENS,
  type TokenInfo,
} from '../core/registry.js';
import type { FakeScenario, FakeToken, FakeTransfer } from './fake-chain.js';

export const DEMO_ADDRESS: Address = getAddress('0xde30de30de30de30de30de30de30de30de30de30');

const ZERO: Address = '0x0000000000000000000000000000000000000000';
const COUNTERPARTY: Address = getAddress('0x1111111111111111111111111111111111111111');
const USDT: Address = getAddress('0x55d398326f99059fF775485246999027B3197955');
const XMPLB_ADDR: Address = getAddress('0xde30000000000000000000000000000000000001');
export const DEMO_ONDO_ORACLE: Address = getAddress('0xde30000000000000000000000000000000000002');
const VENUS_ORACLE: Address = getAddress('0xde30000000000000000000000000000000000003');
const AAPLB_USDT_PAIR: Address = getAddress('0xde30000000000000000000000000000000000004');
const VUSDT: Address = getAddress('0xfd5840cd36d94d7229439859c0112a4185bc0255');
/** Fixture-only RFQ spender for the demo Buy flow. */
export const DEMO_RFQ_SPENDER: Address = getAddress('0xde30000000000000000000000000000000000005');
export const DEMO_LISTA_MARKET_XMPLB: Hex = `0x${'de30'.repeat(15)}0001`;
export const DEMO_LISTA_MARKET_NVDAB: Hex = `0x${'de30'.repeat(15)}0002`;
/** NVDAB as the loan asset: the demo address lends in one market and borrows in another. */
export const DEMO_LISTA_MARKET_NVDAB_LEND: Hex = `0x${'de30'.repeat(15)}0003`;
export const DEMO_LISTA_MARKET_NVDAB_BORROW: Hex = `0x${'de30'.repeat(15)}0004`;

export const XMPLB: TokenInfo = {
  symbol: 'XMPLB',
  ticker: 'XMPL',
  name: 'Example Corp (demo only)',
  issuer: 'Demo',
  address: XMPLB_ADDR,
  model: 'bep677',
  demoOnly: true,
  note: 'Fictional instrument that exists only on the demo fixture chain.',
};

export const DEMO_TOKENS: TokenInfo[] = [...MAINNET_TOKENS, XMPLB];

const BASE_TS = Date.UTC(2026, 4, 15) / 1000;
const BASE_BLOCK = 60_000_000n;
const BLOCK_MS = 750;
const DAY = 86_400;

const d = (iso: string) => Date.parse(iso) / 1000;
const blockAt = (ts: number) => BASE_BLOCK + BigInt(Math.ceil(((ts - BASE_TS) * 1000) / BLOCK_MS));
const u = (v: string) => parseUnits(v, 18);

const bySymbol = (s: string) => {
  const t = DEMO_TOKENS.find((x) => x.symbol === s);
  if (!t) throw new Error(`demo: unknown ${s}`);
  return t.address;
};

/**
 * @param nowSec  anchors the rolling pending event (two days after this date).
 * @param clock   head follows this clock; pass a constant for deterministic tests.
 */
export function buildDemoScenario(
  nowSec: number = Math.floor(Date.now() / 1000),
  clock: () => number = () => Math.floor(Date.now() / 1000),
): FakeScenario {
  const dayStart = Math.floor(nowSec / DAY) * DAY;
  const vNVDAB = VENUS_KNOWN_VTOKENS.find((v) => v.symbol === 'vNVDAB')!.vToken;
  const vTSLAB = VENUS_KNOWN_VTOKENS.find((v) => v.symbol === 'vTSLAB')!.vToken;

  const flows: Record<string, [string, Address, Address, string][]> = {
    NVDAB: [
      ['2026-06-10T14:00:00Z', COUNTERPARTY, DEMO_ADDRESS, '22.4'],
      ['2026-06-25T09:30:00Z', DEMO_ADDRESS, vNVDAB, '12.4'],
    ],
    AAPLB: [
      ['2026-07-01T15:00:00Z', COUNTERPARTY, DEMO_ADDRESS, '15'],
      ['2026-07-02T10:00:00Z', DEMO_ADDRESS, AAPLB_USDT_PAIR, '5'],
    ],
    MSFTB: [['2026-07-20T16:00:00Z', COUNTERPARTY, DEMO_ADDRESS, '4']],
    TSLAB: [['2026-06-15T13:00:00Z', COUNTERPARTY, DEMO_ADDRESS, '2.5']],
    GOOGLB: [['2026-08-01T12:00:00Z', COUNTERPARTY, DEMO_ADDRESS, '0.0000004']],
    XMPLB: [
      ['2026-06-01T12:00:00Z', COUNTERPARTY, DEMO_ADDRESS, '40'],
      ['2026-06-05T12:00:00Z', DEMO_ADDRESS, LISTA_MOOLAH, '30'],
    ],
    NVDAon: [['2026-07-10T18:00:00Z', COUNTERPARTY, DEMO_ADDRESS, '5']],
  };

  const pendingEff = dayStart + 2 * DAY + 13.5 * 3600;
  const schedules: Record<string, [string | number, string, string | number][]> = {
    // [scheduled at, new multiplier, effective at]
    NVDAB: [
      ['2026-07-02T20:00:00Z', '1.00085', '2026-07-03T13:30:00Z'],
      ['2026-09-25T20:00:00Z', '1.0017', '2026-09-26T13:30:00Z'],
    ],
    AAPLB: [['2026-08-13T20:00:00Z', '1.000604', '2026-08-14T13:30:00Z']],
    GOOGLB: [['2026-09-14T20:00:00Z', '1.00084', '2026-09-15T13:30:00Z']],
    MUB: [['2026-07-21T20:00:00Z', '1.00115', '2026-07-22T13:30:00Z']],
    MSFTB: [
      // Scheduled, then overwritten with a corrected amount before it took effect.
      [dayStart - 2 * DAY + 10 * 3600, '1.0021', pendingEff],
      [dayStart - DAY + 10 * 3600, '1.00202', pendingEff],
    ],
    XMPLB: [
      ['2026-07-14T20:00:00Z', '1.004', '2026-07-15T13:30:00Z'],
      ['2026-08-28T20:00:00Z', '2.008', '2026-09-02T13:30:00Z'],
    ],
  };

  const ts = (v: string | number) => (typeof v === 'number' ? v : d(v));
  const tokens: FakeToken[] = [];
  const mk = (t: TokenInfo, bep677: boolean, deployIso: string): FakeToken => {
    const deployBlock = blockAt(d(deployIso));
    const transfers: FakeTransfer[] = [{ block: deployBlock, from: ZERO, to: COUNTERPARTY, value: u('1000000') }];
    for (const [iso, from, to, v] of flows[t.symbol] ?? [])
      transfers.push({ block: blockAt(d(iso)), from, to, value: u(v) });
    return {
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: 18,
      bep677,
      deployBlock,
      schedules: (schedules[t.symbol] ?? []).map(([at, m, eff]) => ({
        block: blockAt(ts(at)),
        newMultiplier: u(m),
        effectiveAt: ts(eff),
      })),
      transfers,
    };
  };
  for (const t of BSTOCKS) tokens.push(mk(t, true, '2026-05-20T00:00:00Z'));
  for (const t of ONDO) tokens.push(mk(t, false, '2026-05-18T00:00:00Z'));
  tokens.push(mk(XMPLB, true, '2026-05-25T00:00:00Z'));
  // Pay-in token for the demo Buy flow.
  tokens.push({
    address: USDT,
    symbol: 'USDT',
    decimals: 18,
    bep677: false,
    deployBlock: BASE_BLOCK,
    schedules: [],
    transfers: [{ block: BASE_BLOCK, from: ZERO, to: DEMO_ADDRESS, value: u('5000') }],
  });

  const sValues: Record<string, string> = {
    NVDAon: '1.0021',
    AAPLon: '1.0012',
    GOOGLon: '1.0008',
    SPYon: '1.0034',
    QQQon: '1.0015',
    AMDon: '1',
    TSLAon: '1',
    CRCLon: '1',
    SPCXon: '1',
  };

  return {
    baseBlock: BASE_BLOCK,
    baseTimestamp: BASE_TS,
    blockTimeMs: BLOCK_MS,
    head: () => blockAt(Math.max(clock(), nowSec)) - 1n,
    tokens,
    archive: true,
    maxLogRange: 5_000_000n,
    venus: {
      comptroller: VENUS_COMPTROLLER,
      oracle: VENUS_ORACLE,
      vTokens: [
        {
          address: vNVDAB,
          symbol: 'vNVDAB',
          underlying: bySymbol('NVDAB'),
          exchangeRate: 2n * 10n ** 26n,
          balances: new Map([[DEMO_ADDRESS, 620n * 10n ** 8n]]),
          members: new Set([DEMO_ADDRESS]),
          price: u('230.79168'),
        },
        {
          address: vTSLAB,
          symbol: 'vTSLAB',
          underlying: bySymbol('TSLAB'),
          exchangeRate: 2n * 10n ** 26n,
          balances: new Map(),
          members: new Set(),
          price: u('431.2'),
        },
        {
          address: VUSDT,
          symbol: 'vUSDT',
          underlying: USDT,
          exchangeRate: 2n * 10n ** 26n,
          balances: new Map(),
          members: new Set(),
          price: u('1'),
        },
      ],
    },
    moolah: {
      address: LISTA_MOOLAH,
      markets: [
        {
          id: DEMO_LISTA_MARKET_XMPLB,
          loanToken: USDT,
          collateralToken: XMPLB_ADDR,
          lltv: u('0.5'),
          positions: new Map([[DEMO_ADDRESS, { supplyShares: 0n, borrowShares: u('1000'), collateral: u('30') }]]),
        },
        {
          id: DEMO_LISTA_MARKET_NVDAB,
          loanToken: USDT,
          collateralToken: bySymbol('NVDAB'),
          lltv: u('0.6'),
          positions: new Map(),
        },
        {
          // Morpho-style shares: 1e6 shares per asset unit at inception.
          id: DEMO_LISTA_MARKET_NVDAB_LEND,
          loanToken: bySymbol('NVDAB'),
          collateralToken: USDT,
          lltv: u('0.7'),
          totals: [u('100'), u('100') * 10n ** 6n, u('40'), u('40') * 10n ** 6n],
          positions: new Map([[DEMO_ADDRESS, { supplyShares: u('2') * 10n ** 6n, borrowShares: 0n, collateral: 0n }]]),
        },
        {
          id: DEMO_LISTA_MARKET_NVDAB_BORROW,
          loanToken: bySymbol('NVDAB'),
          collateralToken: USDT,
          lltv: u('0.7'),
          totals: [u('50'), u('50') * 10n ** 6n, u('20'), u('20') * 10n ** 6n],
          positions: new Map([
            [DEMO_ADDRESS, { supplyShares: 0n, borrowShares: u('0.5') * 10n ** 6n, collateral: u('500') }],
          ]),
        },
      ],
    },
    pairs: [
      {
        address: AAPLB_USDT_PAIR,
        token0: bySymbol('AAPLB'),
        token1: USDT,
        reserve0: u('2000'),
        reserve1: u('457276.024'),
        totalSupply: u('30000'),
        balances: new Map([[DEMO_ADDRESS, u('75')]]),
      },
    ],
    ondoOracle: {
      address: DEMO_ONDO_ORACLE,
      // NVDAon's total-return factor ticks twice: once before the demo address held it, once after.
      history: [
        { block: blockAt(d('2026-07-03T13:30:00Z')), asset: bySymbol('NVDAon'), sValue: u('1.0009') },
        { block: blockAt(d('2026-09-11T13:30:00Z')), asset: bySymbol('NVDAon'), sValue: u('1.0021') },
      ],
      values: new Map(Object.entries(sValues).map(([s, v]) => [bySymbol(s), { sValue: u(v), paused: false }])),
    },
  };
}

export function demoMarks(): { marks: Map<Address, MarkQuote>; pools: Map<Address, PoolRef[]> } {
  const raw: Record<string, [number, number]> = {
    // symbol: [price per raw token, liquidity]
    NVDAB: [230.79168, 1_250_000],
    AAPLB: [228.638012, 457_000],
    MSFTB: [512.3, 610_000],
    TSLAB: [431.2, 2_100_000],
    GOOGLB: [251.1, 380_000],
    MUB: [118.4, 95_000],
    XMPLB: [100.4, 55_000],
    NVDAon: [231.12, 820_000],
    AAPLon: [228.77, 900_000],
    SPYon: [667.9, 1_900_000],
  };
  const marks = new Map<Address, MarkQuote>();
  const pools = new Map<Address, PoolRef[]>();
  for (const [sym, [p, liq]] of Object.entries(raw)) {
    const a = bySymbol(sym);
    // Mark-only pools: addresses that answer nothing on the fixture chain.
    const pair = sym === 'AAPLB' ? AAPLB_USDT_PAIR : getAddress(`0xde31${a.slice(6).toLowerCase()}`);
    marks.set(a, { rawUsd: p, dex: 'pancakeswap', pair, liquidityUsd: liq, thin: liq < 10_000 });
    pools.set(a, [{ pair, dex: 'pancakeswap', labels: ['v2'], token0Symbol: sym, token1Symbol: 'USDT' }]);
  }
  return { marks, pools };
}

/**
 * Demo RWA listing: Binance ratio equal to the fixture factor, markets open
 * except MSFTB, shown with its cash market shut to exercise the stale-reference note.
 */
export function demoRwa(nowSec: number = Math.floor(Date.now() / 1000)): RwaToken[] {
  const nextOpenMs = (Math.floor(nowSec / DAY) * DAY + DAY + 13.5 * 3600) * 1000;
  const factors: Record<string, string> = {
    NVDAB: '1.0017',
    AAPLB: '1.000604',
    MSFTB: '1',
    TSLAB: '1',
    GOOGLB: '1.00084',
    MUB: '1.00115',
    NVDAon: '1.0021',
    AAPLon: '1.0012',
    SPYon: '1.0034',
  };
  const { marks } = demoMarks();
  return Object.entries(factors).map(([sym, f]) => {
    const t = DEMO_TOKENS.find((x) => x.symbol === sym)!;
    const raw = marks.get(t.address)!.rawUsd;
    return {
      address: t.address,
      symbol: sym,
      platformId: t.issuer === 'Ondo' ? 'ondo' : 'bstock',
      underlyingTicker: t.ticker,
      tokenToShareRatio: f,
      referencePrice: raw / Number(f),
      tokenPrice: raw,
      status:
        sym === 'MSFTB'
          ? {
              openState: false,
              marketStatus: 'closed',
              reasonCode: 'MARKET_CLOSED',
              reasonMsg: 'Outside US cash hours (demo)',
              nextOpenTime: nextOpenMs,
            }
          : { openState: true, marketStatus: 'regular', reasonCode: 'TRADING', reasonMsg: null, nextOpenTime: null },
    };
  });
}

/** What the demo's Binance DeFi API reports: raw units, plus one protocol Shaddai does not scan. */
export function demoDefi(): DefiPosition[] {
  const base = { poolType: 'Lending', pool: null, priceUsd: null, valueUsd: null };
  const nvdab = bySymbol('NVDAB');
  return [
    {
      ...base,
      protocolId: 'venus',
      protocolName: 'Venus',
      healthFactor: '2.41',
      side: 'supply',
      token: nvdab,
      symbol: 'NVDAB',
      amount: '12.4',
    },
    {
      ...base,
      protocolId: 'lista-lending',
      protocolName: 'Lista Lending',
      healthFactor: '1.18',
      side: 'supply',
      token: XMPLB_ADDR,
      symbol: 'XMPLB',
      amount: '30',
    },
    {
      ...base,
      protocolId: 'lista-lending',
      protocolName: 'Lista Lending',
      healthFactor: null,
      side: 'supply',
      token: nvdab,
      symbol: 'NVDAB',
      amount: '2',
    },
    {
      ...base,
      protocolId: 'lista-lending',
      protocolName: 'Lista Lending',
      healthFactor: '3.02',
      side: 'borrow',
      token: nvdab,
      symbol: 'NVDAB',
      amount: '0.5',
    },
    {
      ...base,
      poolType: 'Yield',
      protocolId: 'demo-vault',
      protocolName: 'Demo Vault (fictional)',
      healthFactor: null,
      side: 'supply',
      token: bySymbol('AAPLB'),
      symbol: 'AAPLB',
      amount: '1.5',
    },
  ];
}

export const DEMO_USDT = USDT;
