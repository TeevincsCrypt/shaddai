import { describe, expect, it } from 'vitest';
import {
  classifyChange,
  decimalString,
  fmtAmount,
  fmtMultiplier,
  isNearOne,
  ONE,
  toUI,
  uiPrice,
} from '../src/core/units.js';

const u = (s: string) => {
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * ONE + BigInt((f + '0'.repeat(18)).slice(0, 18));
};

describe('unit math', () => {
  it('scales raw by the multiplier and floors', () => {
    expect(toUI(u('10'), u('1.0017'))).toBe(u('10.017'));
    expect(toUI(1n, u('1.5'))).toBe(1n); // 1.5 wei floors to 1
  });

  it('renders exact decimals without float drift', () => {
    expect(decimalString(u('10.017'), 18)).toBe('10.017');
    expect(decimalString(0n, 18)).toBe('0');
    expect(decimalString(-u('0.5'), 18)).toBe('-0.5');
    expect(decimalString(123n, 0)).toBe('123');
  });

  it('formats for copy with rounding', () => {
    expect(fmtAmount(u('12.4211'), 18)).toBe('12.4211');
    expect(fmtAmount(u('12.42108'), 18)).toBe('12.4211');
    expect(fmtAmount(u('12.4'), 18)).toBe('12.40');
    expect(fmtAmount(u('0.00004'), 18)).toBe('0.00');
    expect(fmtMultiplier(u('1.000604'))).toBe('1.000604×');
    expect(fmtMultiplier(ONE)).toBe('1.0000×');
  });

  it('converts a raw-token price to a per-share price', () => {
    expect(uiPrice(230.79168, u('1.0017'))).toBeCloseTo(230.4, 6);
    expect(uiPrice(100, u('2'))).toBe(50);
  });

  it('detects near-one multipliers', () => {
    expect(isNearOne(u('1.0099'))).toBe(true);
    expect(isNearOne(u('1.0101'))).toBe(false);
    expect(isNearOne(u('0.995'), 50)).toBe(true);
  });
});

describe('classifyChange', () => {
  it('treats the 0 -> 1e18 initialisation as init', () => {
    expect(classifyChange(0n, ONE).kind).toBe('init');
  });
  it('labels dividend-scale ticks', () => {
    expect(classifyChange(ONE, u('1.000604')).kind).toBe('dividend-reinvest');
    expect(classifyChange(u('1.00085'), u('1.0017')).kind).toBe('dividend-reinvest');
    expect(classifyChange(ONE, u('0.998')).kind).toBe('adjustment-down');
    expect(classifyChange(ONE, ONE).kind).toBe('no-change');
  });
  it('labels splits by their nearest simple ratio', () => {
    expect(classifyChange(ONE, u('2'))).toMatchObject({ kind: 'split', splitLabel: '2-for-1' });
    expect(classifyChange(u('1.004'), u('2.008'))).toMatchObject({ kind: 'split', splitLabel: '2-for-1' });
    expect(classifyChange(ONE, u('1.5'))).toMatchObject({ kind: 'split', splitLabel: '3-for-2' });
    expect(classifyChange(ONE, u('10'))).toMatchObject({ kind: 'split', splitLabel: '10-for-1' });
  });
  it('labels reverse splits', () => {
    expect(classifyChange(ONE, u('0.1'))).toMatchObject({ kind: 'reverse-split', splitLabel: '1-for-10' });
    expect(classifyChange(u('2'), ONE)).toMatchObject({ kind: 'reverse-split', splitLabel: '1-for-2' });
  });
  it('calls anything else between 1% and a clean ratio a large adjustment', () => {
    expect(classifyChange(ONE, u('1.037')).kind).toBe('large-adjustment');
  });
});
