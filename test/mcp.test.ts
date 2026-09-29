import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_ADDRESS } from '../src/fixtures/demo.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createApp } from '../src/server/app.js';
import { demoContext } from '../src/server/context.js';

const NOW = Date.UTC(2026, 8, 29, 16) / 1000;
const ctx = demoContext(NOW);
const deps = { mode: 'demo' as const, live: () => ctx, demo: () => ctx };

type TextResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const text = (r: unknown) => (r as TextResult).content.map((c) => c.text).join('\n');

describe('MCP tools (in-memory client)', () => {
  const client = new Client({ name: 'test', version: '0' });
  beforeAll(async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(deps).connect(a);
    await client.connect(b);
  });
  afterAll(() => client.close());

  it('lists the share-true tools with dotted titles', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'sharetrue_collateral',
      'sharetrue_explain',
      'sharetrue_ledger',
      'sharetrue_portfolio',
    ]);
    expect(tools.find((t) => t.name === 'sharetrue_portfolio')!.title).toBe('sharetrue.portfolio');
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it('portfolio reports raw and share-equivalents, never raw as shares', async () => {
    const r = (await client.callTool({ name: 'sharetrue_portfolio', arguments: { address: 'demo' } })) as TextResult;
    const t = text(r);
    expect(t).toContain('DEMO FIXTURE');
    expect(t).toMatch(/NVDAB \(bStocks, NVDA\) · Wallet: raw 10 · multiplier 1\.0017× · share-eq 10\.017/);
    expect(t).toMatch(/NVDAon .*sValue 1\.0021× · share-eq 5\.0105/);
    expect(t).toMatch(/GOOGLB .*raw <0\.000001 .*\(dust\)/);
    expect(t).toContain('Pending: MSFTB 1× → 1.00202× at 2026-10-01 13:30 UTC.');
    const rows = r.structuredContent!.rows as { token: { symbol: string }; shareEq: string | null }[];
    expect(rows.find((x) => x.token.symbol === 'AAPLB')!.shareEq).toBe('10.00604');
  });

  it('ledger filters by ticker and carries a CSV', async () => {
    const r = (await client.callTool({
      name: 'sharetrue_ledger',
      arguments: { address: DEMO_ADDRESS, ticker: 'AAPL' },
    })) as TextResult;
    const s = r.structuredContent as { status: string; rows: { token: { ticker: string } }[]; csv: string };
    expect(s.status).toBe('ready');
    expect(s.rows.length).toBeGreaterThan(0);
    expect(s.rows.every((x) => x.token.ticker === 'AAPL')).toBe(true);
    expect(s.csv.split('\n')[0]).toContain('date,block,issuer,symbol,contract,raw_at_event');
    expect(text(r)).toContain('dividend-reinvest [effective] 1× → 1.000604×');
  });

  it('collateral names the protocol and the side', async () => {
    const t = text(await client.callTool({ name: 'sharetrue_collateral', arguments: { address: 'demo' } }));
    expect(t).toMatch(/NVDAB · Venus .*\(collateral\)/);
    expect(t).toMatch(/NVDAB · Lista .*\(borrow\)/);
  });

  it('explain accepts a ticker or a wrapper symbol', async () => {
    const a = text(await client.callTool({ name: 'sharetrue_explain', arguments: { ticker: 'nvda' } }));
    const b = text(await client.callTool({ name: 'sharetrue_explain', arguments: { ticker: 'NVDAon' } }));
    expect(a).toContain('NVDAB (bStocks)');
    expect(a).toContain('NVDAon (Ondo)');
    expect(a).toContain('not the listed share');
    expect(b.split('\n')[0]).toBe(a.split('\n')[0]);
    const x = text(await client.callTool({ name: 'sharetrue_explain', arguments: { ticker: 'ZZZZ' } }));
    expect(x).toContain('not in Shaddai');
  });

  it('rejects a bad address as a tool error, not a crash', async () => {
    const r = (await client.callTool({ name: 'sharetrue_portfolio', arguments: { address: '0x12' } })) as TextResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('is not a BSC address');
  });

  it('adds quoteBuy only when a quote provider is wired', async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: 'test', version: '0' });
    await createMcpServer({
      ...deps,
      quoteBuy: async (_c, t, usd) => ({ text: `${t} ${usd}`, data: { t, usd } }),
    }).connect(a);
    await c2.connect(b);
    const { tools } = await c2.listTools();
    expect(tools.map((t) => t.name)).toContain('sharetrue_quoteBuy');
    expect(text(await c2.callTool({ name: 'sharetrue_quoteBuy', arguments: { ticker: 'AAPL', usd: 50 } }))).toBe(
      'AAPL 50',
    );
    await c2.close();
  });
});

describe('MCP over HTTP (/api/mcp, stateless)', () => {
  const app = createApp(deps);
  const rpc = (body: object) =>
    app.request('/api/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
    });

  it('initializes and calls a tool without a session', async () => {
    const init = await rpc({
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'curl', version: '0' } },
    });
    expect(init.status).toBe(200);
    expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe(
      'shaddai',
    );

    const res = await rpc({
      method: 'tools/call',
      params: { name: 'sharetrue_explain', arguments: { ticker: 'AAPL' } },
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { result: TextResult };
    expect(text(out.result)).toContain('AAPLB (bStocks)');
  });

  it('refuses GET', async () => {
    expect((await app.request('/api/mcp')).status).toBe(405);
  });
});
