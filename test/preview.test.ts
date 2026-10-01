import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import { buildPreview, PREVIEW_COPY } from '../src/core/preview.js';
import { scanAddress } from '../src/core/scan.js';
import { flattenDefi } from '../src/core/trade-api.js';
import { DEMO_ADDRESS, DEMO_RFQ_SPENDER, DEMO_USDT, demoDefi, demoMarks, demoRwa } from '../src/fixtures/demo.js';
import { FakeTradeApi } from '../src/fixtures/fake-trade-api.js';
import { createApp } from '../src/server/app.js';
import { demoContext } from '../src/server/context.js';

const NOW = Date.UTC(2026, 8, 29, 16) / 1000;
const NVDAB = getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436');

describe('pre-action collateral preview (demo)', async () => {
  const ctx = demoContext(NOW);
  const scan = await scanAddress(ctx, DEMO_ADDRESS);
  const p = await buildPreview(ctx, scan);
  const item = (sym: string, label: RegExp) => p.items.find((i) => i.token.symbol === sym && label.test(i.label))!;

  it('states the flip in the brief’s words, with the stale-reference warning', () => {
    const m = item('MSFTB', /^Wallet$/);
    expect(m.flip).toMatchObject({ multiplier: '1.00202', shareEqAfter: '4.00808', kind: 'dividend-reinvest' });
    expect(m.lines[0]).toBe(
      'Multiplier flips at 2026-10-01 13:30 UTC (1× → 1.00202×). Raw stays 4. Share-eq becomes 4.008 (now 4).',
    );
    expect(m.gap).toMatchObject({ nowShares: '0', afterShares: '0.00808' });
    expect(m.staleReference).toBe(true);
    expect(m.lines.at(-1)).toMatch(
      /^Cash market shut \(.*\): the reference price is stale until .*\. Do not treat this preview as a tradable premium\.$/,
    );
    expect(m.severity).toBe('watch');
    expect(p.notes).toContain(PREVIEW_COPY.stale);
  });

  it('shows both oracle cases when the basis is unknown, and alerts on a split-sized gap', () => {
    const x = item('XMPLB', /Lista/);
    expect(x.severity).toBe('alert');
    expect(x.gap!.nowShares).toBe('30.24');
    expect(x.lines.join(' ')).toContain(
      "If Lista's oracle is share-priced and the market counts raw, the gap today is 30.24 share-eq",
    );
    expect(x.lines.join(' ')).toContain('If it prices one raw token, there is none.');
    expect(item('NVDAB', /Venus/).lines.join(' ')).toContain('Today the two cannot be told apart.');
  });

  it('treats a borrow as debt and a 1.0 token as gap-free', () => {
    expect(item('NVDAB', /0004/).lines.join(' ')).toContain('in the debt it records');
    expect(item('TSLAB', /Wallet → Venus/).lines.join(' ')).toContain(
      'which equals the share-eq while the multiplier is 1.0',
    );
  });

  it('cross-checks the Binance DeFi API against the chain', () => {
    const venus = p.defi.checks.find((c) => c.protocol === 'Venus')!;
    expect(venus).toMatchObject({ matches: 'raw', apiAmount: '12.4', healthFactor: '2.41' });
    expect(p.defi.checks.find((c) => c.side === 'borrow')!.matches).toBe('raw');
    expect(p.defi.unscanned.map((u) => `${u.tokenRef.symbol}@${u.protocolName}`)).toEqual([
      'AAPLB@Demo Vault (fictional)',
    ]);
  });

  it('recognises an API that reports share units, and one that sees a position the chain does not', async () => {
    const c2 = demoContext(NOW);
    c2.buy!.api = new FakeTradeApi({
      marks: demoMarks().marks,
      rwa: demoRwa(NOW),
      spender: DEMO_RFQ_SPENDER,
      stable: [DEMO_USDT],
      defi: [
        { ...demoDefi()[0]!, amount: '12.42108' },
        {
          ...demoDefi()[0]!,
          token: getAddress('0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A'),
          symbol: 'AAPLB',
          amount: '3',
        },
      ],
    });
    const q = await buildPreview(c2, await scanAddress(c2, DEMO_ADDRESS));
    expect(q.defi.checks.map((c) => [c.token.symbol, c.matches])).toEqual([
      ['NVDAB', 'share-eq'],
      ['AAPLB', 'not-found-on-chain'],
    ]);
  });

  it('works without the Binance API and says what it skipped', async () => {
    const bare = { ...demoContext(NOW), buy: undefined };
    const q = await buildPreview(bare, scan);
    expect(q.items.length).toBe(p.items.length);
    expect(q.market.status).toBe('not-configured');
    expect(q.defi.status).toBe('not-configured');
    expect(q.items.every((i) => !i.staleReference)).toBe(true);
  });

  it('previews a pending split on collateral and in a pool', async () => {
    const r = structuredClone(scan);
    const xmplb = r.tokens.find((t) => t.symbol === 'XMPLB')!.address;
    const aaplb = r.tokens.find((t) => t.symbol === 'AAPLB')!.address;
    r.units[xmplb]!.pending = {
      multiplier: '4.016',
      effectiveAt: NOW + 3600,
      kind: 'split',
      splitLabel: '2-for-1',
      ratio: '2',
    };
    r.units[aaplb]!.pending = {
      multiplier: '1.001208',
      effectiveAt: NOW + 3600,
      kind: 'dividend-reinvest',
      ratio: '1.000604',
    };
    const q = await buildPreview(ctx, r);
    const x = q.items.find((i) => i.token.symbol === 'XMPLB' && /Lista/.test(i.label))!;
    expect(x.flip!.shareEqAfter).toBe('120.48');
    expect(x.lines[0]).toContain('2-for-1). Raw stays 30. Share-eq becomes 120.48 (now 60.24).');
    expect(x.gap!.afterShares).toBe('90.48');
    expect(x.severity).toBe('alert');
    const lp = q.items.find((i) => i.side === 'lp')!;
    expect(lp.lines.join(' ')).toContain('arbitrage takes that from LPs');
  });

  it('parses the nested DeFi response shape', () => {
    const flat = flattenDefi({
      addressList: [
        {
          address: DEMO_ADDRESS,
          protocolList: [
            {
              binanceChainId: '56',
              defiProtocolId: 'venus',
              protocolName: 'Venus',
              poolList: [
                {
                  poolType: 'Lending',
                  poolCa: '0xeb8c7d7d9b1a3b6d5ec7c0a6d1c7e3d0b1e0d371',
                  positionCollectionList: [
                    {
                      positionCollectionDetail: { healthFactor: '1.9' },
                      positionList: [
                        {
                          tokenList: {
                            supply: [
                              {
                                tokenAddress: NVDAB.toLowerCase(),
                                tokenSymbol: 'NVDAB',
                                tokenAmount: '1.5',
                                tokenPrice: '230.4',
                              },
                            ],
                            borrow: [{ tokenAddress: DEMO_USDT, tokenSymbol: 'USDT', tokenAmount: '100' }],
                          },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(flat.map((d) => [d.symbol, d.side, d.amount, d.healthFactor])).toEqual([
      ['NVDAB', 'supply', '1.5', '1.9'],
      ['USDT', 'borrow', '100', '1.9'],
    ]);
    expect(flat[0]!.token).toBe(NVDAB);
  });

  it('is served at /api/preview', async () => {
    const app = createApp({ mode: 'demo', live: () => ctx, demo: () => ctx });
    const res = await app.request('/api/preview?address=demo');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { items: unknown[] }).items.length).toBe(p.items.length);
    expect((await app.request('/api/preview?address=nope')).status).toBe(400);
  });
});
