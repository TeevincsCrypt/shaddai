import { parseUnits } from 'viem';
import { describe, expect, it } from 'vitest';
import { FLIP_COPY, flipPreview, severityFor } from '../src/core/collateral.js';
import type { TokenProbe } from '../src/core/probe.js';
import { scanAddress } from '../src/core/scan.js';
import type { CollateralPosition } from '../src/core/types.js';
import { DEMO_ADDRESS } from '../src/fixtures/demo.js';
import { demoContext } from '../src/server/context.js';

const NOW = Date.UTC(2026, 8, 29, 16) / 1000;
const u = (v: string) => parseUnits(v, 18);

describe('pre-split collateral preview (demo)', async () => {
  const r = await scanAddress(demoContext(NOW), DEMO_ADDRESS);
  const pos = (sym: string, protocol: string, side: string) =>
    r.collateral.positions.find((p) => p.token.symbol === sym && p.protocol === protocol && p.side === side)!;

  it('shows three numbers when a multiplier change is scheduled on posted collateral', () => {
    const m = pos('MSFTB', 'Lista', 'collateral');
    expect(m.severity).toBe('watch'); // severity unchanged by the preview
    expect(m.flip).toMatchObject({
      status: 'scheduled',
      raw: '3',
      shareEqToday: '3',
      shareEqAfter: '3.00606',
      multiplierToday: '1',
      multiplierAfter: '1.00202',
      kind: 'dividend-reinvest',
    });
    // raw × per-share price × (old/new − 1): 3 × 512.30 × (1/1.00202 − 1)
    expect(m.flip!.deltaUsd!).toBeCloseTo(3 * 512.3 * (1 / 1.00202 - 1), 9);
    expect(m.flip!.line).toBe(
      "If the oracle is share-priced and the market reads raw balanceOf, collateral value moves by −$3.10. Confirm the market's oracle before you add borrow.",
    );
  });

  it('says "no scheduled multiplier" instead of a made-up preview', () => {
    const v = pos('NVDAB', 'Venus', 'collateral');
    expect(v.flip).toMatchObject({ status: 'none', shareEqAfter: null, deltaUsd: null, line: FLIP_COPY.none });
    expect(pos('NVDAB', 'Lista', 'lend').flip!.status).toBe('none');
  });

  it('leaves borrows and LP positions alone', () => {
    expect(pos('NVDAB', 'Lista', 'borrow').flip).toBeUndefined();
    expect(pos('AAPLB', 'PancakeSwap V2', 'lp').flip).toBeUndefined();
  });
});

describe('unread factors are not 1.0', () => {
  const unread = {
    mult: null,
    pendingMult: null,
    unit: { kind: 'none', decimals: 18, unreadReason: 'Ondo oracle not configured', pending: null, ondo: null },
  } as unknown as TokenProbe;
  const position = { protocol: 'Venus', side: 'collateral', raw: '5' } as CollateralPosition;

  it('gives no preview and says why', () => {
    expect(flipPreview(position, unread, undefined)).toMatchObject({
      status: 'unread',
      shareEqToday: null,
      line: 'Share factor unread (Ondo oracle not configured). No preview: Shaddai does not assume 1.0.',
    });
  });

  it('raises severity to watch instead of calling it near 1.0', () => {
    expect(severityFor(unread)).toEqual({
      severity: 'watch',
      reasons: ['Share factor unread (Ondo oracle not configured); drift cannot be sized.'],
    });
  });

  it('reports an Ondo oracle pause as unread after the flip', () => {
    const paused = {
      mult: u('1.0021'),
      pendingMult: null,
      unit: { kind: 'ondo-svalue', decimals: 18, pending: null, ondo: { paused: true } },
    } as unknown as TokenProbe;
    expect(flipPreview(position, paused, undefined)).toMatchObject({
      status: 'ondo-paused',
      shareEqToday: '5.0105',
      shareEqAfter: null,
      line: FLIP_COPY.paused,
    });
  });
});
