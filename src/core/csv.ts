import type { LedgerRow } from './types.js';

export const CSV_COLUMNS = [
  'date',
  'block',
  'issuer',
  'symbol',
  'contract',
  'raw_at_event',
  'old_mult',
  'new_mult',
  'delta_share_eq',
  'est_usd',
  'note',
] as const;

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const KIND_LABEL: Record<string, string> = {
  'dividend-reinvest': 'dividend reinvest',
  'adjustment-down': 'downward adjustment',
  'large-adjustment': 'large adjustment',
  split: 'split',
  'reverse-split': 'reverse split',
  'no-change': 'no change',
  init: 'initialisation',
};

/**
 * Ledger rows to CSV. Overwritten schedules and effective events the wallet
 * did not hold through are omitted; pending rows are kept and labelled.
 */
export function ledgerToCsv(rows: LedgerRow[], opts: { demo?: boolean } = {}): string {
  const lines = [CSV_COLUMNS.join(',')];
  const ordered = [...rows]
    .filter((r) => r.status !== 'overwritten' && !(r.status === 'effective' && r.rawAtEvent === '0'))
    .sort((a, b) => a.effectiveAt - b.effectiveAt);
  for (const r of ordered) {
    const kind = `${KIND_LABEL[r.kind] ?? r.kind}${r.splitLabel ? ` ${r.splitLabel}` : ''}`;
    const note = [
      ...(opts.demo ? ['DEMO FIXTURE, not on-chain data'] : []),
      r.status === 'pending' ? `pending ${kind}` : kind,
      `raw_at_event: ${r.rawAtEventSource}`,
      ...r.notes,
    ].join('; ');
    lines.push(
      [
        new Date(r.effectiveAt * 1000).toISOString(),
        r.status === 'pending' ? 'pending' : (r.effectiveBlock ?? ''),
        r.token.issuer,
        r.token.symbol,
        r.token.address,
        r.rawAtEvent,
        r.oldMultiplier,
        r.newMultiplier,
        r.deltaShareEq,
        r.estUsd === null ? null : r.estUsd.toFixed(2),
        note,
      ]
        .map(cell)
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
