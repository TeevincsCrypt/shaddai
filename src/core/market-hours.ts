/**
 * US cash session by the clock: Monday to Friday, 09:30 to 16:00 America/New_York.
 * Exchange holidays are not known here; the RWA Data API's market status covers
 * them when a key is configured, and callers say which source they used.
 */

const NY = 'America/New_York';
const OPEN_MIN = 9 * 60 + 30;
const CLOSE_MIN = 16 * 60;

interface NyParts {
  year: number;
  month: number;
  day: number;
  weekday: number; // 0 = Sunday
  minutes: number; // minutes since local midnight
}

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  weekday: 'short',
  hour: 'numeric',
  minute: 'numeric',
  hourCycle: 'h23',
});
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function nyParts(ms: number): NyParts {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    weekday: WEEKDAYS.indexOf(p.weekday!),
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

/** UTC instant of a New York wall-clock time (handles EST/EDT). */
export function nyToUtc(year: number, month: number, day: number, minutes: number): number {
  const guess = Date.UTC(year, month - 1, day, 0, minutes);
  // Offset = how far New York's wall clock is from UTC at that instant; apply twice to settle across a DST change.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = nyParts(t);
    const wall = Date.UTC(p.year, p.month - 1, p.day, 0, p.minutes);
    t = guess - (wall - t);
  }
  return t;
}

export interface CashSession {
  open: boolean;
  reason: 'open' | 'weekend' | 'before-open' | 'after-close';
  /** Next 09:30 New York on a weekday, as Unix ms. Holidays not considered. */
  nextOpenMs: number;
}

export function usCashSession(nowMs: number): CashSession {
  const p = nyParts(nowMs);
  const weekend = p.weekday === 0 || p.weekday === 6;
  const open = !weekend && p.minutes >= OPEN_MIN && p.minutes < CLOSE_MIN;
  const reason: CashSession['reason'] = weekend
    ? 'weekend'
    : open
      ? 'open'
      : p.minutes < OPEN_MIN
        ? 'before-open'
        : 'after-close';
  // Walk forward day by day (calendar arithmetic on the New York date) to the next weekday open.
  let next = 0;
  for (let i = 0; i < 8 && !next; i++) {
    const day = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const at = nyToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), OPEN_MIN);
    if (at > nowMs) next = at;
  }
  return { open, reason, nextOpenMs: next };
}
