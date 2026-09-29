import type { Address } from 'viem';
import { tokenRef } from './events.js';
import type { MarkQuote } from './prices.js';
import type { TokenProbe } from './probe.js';
import { LINKS } from './registry.js';
import type { CollateralPosition, LocationKind, PortfolioRow, Price } from './types.js';
import { decimalString, fixedToNumber, ONE, uiPrice } from './units.js';

export const DUST_USD = 1;

export function toPrice(mark: MarkQuote | undefined, mult: bigint | null, source: Price['source']): Price | null {
  if (!mark) return null;
  return {
    rawUsd: mark.rawUsd,
    shareUsd: mult !== null ? uiPrice(mark.rawUsd, mult) : mark.rawUsd,
    source,
    dex: mark.dex,
    pair: mark.pair,
    liquidityUsd: mark.liquidityUsd,
    url: mark.url,
    thin: mark.thin,
  };
}

const PROTOCOL_KIND: Record<CollateralPosition['protocol'], LocationKind> = {
  Venus: 'venus',
  Lista: 'lista',
  'PancakeSwap V2': 'lp',
};

/**
 * Wallet rows from the probe plus one row per protocol position, so the
 * portfolio reads as total share-true exposure on the address.
 */
export function buildPortfolio(
  probes: Map<Address, TokenProbe>,
  prices: Map<Address, Price>,
  positions: CollateralPosition[],
): { rows: PortfolioRow[]; totalUsd: number; pricedRows: number } {
  const rows: PortfolioRow[] = [];
  const make = (
    p: TokenProbe,
    location: PortfolioRow['location'],
    raw: bigint,
    shareEq: bigint,
    source: PortfolioRow['shareEqSource'],
  ): PortfolioRow => {
    const dec = p.unit.decimals;
    const price = prices.get(p.token.address) ?? null;
    const positionUsd = price ? fixedToNumber(raw, dec) * price.rawUsd : null;
    const dust = positionUsd !== null ? positionUsd < DUST_USD : raw < 10n ** BigInt(Math.max(dec - 6, 0));
    return {
      token: tokenRef(p.token),
      location,
      raw: decimalString(raw, dec),
      shareEq: decimalString(shareEq, dec),
      shareEqSource: source,
      drift: decimalString(shareEq - raw, dec),
      multiplier: p.unit.multiplier,
      price,
      positionUsd,
      dust,
      oneToOneNow: p.mult === ONE && p.unit.pending === null && p.unit.ondo?.paused !== true,
    };
  };

  for (const p of probes.values()) {
    if (p.raw === 0n) continue;
    rows.push(
      make(
        p,
        { kind: 'wallet', label: 'Wallet', url: LINKS.bscscanToken(p.token.address) },
        p.raw,
        p.shareEq,
        p.shareEqSource,
      ),
    );
  }
  for (const pos of positions) {
    if (pos.side === 'borrow') continue; // a debt, not a holding; shown on the Collateral tab
    const p = probes.get(pos.token.address);
    if (!p) continue;
    const dec = p.unit.decimals;
    const toBase = (s: string) => {
      const [w, f = ''] = s.split('.');
      return BigInt(w!) * 10n ** BigInt(dec) + BigInt((f + '0'.repeat(dec)).slice(0, dec) || '0');
    };
    rows.push(
      make(
        p,
        {
          kind: PROTOCOL_KIND[pos.protocol],
          label: `${pos.protocol}${pos.side === 'lend' && pos.protocol === 'Lista' ? ' · lent' : ''} · ${pos.market.label}`,
          contract: pos.market.address,
          url: pos.market.url,
        },
        toBase(pos.raw),
        toBase(pos.shareEq),
        p.mult === null ? 'raw' : p.unit.kind === 'ondo-svalue' ? 'sValue' : 'computed',
      ),
    );
  }
  rows.sort((a, b) => (b.positionUsd ?? -1) - (a.positionUsd ?? -1) || a.token.symbol.localeCompare(b.token.symbol));
  const priced = rows.filter((r) => r.positionUsd !== null);
  return { rows, totalUsd: priced.reduce((s, r) => s + (r.positionUsd ?? 0), 0), pricedRows: priced.length };
}
