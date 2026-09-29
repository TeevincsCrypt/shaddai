import { describe, expect, it } from 'vitest';
import { CSV_COLUMNS, ledgerToCsv } from '../src/core/csv.js';
import { getFeed, scanAddress } from '../src/core/scan.js';
import { DEMO_ADDRESS } from '../src/fixtures/demo.js';
import { demoContext } from '../src/server/context.js';

// Fixed clock: 2026-09-29 16:00 UTC. The demo's pending MSFTB update lands 2 days later.
const NOW = Date.UTC(2026, 8, 29, 16) / 1000;

describe('demo scan (end to end on the fixture chain)', async () => {
  const ctx = demoContext(NOW);
  const r = await scanAddress(ctx, DEMO_ADDRESS);
  const row = (sym: string, kind = 'wallet') =>
    r.portfolio.rows.find((x) => x.token.symbol === sym && x.location.kind === kind);

  it('shows raw and share-equivalents side by side', () => {
    expect(row('NVDAB')).toMatchObject({
      raw: '10',
      shareEq: '10.017',
      multiplier: '1.0017',
      shareEqSource: 'balanceOfUI',
    });
    expect(row('AAPLB')).toMatchObject({ raw: '10', shareEq: '10.00604' });
    expect(row('TSLAB')).toMatchObject({ raw: '2.5', shareEq: '2.5', oneToOneNow: true });
    // 1.0 but with a pending update is not "1:1 right now".
    expect(row('MSFTB')!.oneToOneNow).toBe(false);
  });

  it('prices per share without double counting', () => {
    const n = row('NVDAB')!;
    expect(n.price!.shareUsd).toBeCloseTo(230.4, 6);
    // raw x raw price == share-eq x share price
    expect(n.positionUsd!).toBeCloseTo(10.017 * 230.4, 6);
  });

  it('uses Ondo sValue when the token has no wallet multiplier', () => {
    const o = row('NVDAon')!;
    expect(o).toMatchObject({ raw: '5', shareEq: '5.0105', shareEqSource: 'sValue' });
    expect(r.units[o.token.address]!.kind).toBe('ondo-svalue');
  });

  it('hides dust behind the flag', () => {
    expect(row('GOOGLB')!.dust).toBe(true);
  });

  it('adds protocol positions to the portfolio', () => {
    expect(row('NVDAB', 'venus')).toMatchObject({ raw: '12.4', shareEq: '12.42108' });
    expect(row('XMPLB', 'lista')).toMatchObject({ raw: '30', shareEq: '60.24' });
    expect(row('AAPLB', 'lp')).toMatchObject({ raw: '5' });
  });

  it('builds the ledger from multiplier events with no transfer', () => {
    expect(r.ledger.status).toBe('ready');
    const aapl = r.ledger.rows.find((l) => l.token.symbol === 'AAPLB')!;
    expect(aapl).toMatchObject({
      kind: 'dividend-reinvest',
      status: 'effective',
      oldMultiplier: '1',
      newMultiplier: '1.000604',
      rawAtEvent: '10',
      rawAtEventSource: 'archive',
      deltaShareEq: '0.00604',
    });
    expect(aapl.estUsd!).toBeCloseTo(0.00604 * 228.5, 6);
    expect(aapl.notes).toContain('Net of typical 30% US withholding. Not tax advice.');
    expect(aapl.notes).toContain('No Transfer event. Tax exporters will miss this.');

    const split = r.ledger.rows.find((l) => l.token.symbol === 'XMPLB' && l.kind === 'split')!;
    expect(split).toMatchObject({ splitLabel: '2-for-1', rawAtEvent: '10', deltaShareEq: '10.04', estUsd: null });

    const pending = r.ledger.rows.filter((l) => l.status === 'pending');
    expect(pending.map((p) => p.token.symbol)).toEqual(['MSFTB']);
    expect(pending[0]).toMatchObject({ newMultiplier: '1.00202', deltaShareEq: '0.00808' });
    expect(r.ledger.rows.some((l) => l.status === 'overwritten' && l.newMultiplier === '1.0021')).toBe(true);
  });

  it('fires collateral warnings with the right severity', () => {
    const venus = r.collateral.positions.find((p) => p.protocol === 'Venus')!;
    expect(venus.severity).toBe('info');
    expect(venus.lines[1]).toBe('Venus reads the ERC-20 balance, not balanceOfUI.');
    expect(venus.lines[2]).toBe('Current raw: 12.40 · multiplier: 1.0017× · share-eq: 12.4211.');
    expect(venus.oracle?.basis).toBe('indistinguishable');
    expect(venus.enteredAsCollateral).toBe(true);

    const lista = r.collateral.positions.find((p) => p.protocol === 'Lista')!;
    expect(lista).toMatchObject({ severity: 'alert', hasBorrow: true });
    expect(r.collateral.positions[0]!.severity).toBe('alert');
  });

  it('reads Lista lending and borrowing, not only collateral', () => {
    const lend = r.collateral.positions.find((p) => p.protocol === 'Lista' && p.side === 'lend')!;
    expect(lend).toMatchObject({ raw: '2', shareEq: '2.0034', severity: 'info' });
    expect(row('NVDAB', 'lista')).toMatchObject({ raw: '2', shareEq: '2.0034' });
    expect(row('NVDAB', 'lista')!.location.label).toMatch(/^Lista · lent · Market/);

    const borrow = r.collateral.positions.find((p) => p.side === 'borrow')!;
    expect(borrow).toMatchObject({ protocol: 'Lista', raw: '0.5', shareEq: '0.50085', hasBorrow: true });
    expect(borrow.lines.join(' ')).toMatch(/a borrower pays the reinvested dividend/);
    // A debt is not a holding: no portfolio row, no ledger exposure note.
    expect(
      r.portfolio.rows
        .filter((x) => x.token.symbol === 'NVDAB')
        .map((x) => x.raw)
        .sort(),
    ).toEqual(['10', '12.4', '2']);
  });

  it('exports the CSV with the brief’s columns and skips overwritten schedules', () => {
    const csv = ledgerToCsv(r.ledger.rows, { demo: true });
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(1 + r.ledger.rows.filter((l) => l.status !== 'overwritten').length);
    expect(csv).toContain('DEMO FIXTURE, not on-chain data');
    expect(csv).not.toContain('1.0021,');
    expect(lines.at(-1)).toMatch(/,pending,bStocks,MSFTB,/);
  });

  it('reports a clean run', () => {
    expect(r.warnings).toEqual([]);
    expect(r.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('serves the global feed', async () => {
    const f = await getFeed(ctx);
    expect(f.status).toBe('ready');
    const real = f.events.filter((e) => e.kind !== 'init');
    expect(real.map((e) => e.token.symbol)).toContain('MUB');
  });
});

describe('same ledger without archive access', async () => {
  it('replays transfers and gets identical numbers', async () => {
    const ctx = demoContext(NOW);
    const { FakeChain } = await import('../src/fixtures/fake-chain.js');
    const { buildDemoScenario } = await import('../src/fixtures/demo.js');
    const { Chain } = await import('../src/core/chain.js');
    const { FeedIndexer } = await import('../src/core/events.js');
    const { MemoryKV } = await import('../src/core/cache.js');
    const fake = new FakeChain({ ...buildDemoScenario(NOW), archive: false, maxLogRange: 2_000_000n });
    const chain = new Chain(fake, { logChunk: 2_000_000 });
    const pruned = {
      ...ctx,
      chain,
      feed: new FeedIndexer(chain, ctx.tokens, new MemoryKV(), async () => fake.blockAt(Date.UTC(2026, 4, 1) / 1000)),
    };
    const a = await scanAddress(ctx, DEMO_ADDRESS);
    const b = await scanAddress(pruned, DEMO_ADDRESS);
    const pick = (rows: typeof a.ledger.rows) =>
      rows.map((x) => [x.id, x.rawAtEvent, x.deltaShareEq]).sort((p, q) => String(p[0]).localeCompare(String(q[0])));
    expect(pick(b.ledger.rows)).toEqual(pick(a.ledger.rows));
    expect(b.ledger.rows.filter((x) => x.status === 'effective').every((x) => x.rawAtEventSource === 'replay')).toBe(
      true,
    );
  });
});
