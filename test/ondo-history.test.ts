import { describe, expect, it } from 'vitest';
import { getAddress, parseUnits } from 'viem';
import { ondoHistoryNotices } from '../src/core/ledger.js';
import type { LedgerRow } from '../src/core/types.js';

const A = getAddress('0xA9eE28C80f960B889dFbd1902055218cBa016F75');
const row = (old: string, next: string, at: number): LedgerRow =>
  ({
    token: { symbol: 'NVDAon', address: A },
    eventLayout: 'ondo-svalue',
    status: 'effective',
    oldMultiplier: old,
    newMultiplier: next,
    effectiveAt: at,
  }) as unknown as LedgerRow;

describe('Ondo history coverage notices', () => {
  const held = [{ symbol: 'NVDAon', address: A, mult: parseUnits('1.0017152487959898', 18) }];

  it('flags a first recorded update that already starts above 1.0 (mainnet NVDAon, 4 Jun 2026)', () => {
    const rows = [
      row('1.000932054247057497', '1.0017152487959898', 1790637058),
      row('1.000116946998962534', '1.000932054247057497', 1780531551),
    ];
    expect(ondoHistoryNotices(rows, held, 'the index start (2026-05-01)')).toEqual([
      'NVDAon: the first Ondo update in this index (2026-06-04) starts from sValue 1.000116946998962534, so earlier changes, before the index start (2026-05-01), are not listed.',
    ]);
  });

  it('says nothing when history starts at 1.0, and flags a factor above 1.0 with no updates', () => {
    expect(ondoHistoryNotices([row('1', '1.0009', 1780531551)], held, 'x')).toEqual([]);
    expect(ondoHistoryNotices([], held, 'the index start (2026-05-01)')[0]).toMatch(
      /^NVDAon: sValue is 1\.0017152487959898 but this index holds no update for it/,
    );
    expect(ondoHistoryNotices([], [{ ...held[0]!, mult: 10n ** 18n }], 'x')).toEqual([]);
  });
});
