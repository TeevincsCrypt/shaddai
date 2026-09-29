/**
 * Pre-action collateral preview. For each protocol position, and each wallet
 * holding that could be posted, it states what the next multiplier change does
 * ("flips at T, raw stays X, share-eq becomes Y") and the gap a share-priced
 * oracle would open against a protocol that counts raw tokens. Market hours
 * come from the RWA Data API; positions are cross-checked against the Binance
 * DeFi API. Nothing here is a price to trade on.
 */
import { parseUnits, type Address } from 'viem';
import type { ShaddaiContext } from './scan.js';
import type { DefiPosition, RwaStatus } from './trade-api.js';
import type { CollateralPosition, OracleCheck, ScanResult, TokenRef, UnitModel } from './types.js';
import { decimalString, fixedToNumber, toUI } from './units.js';

export type PreviewSide = 'collateral' | 'lend' | 'borrow' | 'lp' | 'wallet';

export interface PreviewItem {
  token: TokenRef;
  protocol: string | null;
  side: PreviewSide;
  label: string;
  raw: string;
  multiplier: string | null;
  shareEqNow: string | null;
  flip: {
    at: number;
    multiplier: string;
    kind: string;
    splitLabel?: string;
    shareEqAfter: string;
  } | null;
  oracleBasis: OracleCheck['basis'] | null;
  /** share-eq − raw: what a share-priced oracle over a raw-counting protocol leaves out. */
  gap: { nowShares: string; afterShares: string | null; nowUsd: number | null; afterUsd: number | null } | null;
  severity: 'info' | 'watch' | 'alert';
  lines: string[];
  market: RwaStatus | null;
  staleReference: boolean;
}

export interface DefiCheck {
  token: TokenRef;
  protocol: string;
  side: 'supply' | 'borrow';
  apiAmount: string;
  ourRaw: string | null;
  ourShareEq: string | null;
  matches: 'raw' | 'share-eq' | 'indistinguishable' | 'neither' | 'not-found-on-chain';
  healthFactor: string | null;
}

export interface PreviewResult {
  mode: 'live' | 'demo';
  address: Address;
  block: string;
  generatedAt: number;
  items: PreviewItem[];
  market: { status: 'ok' | 'unavailable' | 'not-configured'; detail: string };
  defi: {
    status: 'ok' | 'unavailable' | 'not-configured';
    detail: string;
    checks: DefiCheck[];
    /** Tracked tokens in protocols Shaddai does not scan. */
    unscanned: (DefiPosition & { tokenRef: TokenRef })[];
  };
  notes: string[];
}

export const PREVIEW_COPY = {
  stale: 'Cash market shut: the reference price is stale. Do not treat this preview as a tradable premium.',
  notPrice: 'A preview of units, not a price to trade on.',
} as const;

const utc = (ts: number) => `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const fmt = (s: string, places = 4) => {
  const [w, f = ''] = s.split('.');
  const cut = f.slice(0, places).replace(/0+$/, '');
  return cut ? `${w}.${cut}` : w!;
};
const usd = (n: number | null) =>
  n === null
    ? ''
    : ` (~${n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })})`;

const COUNTER: Record<string, string> = { Venus: 'vToken', Lista: 'market', 'PancakeSwap V2': 'pool' };

function family(name: string): 'Venus' | 'Lista' | null {
  if (/venus/i.test(name)) return 'Venus';
  if (/lista|moolah/i.test(name)) return 'Lista';
  return null;
}

interface Figures {
  raw: bigint;
  mult: bigint | null;
  next: bigint | null;
  dec: number;
  shareUsd: number | null;
  rawUsd: number | null;
}

function figures(r: ScanResult, token: Address, rawStr: string): Figures {
  const u = r.units[token] as UnitModel;
  const dec = u.decimals;
  const price = r.portfolio.rows.find((x) => x.token.address === token)?.price ?? null;
  return {
    raw: parseUnits(rawStr, dec),
    mult: u.multiplier === null ? null : parseUnits(u.multiplier, 18),
    next: u.pending ? parseUnits(u.pending.multiplier, 18) : null,
    dec,
    shareUsd: price?.shareUsd ?? null,
    rawUsd: price?.rawUsd ?? null,
  };
}

function buildItem(
  r: ScanResult,
  token: TokenRef,
  side: PreviewSide,
  protocol: string | null,
  label: string,
  rawStr: string,
  basis: OracleCheck['basis'] | null,
  market: RwaStatus | null,
): PreviewItem {
  const u = r.units[token.address] as UnitModel;
  const f = figures(r, token.address, rawStr);
  const X = fmt(rawStr);
  const lines: string[] = [];
  const item: PreviewItem = {
    token,
    protocol,
    side,
    label,
    raw: rawStr,
    multiplier: u.multiplier,
    shareEqNow: null,
    flip: null,
    oracleBasis: basis,
    gap: null,
    severity: 'info',
    lines,
    market,
    staleReference: market?.openState === false,
  };

  if (f.mult === null) {
    lines.push(`${X} raw. ${u.unreadReason ?? 'Share factor not read.'} No preview without it.`);
    return item;
  }
  const nowShares = toUI(f.raw, f.mult);
  item.shareEqNow = decimalString(nowShares, f.dec);
  const afterShares = f.next !== null ? toUI(f.raw, f.next) : null;
  const pend = u.pending;

  if (pend && afterShares !== null) {
    item.flip = {
      at: pend.effectiveAt,
      multiplier: pend.multiplier,
      kind: pend.kind,
      splitLabel: pend.splitLabel,
      shareEqAfter: decimalString(afterShares, f.dec),
    };
    item.severity = 'watch';
    lines.push(
      `Multiplier flips at ${utc(pend.effectiveAt)} (${fmt(u.multiplier!, 8)}× → ${fmt(pend.multiplier, 8)}×${
        pend.splitLabel ? `, ${pend.splitLabel}` : ''
      }). Raw stays ${X}. Share-eq becomes ${fmt(item.flip.shareEqAfter)} (now ${fmt(item.shareEqNow)}).`,
    );
  } else if (u.kind === 'ondo-svalue') {
    lines.push(
      `Ondo publishes no schedule: sValue ${fmt(u.multiplier!, 8)} applies as it is written. Raw ${X} = ${fmt(item.shareEqNow)} share-eq today.`,
    );
  } else {
    lines.push(`No multiplier change scheduled. Raw ${X} = ${fmt(item.shareEqNow)} share-eq.`);
  }

  // Gap a share-priced oracle leaves when the protocol counts raw tokens.
  const gapNow = nowShares - f.raw;
  const gapAfter = afterShares !== null ? afterShares - f.raw : null;
  const toNum = (v: bigint) => fixedToNumber(v, f.dec);
  // After a flip the per-share price is the raw token's value ÷ the new multiplier (exact for a split).
  const perShareAfter = f.rawUsd !== null && f.next !== null ? f.rawUsd / fixedToNumber(f.next, 18) : null;
  item.gap = {
    nowShares: decimalString(gapNow, f.dec),
    afterShares: gapAfter === null ? null : decimalString(gapAfter, f.dec),
    nowUsd: f.shareUsd === null ? null : toNum(gapNow) * f.shareUsd,
    afterUsd: gapAfter === null || perShareAfter === null ? null : toNum(gapAfter) * perShareAfter,
  };
  const worst = gapAfter ?? gapNow;
  const worstUsd = gapAfter !== null ? item.gap.afterUsd : item.gap.nowUsd;
  const when = gapAfter !== null ? 'after the flip' : 'today';
  const bigGap = f.raw > 0n && worst * 100n > f.raw; // over 1% of the position

  if (side === 'wallet') {
    if (protocol) {
      lines.push(
        worst === 0n
          ? `If you post it on ${protocol} now, ${protocol} counts ${X} raw, which equals the share-eq while the multiplier is 1.0.`
          : `If you post it on ${protocol} now, ${protocol} counts ${X} raw. If its oracle is share-priced, the gap ${when} is ${fmt(
              decimalString(worst, f.dec),
              6,
            )} share-eq${usd(worstUsd)}; if it prices one raw token, there is none.`,
      );
    }
  } else if (side === 'lp') {
    const dividend = pend?.kind === 'dividend-reinvest';
    lines.push(
      pend
        ? dividend
          ? `The pool holds ${X} raw and prices one raw token. At the flip each raw token is worth ${fmt(pend.ratio, 6)}× more until someone trades; arbitrage takes that from LPs.`
          : `The pool holds ${X} raw. A split leaves a raw token's value unchanged, so the pool's price per raw token stays right.`
        : `The pool holds ${X} raw and prices one raw token; nothing is scheduled.`,
    );
  } else {
    const counter = COUNTER[protocol ?? ''] ?? 'protocol';
    if (side === 'borrow' && gapAfter !== null) {
      lines.push(
        `You owe ${X} raw. That is ${fmt(item.flip!.shareEqAfter)} share-eq after the flip (+${fmt(
          decimalString(gapAfter - gapNow, f.dec),
          6,
        )}): the borrower pays the reinvested dividend.`,
      );
    }
    const subject = side === 'borrow' ? 'this debt' : 'this position';
    if (basis === 'raw') {
      lines.push(
        `${protocol}'s oracle prices one raw token (checked against the DEX mark), so ${subject} is valued in the right unit${
          pend ? ' once its price feed catches up with the flip' : ''
        }.`,
      );
    } else if (worst === 0n) {
      lines.push(`While the multiplier is 1.0, raw and share-eq are equal: no gap today.`);
    } else if (basis === 'share') {
      lines.push(
        `${protocol}'s oracle is share-priced and the ${counter} counts raw: it values ${X} where the true figure is ${fmt(
          decimalString(f.raw + worst, f.dec),
        )} share-eq. Gap ${when}: ${fmt(decimalString(worst, f.dec), 6)} share-eq${usd(worstUsd)}.`,
      );
    } else {
      lines.push(
        `If ${protocol}'s oracle is share-priced and the ${counter} counts raw, the gap ${when} is ${fmt(
          decimalString(worst, f.dec),
          6,
        )} share-eq${usd(worstUsd)}${side === 'borrow' ? ', in the debt it records' : ''}. If it prices one raw token, there is none.${
          basis === 'indistinguishable' ? ' Today the two cannot be told apart.' : ''
        }`,
      );
    }
    if (basis !== 'raw' && bigGap) item.severity = 'alert';
  }
  if (side === 'wallet' && protocol && bigGap) item.severity = 'alert';

  if (market?.openState === false) {
    const next = market.nextOpenTime ? ` until ${utc(Math.floor(market.nextOpenTime / 1000))}` : '';
    lines.push(
      `Cash market shut${market.reasonMsg ? ` (${market.reasonMsg})` : ''}: the reference price is stale${next}. Do not treat this preview as a tradable premium.`,
    );
  }
  return item;
}

export async function buildPreview(ctx: ShaddaiContext, r: ScanResult): Promise<PreviewResult> {
  const api = ctx.buy?.api ?? null;
  const tokens = new Map(r.tokens.map((t) => [t.address, t]));
  const [rwa, defi] = api
    ? await Promise.all([
        api.rwaTokens().then(
          (list) => ({ ok: true as const, list }),
          (e: Error) => ({ ok: false as const, error: e.message }),
        ),
        api.defiPositions(r.address).then(
          (list) => ({ ok: true as const, list }),
          (e: Error) => ({ ok: false as const, error: e.message }),
        ),
      ])
    : [null, null];
  const statusOf = (a: Address) => (rwa?.ok ? (rwa.list.find((x) => x.address === a)?.status ?? null) : null);

  const items: PreviewItem[] = [];
  const posSide = (p: CollateralPosition): PreviewSide => p.side;
  for (const p of r.collateral.positions) {
    items.push(
      buildItem(
        r,
        p.token,
        posSide(p),
        p.protocol,
        `${p.protocol} ${p.market.label}`,
        p.raw,
        p.side === 'lp' ? null : (p.oracle?.basis ?? 'unknown'),
        statusOf(p.token.address),
      ),
    );
  }
  // Wallet holdings: one item per protocol that lists the token, or one plain item if a change is pending.
  for (const row of r.portfolio.rows) {
    if (row.location.kind !== 'wallet' || row.dust || row.raw === '0') continue;
    const listed = r.collateral.listings.filter((l) => l.token.address === row.token.address);
    const status = statusOf(row.token.address);
    if (listed.length) {
      for (const l of listed) {
        items.push(buildItem(r, row.token, 'wallet', l.protocol, `Wallet → ${l.protocol}`, row.raw, 'unknown', status));
      }
    } else if (r.units[row.token.address]?.pending) {
      items.push(buildItem(r, row.token, 'wallet', null, 'Wallet', row.raw, null, status));
    }
  }
  const rank = { alert: 0, watch: 1, info: 2 } as const;
  items.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.flip?.at ?? Infinity) - (b.flip?.at ?? Infinity));

  // Cross-check what the Binance DeFi API reports against the chain.
  const checks: DefiCheck[] = [];
  const unscanned: PreviewResult['defi']['unscanned'] = [];
  if (defi?.ok) {
    const groups = new Map<string, { pos: DefiPosition; amount: number; hf: string | null }>();
    for (const d of defi.list) {
      const t = tokens.get(d.token);
      if (!t) continue;
      const fam = family(d.protocolName);
      if (!fam) {
        unscanned.push({ ...d, tokenRef: t });
        continue;
      }
      const k = `${d.token}|${fam}|${d.side}`;
      const g = groups.get(k) ?? { pos: d, amount: 0, hf: d.healthFactor };
      g.amount += Number(d.amount);
      groups.set(k, g);
    }
    for (const [k, g] of groups) {
      const [token, fam, side] = k.split('|') as [Address, 'Venus' | 'Lista', 'supply' | 'borrow'];
      const ours = r.collateral.positions.filter(
        (p) =>
          p.token.address === token &&
          p.protocol === fam &&
          (side === 'borrow' ? p.side === 'borrow' : p.side === 'collateral' || p.side === 'lend'),
      );
      const ourRaw = ours.reduce((s, p) => s + Number(p.raw), 0);
      const ourShare = ours.every((p) => p.shareEq !== null) ? ours.reduce((s, p) => s + Number(p.shareEq), 0) : null;
      const close = (a: number, b: number) => b > 0 && Math.abs(a / b - 1) < 1e-5;
      let matches: DefiCheck['matches'];
      if (!ours.length) matches = 'not-found-on-chain';
      else if (close(g.amount, ourRaw) && ourShare !== null && close(g.amount, ourShare)) matches = 'indistinguishable';
      else if (close(g.amount, ourRaw)) matches = 'raw';
      else if (ourShare !== null && close(g.amount, ourShare)) matches = 'share-eq';
      else matches = 'neither';
      checks.push({
        token: tokens.get(token)!,
        protocol: fam,
        side,
        apiAmount: String(g.amount),
        ourRaw: ours.length ? String(ourRaw) : null,
        ourShareEq: ourShare === null || !ours.length ? null : String(ourShare),
        matches,
        healthFactor: g.hf,
      });
    }
  }

  const notes: string[] = [PREVIEW_COPY.notPrice];
  if (items.some((i) => i.staleReference)) notes.push(PREVIEW_COPY.stale);
  return {
    mode: r.mode,
    address: r.address,
    block: r.block,
    generatedAt: Math.floor(Date.now() / 1000),
    items,
    market: !api
      ? { status: 'not-configured', detail: 'Market hours need the Binance Web3 API (RWA Data); not configured.' }
      : rwa?.ok
        ? { status: 'ok', detail: `${api.label}: RWA Data token list.` }
        : { status: 'unavailable', detail: `Market hours not read: ${rwa?.ok === false ? rwa.error : 'no answer'}.` },
    defi: !api
      ? {
          status: 'not-configured',
          detail: 'DeFi cross-check needs the Binance Web3 API; not configured.',
          checks,
          unscanned,
        }
      : defi?.ok
        ? { status: 'ok', detail: `${api.label}: DeFi Data positions for this address.`, checks, unscanned }
        : {
            status: 'unavailable',
            detail: `DeFi positions not read: ${defi?.ok === false ? defi.error : 'no answer'}.`,
            checks,
            unscanned,
          },
    notes,
  };
}

export function previewText(p: PreviewResult): string {
  const lines = [
    `Pre-action preview for ${p.address} at BSC block ${p.block}${p.mode === 'demo' ? ' — DEMO FIXTURE' : ''}.`,
  ];
  if (!p.items.length)
    lines.push('Nothing to preview: no protocol positions and no wallet holdings that a protocol lists.');
  for (const i of p.items)
    lines.push(`[${i.severity.toUpperCase()}] ${i.token.symbol} · ${i.label}: ${i.lines.join(' ')}`);
  for (const c of p.defi.checks) {
    lines.push(
      `Binance DeFi API: ${c.apiAmount} ${c.token.symbol} ${c.side} on ${c.protocol} — ${
        c.matches === 'not-found-on-chain' ? 'Shaddai found no such position on chain' : `matches ${c.matches}`
      }${c.healthFactor ? `, health factor ${c.healthFactor}` : ''}.`,
    );
  }
  for (const u of p.defi.unscanned) {
    lines.push(
      `Binance DeFi API: ${u.amount} ${u.tokenRef.symbol} ${u.side} on ${u.protocolName}, a protocol Shaddai does not scan.`,
    );
  }
  lines.push(`Market hours: ${p.market.detail} DeFi: ${p.defi.detail}`, ...p.notes);
  return lines.join('\n');
}
