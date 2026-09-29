/** Display helpers. Inputs are exact decimal strings from the API; rounding happens only here. */

function roundDecimalString(s: string, maxFrac: number): string {
  const neg = s.startsWith('-');
  const abs = neg ? s.slice(1) : s;
  const [w = '0', f = ''] = abs.split('.');
  if (f.length <= maxFrac) return `${neg ? '-' : ''}${w}${f ? `.${f}` : ''}`;
  const digits = BigInt(w + f.slice(0, maxFrac));
  const bump = Number(f[maxFrac]) >= 5 ? 1n : 0n;
  const r = (digits + bump).toString().padStart(maxFrac + 1, '0');
  const rw = r.slice(0, r.length - maxFrac) || '0';
  const rf = maxFrac ? r.slice(-maxFrac) : '';
  return `${neg ? '-' : ''}${rw}${rf ? `.${rf}` : ''}`;
}

function group(w: string): string {
  return w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "10.017" -> "10.017000" (fixed places, grouped). */
export function amount(s: string | null | undefined, places = 6): string {
  if (s === null || s === undefined) return '—';
  const r = roundDecimalString(s, places);
  const neg = r.startsWith('-');
  const [w = '0', f = ''] = (neg ? r.slice(1) : r).split('.');
  return `${neg ? '−' : ''}${group(w)}${places ? `.${f.padEnd(places, '0')}` : ''}`;
}

/** Trim trailing zeros but keep at least `min` places. */
export function amountTrim(s: string | null | undefined, max = 8, min = 2): string {
  if (s === null || s === undefined) return '—';
  const r = roundDecimalString(s, max);
  const neg = r.startsWith('-');
  const [w = '0', f = ''] = (neg ? r.slice(1) : r).split('.');
  const frac = f.replace(/0+$/, '').padEnd(min, '0');
  return `${neg ? '−' : ''}${group(w)}${frac ? `.${frac}` : ''}`;
}

export function mult(s: string | null | undefined): string {
  if (s === null || s === undefined) return '—';
  return `${amountTrim(s, 8, 4)}×`;
}

export function usd(n: number | null | undefined, cents = true): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) > 0 && Math.abs(n) < 0.01) return n < 0 ? '−<$0.01' : '<$0.01';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  });
}

export function price(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: n < 10 ? 4 : 2,
  });
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function date(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function dateTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })} ${d.toISOString().slice(11, 16)} UTC`;
}

export function countdown(ts: number, now = Date.now() / 1000): string {
  let s = Math.max(0, Math.round(ts - now));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  if (d > 0) return `in ${d}d ${h}h`;
  if (h > 0) return `in ${h}h ${m}m`;
  return m > 0 ? `in ${m}m` : 'any moment';
}

export function pct(ratio: string): string {
  const r = Number(ratio);
  if (!Number.isFinite(r)) return '—';
  const p = (r - 1) * 100;
  const sign = p > 0 ? '+' : p < 0 ? '−' : '';
  return `${sign}${Math.abs(p).toFixed(Math.abs(p) < 1 ? 4 : 2)}%`;
}

export const KIND_LABEL: Record<string, string> = {
  'dividend-reinvest': 'Dividend reinvest',
  'adjustment-down': 'Adjustment down',
  'large-adjustment': 'Large adjustment',
  split: 'Split',
  'reverse-split': 'Reverse split',
  'no-change': 'No change',
  init: 'Initialised',
};

export function bscscan(kind: 'token' | 'address' | 'tx' | 'block', v: string): string {
  return `https://bscscan.com/${kind}/${v}`;
}
