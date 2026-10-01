import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { DIVIDEND_COPY, DividendError, dividendAnswer } from '../src/core/dividend.js';
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
