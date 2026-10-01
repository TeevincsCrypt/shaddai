/**
 * "Did I get the dividend?" One question, one answer, from the existing ledger.
 * No strategy, no orders: it reads multiplier (or Ondo sValue) changes for one
 * ticker and says what they did to this holder, in share-equivalents.
 *
 * It never invents a dividend: no change touching the holder is a clear miss, and
 * a change the holder was not in for says so.
 */
import { getAddress, parseUnits, type Address } from 'viem';
import { tokenRef } from './events.js';
import { buildLedger } from './ledger.js';
import { toPrice } from './portfolio.js';
import { probeTokens } from './probe.js';
import { scanAddress, type ShaddaiContext } from './scan.js';
import type { LedgerRow, Price, TokenRef } from './types.js';
import { fmtAmount, fmtMultiplier } from './units.js';

export const DIVIDEND_COPY = {
  miss: 'No multiplier change found for this holder.',
  noTransfer: 'No Transfer event. A tax export that only reads transfers will miss this.',
  withholding: 'The 30% withholding is a typical rate for a non-US holder, shown as a note, not tax advice.',
};

export class DividendError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface DividendEvent {
  kind: LedgerRow['kind'];
  date: string;
  effectiveAt: number;
  block: string | null;
  txHash: string;
  factor: 'multiplier' | 'sValue';
  oldMultiplier: string;
  newMultiplier: string;
  rawAtEvent: string | null;
  rawAtEventSource: LedgerRow['rawAtEventSource'];
  deltaShareEq: string | null;
  estUsd: number | null;
}

export interface DividendWrapper {
  token: TokenRef;
  status: 'hit' | 'not-held' | 'miss' | 'unread';
  event: DividendEvent | null;
  pending: DividendEvent | null;
  earlierHits: number;
  sentence: string;
  notes: string[];
}

export interface DividendAnswer {
  status: 'hit' | 'not-held' | 'miss' | 'unread' | 'indexing' | 'unavailable';
  mode: 'live' | 'demo';
  address: Address;
  ticker: string;
  block: string;
  card: string;
  wrappers: DividendWrapper[];
  notes: string[];
  disclaimer: string;
}

const day = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const fx = (s: string) => fmtMultiplier(parseUnits(s, 18));
/** Six places, or every significant digit when a nonzero amount would round to zero (dust). */
const amt = (s: string, places = 6) => {
  const v = parseUnits(s, 18);
  const shown = fmtAmount(v, 18, places, places);
  return v !== 0n && /^-?0\.0+$/.test(shown) ? s : shown;
};
const money = (n: number) =>
  n > 0 && n < 0.01
    ? '<$0.01'
    : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const held = (r: LedgerRow) => r.rawAtEvent !== null && parseUnits(r.rawAtEvent, 18) > 0n;
const historical = (r: LedgerRow) => r.rawAtEventSource === 'archive' || r.rawAtEventSource === 'replay';

/** "Apple-equivalents"; tickers for funds and names that do not read as one word. */
export function unitName(t: TokenRef): string {
  return /^[A-Za-z]+$/.test(t.name) ? `${t.name}-equivalents` : `${t.ticker}-equivalents`;
}

function toEvent(r: LedgerRow): DividendEvent {
  return {
    kind: r.kind,
    date: day(r.effectiveAt),
    effectiveAt: r.effectiveAt,
    block: r.effectiveBlock,
    txHash: r.txHash,
    factor: r.eventLayout === 'ondo-svalue' ? 'sValue' : 'multiplier',
    oldMultiplier: r.oldMultiplier,
    newMultiplier: r.newMultiplier,
    rawAtEvent: r.rawAtEvent,
    rawAtEventSource: r.rawAtEventSource,
    deltaShareEq: r.deltaShareEq,
    estUsd: r.estUsd,
  };
}

/** The sentence for one change the holder was in for. */
export function hitSentence(t: TokenRef, e: DividendEvent): string {
  const where = `${e.date}${e.block ? `, block ${e.block}` : ''}`;
  const Factor = e.factor === 'sValue' ? 'Ondo sValue' : 'Multiplier';
  const moved = `Raw stayed ${amt(e.rawAtEvent!)}. ${Factor} went ${fx(e.oldMultiplier)} → ${fx(e.newMultiplier)}.`;
  const delta = e.deltaShareEq !== null ? amt(e.deltaShareEq) : 'an unread amount of';
  if (e.kind === 'split' || e.kind === 'reverse-split') {
    return `${t.symbol} applied a ${e.kind === 'split' ? 'split' : 'reverse split'} on ${where}. ${moved} Your ${unitName(t)} changed by ${delta}; a split changes the share count, not the value, so there is no USD credit.`;
  }
  const usd =
    e.estUsd === null
      ? 'USD value not read (no price mark)'
      : `about ${money(e.estUsd)} at today's price, after typical 30% US withholding`;
  if (e.kind === 'dividend-reinvest') {
    return `${t.symbol} paid on ${where}. ${moved} You gained ${delta} ${unitName(t)}, ${usd}.`;
  }
  return `${t.symbol}'s ${Factor.toLowerCase()} changed on ${where} (${e.kind.replace(/-/g, ' ')}). ${moved} Your ${unitName(t)} changed by ${delta}, ${usd}.`;
}

function answerFor(t: TokenRef, rows: LedgerRow[]): DividendWrapper {
  const mine = rows.filter((r) => r.token.address === t.address).sort((a, b) => b.effectiveAt - a.effectiveAt);
  const effective = mine.filter((r) => r.status === 'effective');
  const hits = effective.filter(held);
  const pendingRow = mine.find((r) => r.status === 'pending' && held(r)) ?? null;
  const pending = pendingRow ? toEvent(pendingRow) : null;
  const pendingLine = pending
    ? ` A further change is scheduled for ${pending.date}: ${fx(pending.oldMultiplier)} → ${fx(pending.newMultiplier)} (projected ${pending.deltaShareEq !== null ? amt(pending.deltaShareEq) : 'unread'} ${unitName(t)} on the current balance).`
    : '';
  const keepNotes = (r: LedgerRow) =>
    r.notes.filter((n) => !/withholding|No Transfer event|current mark|Not tax advice/i.test(n));

  if (hits.length) {
    const top = hits[0]!;
    const event = toEvent(top);
    return {
      token: t,
      status: 'hit',
      event,
      pending,
      earlierHits: hits.length - 1,
      sentence: `${hitSentence(t, event)} ${DIVIDEND_COPY.noTransfer}${pendingLine}`,
      notes: keepNotes(top),
    };
  }
  if (effective.length) {
    const last = effective[0]!;
    const event = toEvent(last);
    if (!historical(last)) {
      return {
        token: t,
        status: 'unread',
        event,
        pending,
        earlierHits: 0,
        sentence: `${t.symbol} changed its ${event.factor} on ${event.date}, but this address's ${t.symbol} balance at that block could not be read (it needs archive state or a transfer replay). Shaddai does not guess it.${pendingLine}`,
        notes: keepNotes(last),
      };
    }
    return {
      token: t,
      status: 'not-held',
      event,
      pending,
      earlierHits: 0,
      sentence: `${DIVIDEND_COPY.miss} ${t.symbol} changed its ${event.factor} ${fx(event.oldMultiplier)} → ${fx(event.newMultiplier)} on ${event.date}${event.block ? ` (block ${event.block})` : ''}, but this address held no ${t.symbol} at that block.${pendingLine}`,
      notes: [],
    };
  }
  return {
    token: t,
    status: 'miss',
    event: null,
    pending,
    earlierHits: 0,
    sentence: `${DIVIDEND_COPY.miss} The index holds no ${t.symbol} multiplier change for this address.${pendingLine}`,
    notes: [],
  };
}

export async function dividendAnswer(
  ctx: ShaddaiContext,
  addressInput: string,
  tickerInput: string,
  opts: { ledgerBudgetMs?: number } = {},
): Promise<DividendAnswer> {
  const q = tickerInput.trim().toUpperCase();
  if (!q) throw new DividendError('Pass a ticker (AAPL) or a symbol (AAPLB).');
  const bySymbol = ctx.tokens.filter((t) => t.symbol.toUpperCase() === q);
  const wrappers = bySymbol.length ? bySymbol : ctx.tokens.filter((t) => t.ticker.toUpperCase() === q);
  if (!wrappers.length) throw new DividendError(`Shaddai has no tokenized wrapper for "${tickerInput}".`, 404);
  const ticker = wrappers[0]!.ticker;

  // The existing statement first: same ledger, same notes, same cache as the Ledger tab.
  const scan = await scanAddress(ctx, getAddress(addressInput.toLowerCase()), {
    ledgerBudgetMs: opts.ledgerBudgetMs ?? 45_000,
  });
  const base = {
    mode: scan.mode,
    address: scan.address,
    ticker,
    block: scan.block,
    disclaimer: DIVIDEND_COPY.withholding,
  };
  if (scan.ledger.status !== 'ready') {
    const indexing = scan.ledger.status === 'indexing';
    return {
      ...base,
      status: indexing ? 'indexing' : 'unavailable',
      card: indexing
        ? `The multiplier index is still being built (${Math.round((scan.ledger.progress ?? 0) * 100)}%). Ask again in a minute.`
        : `The ledger is unavailable: ${scan.ledger.error ?? 'unknown error'}.`,
      wrappers: [],
      notes: [],
    };
  }

  // Wrappers the statement skipped because the address holds none today: read them anyway.
  const covered = new Set(scan.ledger.rows.map((r) => r.token.address));
  const heldNow = new Set(scan.portfolio.rows.map((r) => r.token.address));
  const extra = wrappers.filter((t) => !covered.has(t.address) && !heldNow.has(t.address));
  let rows = scan.ledger.rows;
  if (extra.length) {
    const head = { number: BigInt(scan.block), timestamp: scan.blockTime };
    const probes = await probeTokens(ctx.chain, extra, scan.address, head.number, head.timestamp, {
      ondoOracle: ctx.ondoOracle,
    });
    const prices = new Map<Address, Price>();
    const marks = await ctx.prices
      .quote(extra.map((t) => t.address))
      .then((q) => q.marks)
      .catch(() => new Map());
    for (const t of extra) {
      const p = toPrice(
        marks.get(t.address),
        probes.get(t.address)?.mult ?? null,
        scan.mode === 'demo' ? 'fixture' : 'dexscreener',
      );
      if (p) prices.set(t.address, p);
    }
    const more = await buildLedger({
      chain: ctx.chain,
      holder: scan.address,
      head,
      events: ctx.feed.timeline(head.timestamp),
      probes,
      prices,
      protocolExposure: new Map(),
      rawAt: ctx.rawAt,
      include: extra.map((t) => t.address),
    });
    rows = [...rows, ...more];
  }

  const answers = wrappers.map((t) => answerFor(tokenRef(t), rows));
  const rank = { hit: 0, unread: 1, 'not-held': 2, miss: 3 } as const;
  answers.sort((a, b) => rank[a.status] - rank[b.status]);
  const hits = answers.filter((a) => a.status === 'hit');
  const status = answers[0]!.status;
  const shown = hits.length ? hits : [answers[0]!];
  const others = answers.filter((a) => !shown.includes(a) && a.status !== 'miss');
  const card = [
    ...shown.map((a) => a.sentence),
    ...others.map((a) => a.sentence),
    hits.some((a) => a.event?.kind === 'dividend-reinvest') ? DIVIDEND_COPY.withholding : null,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    ...base,
    status,
    card,
    wrappers: answers,
    notes: [
      ...answers.flatMap((a) => a.notes.map((n) => `${a.token.symbol}: ${n}`)),
      ...(scan.ledger.notices ?? []),
      ...(hits.some((a) => a.earlierHits > 0)
        ? [`Earlier changes for this holder are in the Ledger tab and its CSV.`]
        : []),
    ],
  };
}
