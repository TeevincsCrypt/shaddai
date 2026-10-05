import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { answerFor, DIVIDEND_COPY, DividendError, dividendAnswer } from '../src/core/dividend.js';
import type { LedgerRow, TokenRef } from '../src/core/types.js';
import { DEMO_ADDRESS } from '../src/fixtures/demo.js';
import { createApp } from '../src/server/app.js';
import { demoContext } from '../src/server/context.js';

const NOW = Date.UTC(2026, 8, 29, 16) / 1000;
const STRANGER = getAddress('0x2222222222222222222222222222222222222222');

describe('did I get the dividend? (demo)', () => {
  it('answers a real ledger hit in plain English', async () => {
    const a = await dividendAnswer(demoContext(NOW), DEMO_ADDRESS, 'AAPL');
    expect(a.status).toBe('hit');
    expect(a.card).toBe(
      'AAPLB paid on 14 Aug 2026, block 70548000. Raw stayed 10.000000. Multiplier went 1.0000× → 1.000604×. ' +
        "You gained 0.006040 Apple-equivalents, about $1.38 at today's price, after typical 30% US withholding. " +
        'No Transfer event. A tax export that only reads transfers will miss this. ' +
        'That covers the wallet; the 5.000000 raw AAPLB held through PancakeSwap V2 (AAPLB/USDT LP) today is not in it ' +
        '(protocol positions are not read at past blocks). ' +
        DIVIDEND_COPY.withholding,
    );
    const b = a.wrappers.find((w) => w.token.symbol === 'AAPLB')!;
    expect(b.event).toMatchObject({
      kind: 'dividend-reinvest',
      block: '70548000',
      rawAtEvent: '10',
      deltaShareEq: '0.00604',
      factor: 'multiplier',
    });
  });

  it('reads Ondo sValue changes the same way', async () => {
    const a = await dividendAnswer(demoContext(NOW), DEMO_ADDRESS, 'NVDAon');
    expect(a.wrappers).toHaveLength(1);
    expect(a.card).toMatch(
      /^NVDAon paid on 11 Sept? 2026, block 73773600\. Raw stayed 5\.000000\. Ondo sValue went 1\.0009× → 1\.0021×\. You gained 0\.006000 NVIDIA-equivalents/,
    );
  });

  it('says so when no change touches the holder, and does not invent one', async () => {
    const a = await dividendAnswer(demoContext(NOW), DEMO_ADDRESS, 'TSLA');
    expect(a.status).toBe('miss');
    expect(a.card).toBe(`${DIVIDEND_COPY.miss} The index holds no TSLAB multiplier change for this address.`);
    expect(a.wrappers.every((w) => w.event === null)).toBe(true);
  });

  it('says when the address held none at the event block', async () => {
    const a = await dividendAnswer(demoContext(NOW), STRANGER, 'AAPLB');
    expect(a.status).toBe('not-held');
    expect(a.card).toBe(
      `${DIVIDEND_COPY.miss} AAPLB changed its multiplier 1.0000× → 1.000604× on 14 Aug 2026 (block 70548000), but this address held no AAPLB at that block.`,
    );
  });

  it('does not call a protocol holder a miss (mainnet Lista borrower, NVDAB, 10 Sep 2026)', () => {
    const t = { symbol: 'NVDAB', ticker: 'NVDA', name: 'NVIDIA', issuer: 'bStocks' } as TokenRef;
    const row = {
      token: t,
      status: 'effective',
      kind: 'dividend-reinvest',
      effectiveAt: 1_788_998_400,
      effectiveBlock: '120970451',
      eventLayout: 'bep677-3',
      oldMultiplier: '1',
      newMultiplier: '1.000778223752807865',
      rawAtEvent: '0',
      rawAtEventSource: 'archive',
      deltaShareEq: '0',
      estUsd: 0,
      notes: [],
    } as unknown as LedgerRow;
    const a = answerFor(
      t,
      [row],
      [
        { label: 'Lista (Market 0xaa1b…d8b1)', raw: '659.86631133' },
        { label: 'Lista (Market 0x3bcf…dce8)', raw: '240' },
      ],
    );
    expect(a.status).toBe('protocol');
    expect(a.sentence).toBe(
      'NVDAB changed its multiplier 1.0000× → 1.00077822× on 10 Sept 2026 (block 120970451). This address held no NVDAB ' +
        'in its wallet at that block, but it holds 899.866311 raw NVDAB through Lista (Market 0xaa1b…d8b1), Lista (Market ' +
        '0x3bcf…dce8) today. Shaddai does not read protocol positions at past blocks, so whether that position was in for ' +
        'this change is not read. If it was, the change added about 0.700297 NVIDIA-equivalents to it, with no Transfer event.',
    );
    expect(a.sentence).not.toContain(DIVIDEND_COPY.miss);
  });

  it('gives a split no USD and no withholding line', async () => {
    const a = await dividendAnswer(demoContext(NOW), DEMO_ADDRESS, 'XMPL');
    expect(a.card).toContain('a split changes the share count, not the value, so there is no USD credit.');
    expect(a.card).not.toContain('withholding');
  });

  it('shows dust instead of rounding it to zero', async () => {
    const a = await dividendAnswer(demoContext(NOW), DEMO_ADDRESS, 'GOOGL');
    const g = a.wrappers.find((w) => w.token.symbol === 'GOOGLB')!;
    expect(a.card).not.toContain('Raw stayed 0.000000.');
    expect(a.card).toContain(`Raw stayed ${g.event!.rawAtEvent}.`);
  });

  it('refuses an unknown ticker; serves the route and the MCP tool shape', async () => {
    await expect(dividendAnswer(demoContext(NOW), DEMO_ADDRESS, 'ZZZZ')).rejects.toThrow(DividendError);
    const ctx = demoContext(NOW);
    const app = createApp({ mode: 'demo', live: () => ctx, demo: () => ctx });
    const r = await app.request(`/api/dividend?address=demo&ticker=AAPL`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { status: string }).status).toBe('hit');
    expect((await app.request(`/api/dividend?address=demo&ticker=ZZZZ`)).status).toBe(404);
  });
});
