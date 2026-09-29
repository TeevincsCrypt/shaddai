/**
 * Shaddai as MCP tools. Default agents call balanceOf() and report raw tokens as
 * shares; these tools return both units, the events with no Transfer, and the
 * protocols that count raw units.
 *
 * Tool names use underscores (sharetrue_portfolio) because some clients, the
 * Claude API among them, reject dots; each tool's title is the dotted name.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isAddress } from 'viem';
import { z } from 'zod';
import { quoteShareTrueBuy, quoteText } from '../core/buy.js';
import { ledgerToCsv } from '../core/csv.js';
import { buildPreview, previewText } from '../core/preview.js';
import { probeTokens } from '../core/probe.js';
import { LINKS } from '../core/registry.js';
import { scanAddress, type ShaddaiContext } from '../core/scan.js';
import type { ScanResult } from '../core/types.js';
import { DEMO_ADDRESS } from '../fixtures/demo.js';

export interface McpDeps {
  mode: 'live' | 'demo';
  live: () => ShaddaiContext;
  demo: () => ShaddaiContext;
  /** Share-true buy quote; defaults to the Buy tab's quote (errors clearly when Buy is not configured). */
  quoteBuy?: (ctx: ShaddaiContext, ticker: string, usd: number) => Promise<{ text: string; data: unknown }>;
}

const DISCLAIMER =
  'Share-equivalents are not voting shares. Tokens are not the listed share. Estimates, not tax, legal or investment advice.';

const addressArg = z
  .string()
  .describe('BSC address (0x followed by 40 hex characters), or "demo" for the fixture address.');

function pick(deps: McpDeps, input: string): { ctx: ShaddaiContext; address: string } {
  const s = input.trim().toLowerCase();
  const address = s === 'demo' ? DEMO_ADDRESS : s;
  if (!isAddress(address, { strict: false })) {
    throw new Error(`"${input}" is not a BSC address. Pass 0x followed by 40 hex characters, or "demo".`);
  }
  const isDemo = deps.mode === 'demo' || address.toLowerCase() === DEMO_ADDRESS.toLowerCase();
  return { ctx: isDemo ? deps.demo() : deps.live(), address };
}

const num = (s: string | null, places = 6) => {
  if (s === null) return 'not read';
  const [w, f = ''] = s.split('.');
  if (!f) return w!;
  const cut = f.slice(0, places);
  // Dust: say it is below the shown precision rather than print zeros.
  if (w === '0' && /^0+$/.test(cut) && /[1-9]/.test(f)) return `<0.${'0'.repeat(places - 1)}1`;
  return `${w}.${cut}`;
};
const usd = (n: number | null) =>
  n === null ? 'no mark' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
const when = (ts: number) => `${new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

function header(r: ScanResult, what: string) {
  return `${what} for ${r.address} at BSC block ${r.block} (${when(r.blockTime)})${r.mode === 'demo' ? ' — DEMO FIXTURE, not on-chain data' : ''}.`;
}

export function portfolioText(r: ScanResult): string {
  const lines = [
    header(r, 'Share-true portfolio'),
    'Raw = what balanceOf() and most wallets show. Share-eq = raw × issuer multiplier.',
    '',
  ];
  if (!r.portfolio.rows.length) lines.push('No tracked tokenized stocks on this address.');
  for (const row of r.portfolio.rows) {
    const factor =
      row.multiplier === null
        ? 'factor not read'
        : `${row.token.issuer === 'Ondo' ? 'sValue' : 'multiplier'} ${num(row.multiplier, 8)}×`;
    lines.push(
      `${row.token.symbol} (${row.token.issuer}, ${row.token.ticker}) · ${row.location.label}: raw ${num(row.raw)} · ${factor} · share-eq ${num(row.shareEq)} · ${
        row.price?.shareUsd != null ? `${usd(row.price.shareUsd)}/share-eq` : 'no per-share mark'
      } · ${usd(row.positionUsd)}${row.dust ? ' (dust)' : ''}`,
    );
  }
  const pending = Object.values(r.units).filter((u) => u.pending);
  for (const u of pending) {
    const t = r.tokens.find((x) => x.address === u.token);
    lines.push(
      `Pending: ${t?.symbol ?? u.token} ${num(u.multiplier, 8)}× → ${num(u.pending!.multiplier, 8)}× at ${when(u.pending!.effectiveAt)}.`,
    );
  }
  for (const u of Object.values(r.units)) {
    if (u.unreadReason && r.portfolio.rows.some((x) => x.token.address === u.token)) {
      lines.push(`Note: ${r.tokens.find((x) => x.address === u.token)?.symbol}: ${u.unreadReason}`);
    }
  }
  lines.push(
    '',
    `Total marked value: ${usd(r.portfolio.totalUsd)} (${r.portfolio.pricedRows} of ${r.portfolio.rows.length} positions priced).`,
    DISCLAIMER,
  );
  return lines.join('\n');
}

export function ledgerText(r: ScanResult, ticker?: string): string {
  const lines = [
    header(r, 'Corporate-action ledger'),
    'Multiplier changes with no Transfer event. Tax exporters that read transfers miss these.',
    '',
  ];
  if (r.ledger.status !== 'ready') {
    lines.push(`Ledger ${r.ledger.status}${r.ledger.error ? `: ${r.ledger.error}` : ''}. Try again shortly.`);
    return lines.join('\n');
  }
  const rows = filterLedger(r, ticker);
  if (!rows.length)
    lines.push(
      ticker ? `No events for ${ticker} on this address.` : 'No multiplier events touched the tokens on this address.',
    );
  for (const e of rows) {
    lines.push(
      `${when(e.effectiveAt)} ${e.token.symbol} (${e.token.issuer}) ${e.kind}${e.splitLabel ? ` ${e.splitLabel}` : ''} [${e.status}] ${num(e.oldMultiplier, 8)}× → ${num(e.newMultiplier, 8)}× · raw held ${num(e.rawAtEvent)} (${e.rawAtEventSource}) · Δ share-eq ${num(e.deltaShareEq, 8)} · est ${usd(e.estUsd)}`,
    );
  }
  for (const n of r.ledger.notices ?? []) lines.push(`Notice: ${n}`);
  lines.push('', 'Dividend rows are net of typical 30% US withholding. USD at the current mark. Not tax advice.');
  return lines.join('\n');
}

function filterLedger(r: ScanResult, ticker?: string) {
  const t = ticker?.trim().toLowerCase();
  return r.ledger.rows.filter((e) => !t || e.token.ticker.toLowerCase() === t || e.token.symbol.toLowerCase() === t);
}

export function collateralText(r: ScanResult): string {
  const lines = [
    header(r, 'Collateral check'),
    'Venus, Lista and DEX pools count raw ERC-20 units, not balanceOfUI.',
    '',
  ];
  if (!r.collateral.positions.length)
    lines.push('No bStock, Ondo or xStock positions found in Venus, Lista or a V2 pool.');
  for (const p of r.collateral.positions) {
    lines.push(
      `[${p.severity.toUpperCase()}] ${p.token.symbol} · ${p.protocol} ${p.market.label} (${p.side}): ${p.lines.join(' ')}`,
    );
  }
  for (const l of r.collateral.listings) lines.push(`[INFO] ${l.lines.join(' ')}`);
  lines.push(
    '',
    ...r.checks
      .filter((c) => ['Venus', 'Lista', 'DEX LP (V2)'].includes(c.name))
      .map((c) => `Checked ${c.name}: ${c.status}, ${c.detail}`),
  );
  return lines.join('\n');
}

const ISSUER_NOTES = {
  bStocks:
    'bStocks (BEP-677 / ERC-8056): the multiplier lives on the token. share-eq = raw × uiMultiplier() / 1e18. Dividends are reinvested into the multiplier net of about 30% US withholding; splits change the same multiplier. Changes are scheduled minutes ahead and apply at effectiveAt.',
  Ondo: "Ondo Global Markets: a total-return tracker. The factor is sValue on Ondo's SyntheticSharesOracle, not on the token; the token has no uiMultiplier on BSC, so wallets cannot show the drift. The oracle pauses for large corporate actions.",
  xStocks:
    'xStocks: a tracker certificate with its own multiplier. No BSC contract is confirmed in this registry; Shaddai does not invent a display factor.',
} as const;

export async function explainText(ctx: ShaddaiContext, ticker: string): Promise<{ text: string; data: unknown }> {
  // Accept a ticker (NVDA) or a wrapper symbol (NVDAB, NVDAon).
  const q = ticker.trim().toUpperCase();
  const tickerKey = ctx.tokens.find((k) => k.symbol.toUpperCase() === q)?.ticker ?? q;
  const all = ctx.tokens.filter((k) => k.ticker === tickerKey);
  if (!all.length) {
    return {
      text: `${ticker}: not in Shaddai's registry. Tracked tickers: ${[...new Set(ctx.tokens.map((k) => k.ticker))].join(', ')}.`,
      data: { ticker, wrappers: [] },
    };
  }
  const head = await ctx.chain.blockNumber();
  const hdr = await ctx.chain.getBlock(head);
  const probes = await probeTokens(ctx.chain, all, null, head, hdr.timestamp, { ondoOracle: ctx.ondoOracle });
  const lines = [`${tickerKey}: ${all[0]!.name}. Wrappers on BSC and how each one counts shares.`, ''];
  const data = all.map((k) => {
    const u = probes.get(k.address)!.unit;
    const factor =
      u.multiplier === null
        ? `factor not read (${u.unreadReason ?? 'no multiplier'})`
        : `${k.issuer === 'Ondo' ? 'sValue' : 'uiMultiplier'} ${u.multiplier}×`;
    lines.push(
      `${k.symbol} (${k.issuer}) ${k.address}: ${factor}${u.pending ? `; pending ${u.pending.multiplier}× at ${when(u.pending.effectiveAt)}` : ''}.`,
    );
    return { symbol: k.symbol, issuer: k.issuer, address: k.address, unit: u };
  });
  lines.push('');
  for (const issuer of [...new Set(all.map((k) => k.issuer))]) {
    if (issuer in ISSUER_NOTES) lines.push(ISSUER_NOTES[issuer as keyof typeof ISSUER_NOTES]);
  }
  if (!all.some((k) => k.issuer === 'xStocks')) lines.push(ISSUER_NOTES.xStocks);
  lines.push(
    '',
    'Market hours and next open: not read here (needs the RWA Data API). Outside US cash hours a reference price is stale.',
    'Legal: these tokens are not the listed share and carry no voting rights. US persons are excluded from several of these products; Shaddai does not check eligibility. Not tax, legal or investment advice.',
    `Sources: ${LINKS.bstocks} · ${LINKS.bstocksProof} · ${LINKS.ondo} · ${LINKS.xstocks} · ${LINKS.bep677}`,
  );
  return { text: lines.join('\n'), data: { ticker: tickerKey, block: head.toString(), wrappers: data } };
}

const defaultQuoteBuy: NonNullable<McpDeps['quoteBuy']> = async (ctx, ticker, usd) => {
  const q = await quoteShareTrueBuy(ctx, { ticker, usd });
  return { text: quoteText(q), data: q };
};

const errorResult = (e: unknown) => ({
  isError: true,
  content: [{ type: 'text' as const, text: `Shaddai could not complete this: ${(e as Error).message}` }],
});

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'shaddai', version: '0.2.0' });
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    'sharetrue_portfolio',
    {
      title: 'sharetrue.portfolio',
      description:
        'Tokenized-stock holdings on a BSC address in BOTH units: raw tokens (what balanceOf and wallets show) and share-equivalents (raw × issuer multiplier or Ondo sValue), with per-share marks, USD value and pending multiplier changes. Use this instead of balanceOf for bStocks/Ondo/xStocks.',
      inputSchema: { address: addressArg },
      annotations: readOnly,
    },
    async ({ address }) => {
      try {
        const p = pick(deps, address);
        const r = await scanAddress(p.ctx, p.address);
        return {
          content: [{ type: 'text', text: portfolioText(r) }],
          structuredContent: {
            address: r.address,
            block: r.block,
            mode: r.mode,
            rows: r.portfolio.rows,
            totalUsd: r.portfolio.totalUsd,
          },
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'sharetrue_ledger',
    {
      title: 'sharetrue.ledger',
      description:
        'Corporate actions that changed the share count on a BSC address without any Transfer event: dividend reinvestments and splits applied through multipliers (bStocks) or sValue (Ondo). Each row has old→new factor, raw held before activation, Δ share-equivalents and an estimated USD value. Includes a CSV in the structured result.',
      inputSchema: {
        address: addressArg,
        ticker: z.string().optional().describe('Filter by ticker (NVDA) or symbol (NVDAB).'),
      },
      annotations: readOnly,
    },
    async ({ address, ticker }) => {
      try {
        const p = pick(deps, address);
        const r = await scanAddress(p.ctx, p.address, { ledgerBudgetMs: 45_000 });
        const rows = filterLedger(r, ticker);
        return {
          content: [{ type: 'text', text: ledgerText(r, ticker) }],
          structuredContent: {
            address: r.address,
            status: r.ledger.status,
            rows,
            csv: r.ledger.status === 'ready' ? ledgerToCsv(rows, { demo: r.mode === 'demo' }) : null,
          },
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'sharetrue_collateral',
    {
      title: 'sharetrue.collateral',
      description:
        'Whether tokenized stocks on a BSC address sit in Venus, Lista Lending (collateral, lent or borrowed) or a V2 LP, where the protocol counts raw ERC-20 units rather than share-equivalents. Returns Info/Watch/Alert warnings in plain English, plus a pre-action preview: when the next multiplier change lands, what raw and share-eq become, the gap a share-priced oracle would leave, whether the cash market is shut, and what the Binance DeFi API reports for the same positions.',
      inputSchema: { address: addressArg },
      annotations: readOnly,
    },
    async ({ address }) => {
      try {
        const p = pick(deps, address);
        const r = await scanAddress(p.ctx, p.address);
        const preview = await buildPreview(p.ctx, r).catch(() => null);
        return {
          content: [
            { type: 'text', text: preview ? `${collateralText(r)}\n\n${previewText(preview)}` : collateralText(r) },
          ],
          structuredContent: {
            address: r.address,
            positions: r.collateral.positions,
            listings: r.collateral.listings,
            preview,
          },
        };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    'sharetrue_explain',
    {
      title: 'sharetrue.explain',
      description:
        'One-page explainer for a ticker (e.g. NVDA, AAPL): which bStocks/Ondo/xStocks wrappers exist on BSC, where each keeps its share factor and its current value, how dividends and splits are applied, and the legal limits (not the listed share, no voting rights, not advice).',
      inputSchema: { ticker: z.string().describe('Ticker such as NVDA, or a wrapper symbol such as NVDAB or NVDAon.') },
      annotations: readOnly,
    },
    async ({ ticker }) => {
      try {
        const ctx = deps.mode === 'demo' ? deps.demo() : deps.live();
        const { text, data } = await explainText(ctx, ticker);
        return { content: [{ type: 'text', text }], structuredContent: data as Record<string, unknown> };
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  {
    const quoteBuy = deps.quoteBuy ?? defaultQuoteBuy;
    server.registerTool(
      'sharetrue_quoteBuy',
      {
        title: 'sharetrue.quoteBuy',
        description:
          'Quote a spot buy sized in DOLLARS OF SHARES, not tokens: for a ticker and a USD amount, compares each wrapper (bStocks/Ondo/xStocks) on share-equivalents received, refuses thin books, and returns the raw token amount to swap. Quote only; does not trade.',
        inputSchema: {
          ticker: z.string().describe('Ticker such as AAPL or NVDA.'),
          usd: z.number().positive().max(100_000).describe('Dollars to spend, e.g. 50.'),
        },
        annotations: readOnly,
      },
      async ({ ticker, usd: amount }) => {
        try {
          const ctx = deps.mode === 'demo' ? deps.demo() : deps.live();
          const { text, data } = await quoteBuy(ctx, ticker, amount);
          return { content: [{ type: 'text', text }], structuredContent: data as Record<string, unknown> };
        } catch (e) {
          return errorResult(e);
        }
      },
    );
  }

  return server;
}
