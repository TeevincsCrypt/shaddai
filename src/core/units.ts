/**
 * Unit math. Everything that touches balances or multipliers stays in bigint.
 *
 *   UI        = raw * uiMultiplier / 1e18
 *   raw       = UI * 1e18 / uiMultiplier   (lossy; never invert for accounting)
 *   UI price  = rawPrice * 1e18 / uiMultiplier
 */

export const ONE = 10n ** 18n;

/** Multipliers are 18-decimal fixed point; 1e18 = 1.0x. */
export function toUI(raw: bigint, multiplier: bigint): bigint {
  return (raw * multiplier) / ONE;
}

/** Price per share-equivalent, given a price per raw token. */
export function uiPrice(rawPrice: number, multiplier: bigint): number {
  return rawPrice / fixedToNumber(multiplier, 18);
}

export function fixedToNumber(v: bigint, decimals: number): number {
  // Split to keep precision for large integers.
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = v % base;
  return Number(whole) + Number(frac) / Number(base);
}

/** Exact decimal rendering, trailing zeros trimmed: 10017000000000000000n, 18 -> "10.017". */
export function decimalString(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0') : '';
  frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export function multiplierString(m: bigint): string {
  return decimalString(m, 18);
}

/** new / old as 18-decimal fixed point. */
export function ratio(oldM: bigint, newM: bigint): bigint {
  if (oldM === 0n) return 0n;
  return (newM * ONE) / oldM;
}

/** |m - 1| <= tolBps basis points. */
export function isNearOne(m: bigint, tolBps = 100): boolean {
  const diff = m > ONE ? m - ONE : ONE - m;
  return diff * 10_000n <= ONE * BigInt(tolBps);
}

export type ChangeKind =
  'init' | 'no-change' | 'dividend-reinvest' | 'adjustment-down' | 'large-adjustment' | 'split' | 'reverse-split';

export interface ChangeClass {
  kind: ChangeKind;
  /** new/old as decimal string. */
  ratio: string;
  /** Present for split / reverse-split, e.g. "2-for-1". */
  splitLabel?: string;
}

/** Threshold between a dividend-scale tick and a corporate action (Ondo uses the same 1%). */
export const SMALL_CHANGE_BPS = 100;

const SPLIT_TOLERANCE_BPS = 50n;

function nearestSimpleRatio(r: bigint): { num: number; den: number } | null {
  // r is new/old (1e18 fixed). Search num/den with small integers.
  let best: { num: number; den: number; err: bigint } | null = null;
  for (let den = 1; den <= 4; den++) {
    for (let num = 1; num <= 50; num++) {
      if (num === den) continue;
      const target = (BigInt(num) * ONE) / BigInt(den);
      const err = r > target ? r - target : target - r;
      if (err * 10_000n <= target * SPLIT_TOLERANCE_BPS) {
        if (!best || err < best.err) best = { num, den, err };
      }
    }
  }
  // Also catch reverse splits like 1-for-10 / 1-for-20 (den up to 50).
  if (!best && r < ONE) {
    for (let den = 2; den <= 50; den++) {
      for (let num = 1; num <= 4; num++) {
        if (num >= den) continue;
        const target = (BigInt(num) * ONE) / BigInt(den);
        const err = r > target ? r - target : target - r;
        if (err * 10_000n <= target * SPLIT_TOLERANCE_BPS) {
          if (!best || err < best.err) best = { num, den, err };
        }
      }
    }
  }
  return best ? { num: best.num, den: best.den } : null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function classifyChange(oldM: bigint, newM: bigint): ChangeClass {
  if (oldM === 0n) return { kind: 'init', ratio: '0' };
  const r = ratio(oldM, newM);
  const ratioStr = multiplierString(r);
  if (newM === oldM) return { kind: 'no-change', ratio: ratioStr };
  if (isNearOne(r, SMALL_CHANGE_BPS)) {
    return { kind: newM > oldM ? 'dividend-reinvest' : 'adjustment-down', ratio: ratioStr };
  }
  const simple = nearestSimpleRatio(r);
  if (simple) {
    const g = gcd(simple.num, simple.den);
    const label = `${simple.num / g}-for-${simple.den / g}`;
    return { kind: r > ONE ? 'split' : 'reverse-split', ratio: ratioStr, splitLabel: label };
  }
  return { kind: 'large-adjustment', ratio: ratioStr };
}

export function absBig(v: bigint): bigint {
  return v < 0n ? -v : v;
}

export function minBig(...v: bigint[]): bigint {
  return v.reduce((a, b) => (b < a ? b : a));
}

export function maxBig(...v: bigint[]): bigint {
  return v.reduce((a, b) => (b > a ? b : a));
}

/** Human rendering for copy: rounds to `maxFrac` decimals, trims zeros, keeps at least `minFrac`. */
export function fmtAmount(v: bigint, decimals: number, maxFrac = 4, minFrac = 2): string {
  const s = decimalString(v, decimals);
  const [w, f = ''] = s.split('.');
  if (f.length <= maxFrac) return `${w}.${f.padEnd(minFrac, '0')}`.replace(/\.$/, '');
  // round half up at maxFrac
  const scale = 10n ** BigInt(decimals - maxFrac);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const rounded = ((abs + scale / 2n) / scale) * scale;
  const r = decimalString(neg ? -rounded : rounded, decimals);
  const [rw, rf = ''] = r.split('.');
  return `${rw}.${rf.padEnd(minFrac, '0')}`.replace(/\.$/, '');
}

export function fmtMultiplier(m: bigint, maxFrac = 8): string {
  return `${fmtAmount(m, 18, maxFrac, 4)}×`;
}

/** Plausible multiplier window: 0.000001x .. 1,000,000x. Outside it we assume a mis-decoded read. */
export function isPlausibleMultiplier(m: bigint): boolean {
  return m >= 10n ** 12n && m <= 10n ** 24n;
}
