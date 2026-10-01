/**
 * Share-normalized wrapper spread: for one ticker, every verified wrapper priced
 * per SHARE-EQUIVALENT before anything is compared. A raw gap can be a dividend;
 * dividing the raw price by the on-chain factor removes it.
 *
 *   UI price = rawPrice × 1e18 / multiplier        (pool and RWA token prices are per raw token)
 *   gap      = (shareEqPrice − reference) / reference
 *
 * The reference is the RWA Data API's referencePrice when a key is configured.
 * Binance documents it as a per-share price derived from the on-chain token price,
 * not an exchange quote; the panel says so. With no key, the reference is unread.
 */
import type { Address } from 'viem';
import { USDT_BSC } from './buy.js';
import { MIN_LIQUIDITY_USD, readBooks, type WrapperBook } from './books.js';
import { tokenRef } from './events.js';
import { usCashSession, type CashSession } from './market-hours.js';
import { probeTokens } from './probe.js';
import type { ShaddaiContext } from './scan.js';
import type { RwaStatus, RwaToken } from './trade-api.js';
import type { TokenRef } from './types.js';
import { decimalString, uiPrice } from './units.js';

export const SPREAD_TICKERS = ['NVDA', 'TSLA', 'AAPL', 'GOOGL', 'SPCX', 'CRCL', 'AMD', 'MU', 'QQQ', 'SPY'];

export const SPREAD_COPY = {
  lead: 'A raw gap can be a dividend. Shaddai subtracts the multiplier first.',
  reference:
    'Reference: the RWA Data API referencePrice, which Binance describes as a per-share price derived from the on-chain token price, not an exchange quote or last close.',
  noReference:
    'No Binance Web3 API key on this server, so there is no reference price and no gap. Share-eq prices still compare across wrappers.',
  unread: 'Factor unread: no share-eq price, no gap. Shaddai does not assume 1.0.',
  xstocksUnread: 'display factor unread',
};

export interface MarketBadge {
  closed: boolean;
  badge: string | null;
  detail: string | null;
  nextOpenMs: number | null;
  nextOpenSource: 'binance-rwa' | 'clock' | null;
  status: string | null;
}

export interface SpreadRow {
  token: TokenRef;
  factor: string | null;
  factorSource: 'uiMultiplier' | 'sValue' | null;
  factorUnread: string | null;
  book: WrapperBook;
  /** Pool price per share-equivalent: rawPrice ÷ factor. */
  shareEqPrice: number | null;
  rwa: {
    tokenPrice: number | null;
    shareEqPrice: number | null;
    referencePrice: number | null;
    binanceRatio: string | null;
    gapPct: number | null;
  } | null;
  reference: number | null;
  /** After the multiplier. */
  gapPct: number | null;
  /** Before the multiplier, shown only to make the point. */
  rawGapPct: number | null;
  liquid: boolean | null;
  market: MarketBadge;
  notes: string[];
}

export interface SpreadResult {
  mode: 'live' | 'demo';
  ticker: string;
  name: string;
  block: string;
  generatedAt: number;
  tickers: string[];
  rows: SpreadRow[];
  tightest: Address | null;
  cheapestRaw: Address | null;
  missing: string[];
  session: CashSession & { source: 'clock' };
  referenceNote: string;
  minLiquidityUsd: number;
  copy: string;
}

export class SpreadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const pct = (a: number, ref: number) => ((a - ref) / ref) * 100;

export function marketBadge(status: RwaStatus | null, session: CashSession): MarketBadge {
  const reason = status?.reasonCode ?? null;
  const paused =
    status?.marketStatus === 'pause' || ['ASSET_PAUSED', 'MARKET_PAUSED', 'MARKET_MAINTENANCE'].includes(reason ?? '');
  const rwaClosed = Boolean(
    status && ((status.marketStatus && status.marketStatus !== 'regular') || status.openState === false),
  );
  const closed = paused || rwaClosed || !session.open;
  const weekend = session.reason === 'weekend' || /weekend|holiday/i.test(status?.reasonMsg ?? '');
  const nextOpenMs = status?.nextOpenTime ?? (closed ? session.nextOpenMs : null);
  const source = status?.nextOpenTime ? 'binance-rwa' : closed ? 'clock' : null;
  return {
    closed,
    badge: !closed
      ? null
      : paused
        ? 'Trading paused, not a mispricing'
        : weekend
          ? 'Weekend quote, not a mispricing'
          : 'Off-hours quote, not a mispricing',
    detail: paused
      ? (status?.reasonMsg ?? reason)
      : status?.marketStatus && status.marketStatus !== 'regular'
        ? `Binance market status: ${status.marketStatus}${status.reasonMsg ? ` (${status.reasonMsg})` : ''}.`
        : !session.open
          ? `US cash session closed (${session.reason.replace('-', ' ')}, New York time).`
          : null,
    nextOpenMs,
    nextOpenSource: source,
    status: status?.marketStatus ?? null,
  };
}

export function spreadTickers(ctx: ShaddaiContext): string[] {
  const have = new Set(ctx.tokens.map((t) => t.ticker));
  return [...SPREAD_TICKERS.filter((t) => have.has(t)), ...[...have].filter((t) => !SPREAD_TICKERS.includes(t)).sort()];
}

export async function spreadFor(
  ctx: ShaddaiContext,
  input: string,
  opts: { nowMs?: number; minLiquidityUsd?: number } = {},
): Promise<SpreadResult> {
  const q = input.trim().toUpperCase();
  const wrappers = ctx.tokens.filter((t) => t.ticker.toUpperCase() === q || t.symbol.toUpperCase() === q);
  if (!wrappers.length) throw new SpreadError(`Shaddai has no tokenized wrapper for "${input}" in its registry.`, 404);
  const ticker = wrappers[0]!.ticker;
  const all = ctx.tokens.filter((t) => t.ticker === ticker);
  const nowMs = opts.nowMs ?? Date.now();
  const minLiq = opts.minLiquidityUsd ?? ctx.buy?.minLiquidityUsd ?? MIN_LIQUIDITY_USD;

  const head = await ctx.chain.blockNumber();
  const hdr = await ctx.chain.getBlock(head);
  const probes = await probeTokens(ctx.chain, all, null, head, hdr.timestamp, { ondoOracle: ctx.ondoOracle });
  const [books, rwa] = await Promise.all([
    readBooks(
      { chain: ctx.chain, prices: ctx.prices },
      all.map((t) => ({ address: t.address, decimals: probes.get(t.address)!.unit.decimals })),
      USDT_BSC,
    ),
    ctx.buy
      ? ctx.buy.api.rwaTokens().then(
          (list) => ({ ok: true as const, list }),
          (e: Error) => ({ ok: false as const, error: e.message }),
        )
      : Promise.resolve(null),
  ]);
  const rwaBy = new Map<string, RwaToken>(rwa?.ok ? rwa.list.map((r) => [r.address.toLowerCase(), r]) : []);
  const session = usCashSession(nowMs);

  const rows: SpreadRow[] = all.map((t) => {
    const p = probes.get(t.address)!;
    const book = books.get(t.address)!;
    const notes: string[] = [];
    const mult = p.mult;
    const factorSource =
      mult === null
        ? null
        : p.unit.kind === 'ondo-svalue'
          ? 'sValue'
          : p.unit.kind === 'bep677'
            ? 'uiMultiplier'
            : null;
    const factorUnread =
      mult === null
        ? t.issuer === 'xStocks'
          ? SPREAD_COPY.xstocksUnread
          : (p.unit.unreadReason ?? 'Share factor not read.')
        : null;
    const shareEqPrice = mult !== null && book.rawPrice !== null ? uiPrice(book.rawPrice, mult) : null;
    const r = rwaBy.get(t.address.toLowerCase()) ?? null;
    const reference = r?.referencePrice ?? null;
    const rwaShareEq = r?.tokenPrice != null && mult !== null ? uiPrice(r.tokenPrice, mult) : null;
    if (
      r?.tokenToShareRatio &&
      mult !== null &&
      Math.abs(Number(r.tokenToShareRatio) / Number(decimalString(mult, 18)) - 1) > 1e-6
    ) {
      notes.push(
        `Binance's token-to-share ratio ${r.tokenToShareRatio} differs from the on-chain factor; Shaddai uses the on-chain one.`,
      );
    }
    if (factorUnread) notes.push(SPREAD_COPY.unread);
    notes.push(...book.notes);
    return {
      token: tokenRef(t),
      factor: mult === null ? null : decimalString(mult, 18),
      factorSource,
      factorUnread,
      book,
      shareEqPrice,
      rwa: r
        ? {
            tokenPrice: r.tokenPrice,
            shareEqPrice: rwaShareEq,
            referencePrice: r.referencePrice,
            binanceRatio: r.tokenToShareRatio,
            gapPct: rwaShareEq !== null && reference ? pct(rwaShareEq, reference) : null,
          }
        : null,
      reference,
      gapPct: shareEqPrice !== null && reference ? pct(shareEqPrice, reference) : null,
      rawGapPct: book.rawPrice !== null && reference ? pct(book.rawPrice, reference) : null,
      liquid: book.liquidityUsd === null ? null : book.liquidityUsd >= minLiq,
      market: marketBadge(r?.status ?? null, session),
      notes,
    };
  });

  rows.sort((a, b) => (a.shareEqPrice ?? Infinity) - (b.shareEqPrice ?? Infinity));
  const liquid = rows.filter((r) => r.liquid && r.gapPct !== null);
  const tightest = liquid.length
    ? liquid.reduce((b, r) => (Math.abs(r.gapPct!) < Math.abs(b.gapPct!) ? r : b)).token.address
    : null;
  const priced = rows.filter((r) => r.book.rawPrice !== null);
  const cheapestRaw = priced.length
    ? priced.reduce((b, r) => (r.book.rawPrice! < b.book.rawPrice! ? r : b)).token.address
    : null;

  const missing: string[] = [];
  for (const issuer of ['bStocks', 'Ondo', 'xStocks'] as const) {
    if (!all.some((t) => t.issuer === issuer)) {
      missing.push(`${issuer}: no verified BSC contract for ${ticker} in the registry, so none is shown.`);
    }
  }

  return {
    mode: ctx.mode,
    ticker,
    name: wrappers[0]!.name,
    block: head.toString(),
    generatedAt: Math.floor(nowMs / 1000),
    tickers: spreadTickers(ctx),
    rows,
    tightest,
    cheapestRaw,
    missing,
    session: { ...session, source: 'clock' },
    referenceNote: !ctx.buy
      ? SPREAD_COPY.noReference
      : rwa && !rwa.ok
        ? `RWA Data API unavailable (${rwa.error}), so there is no reference price and no gap.`
        : SPREAD_COPY.reference,
    minLiquidityUsd: minLiq,
    copy: SPREAD_COPY.lead,
  };
}
