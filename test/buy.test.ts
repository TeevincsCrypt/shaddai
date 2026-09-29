import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Web3Wallet } from '@binance-web3/wallet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAddress, type Address } from 'viem';
import { BUY_COPY, BuyError, prepareBuy, quoteShareTrueBuy, submitBuy, USDC_BSC, USDT_BSC } from '../src/core/buy.js';
import { BinanceWeb3Api, TradeApiError, type BuiltSwap } from '../src/core/trade-api.js';
import { DEMO_ADDRESS, DEMO_RFQ_SPENDER, DEMO_USDT, demoMarks, demoRwa } from '../src/fixtures/demo.js';
import { FakeTradeApi } from '../src/fixtures/fake-trade-api.js';
import { createApp } from '../src/server/app.js';
import { demoContext } from '../src/server/context.js';

const NOW = Date.UTC(2026, 8, 29, 16) / 1000;
const sym = (q: { wrappers: { token: { symbol: string; address: Address } }[] }, a: Address | null) =>
  q.wrappers.find((w) => w.token.address === a)?.token.symbol;

describe('share-true quote (demo)', () => {
  it('ranks wrappers by share-equivalents, not token count', async () => {
    const q = await quoteShareTrueBuy(demoContext(NOW), { ticker: 'AAPL', usd: 100 });
    expect(q.wrappers.map((w) => [w.token.symbol, w.status])).toEqual([
      ['AAPLB', 'ok'],
      ['AAPLon', 'ok'],
    ]);
    expect(sym(q, q.rawCountPick)).toBe('AAPLB');
    expect(sym(q, q.best)).toBe('AAPLon');
    expect(q.notes.join(' ')).toContain('Counting tokens would pick AAPLB; counting shares picks AAPLon.');
    const b = q.wrappers[0]!;
    // share-eq = raw × factor, using the on-chain factor
    expect(Number(b.shareEqOut)).toBeCloseTo(Number(b.rawOut) * 1.000604, 12);
    expect(b.factorSource).toBe('uiMultiplier');
    expect(b.targetRawSource).toBe('fromUIAmount');
    expect(b.referenceSource).toBe('binance-rwa');
    expect(b.impactSource).toBe('measured');
    expect(b.impactPct!).toBeLessThan(1);
    expect(q.wrappers[1]!.factorSource).toBe('sValue');
    expect(q.payIn).toMatchObject({
      symbol: 'USDT',
      address: USDT_BSC,
      decimals: 18,
      amountRaw: '100000000000000000000',
    });
  });

  it('hard-refuses a thin book', async () => {
    const q = await quoteShareTrueBuy(demoContext(NOW), { ticker: 'XMPL', usd: 1000 });
    expect(q.wrappers[0]!.status).toBe('refused');
    expect(q.wrappers[0]!.reasons[0]).toMatch(/^Thin book: a \$1000 ticket moves the price 1\.\d\d% \(limit 1%\)\.$/);
    expect(q.best).toBeNull();
    // The same wrapper passes with a small ticket.
    const small = await quoteShareTrueBuy(demoContext(NOW), { ticker: 'XMPLB', usd: 50 });
    expect(small.wrappers[0]!.status).toBe('ok');
  });

  it('never quotes a wrapper whose factor was not read', async () => {
    const ctx = demoContext(NOW);
    ctx.ondoOracle = null;
    const q = await quoteShareTrueBuy(ctx, { ticker: 'NVDA', usd: 100 });
    const on = q.wrappers.find((w) => w.token.symbol === 'NVDAon')!;
    expect(on).toMatchObject({ status: 'refused', reasons: [BUY_COPY.ondoUnread], shareEqOut: null, route: null });
    expect(sym(q, q.best)).toBe('NVDAB');
  });

  it('refuses a wrapper with no route and a ticket over the limit', async () => {
    const q = await quoteShareTrueBuy(demoContext(NOW), { ticker: 'TSLA', usd: 20 });
    expect(q.wrappers.find((w) => w.token.symbol === 'TSLAon')!.reasons).toEqual([BUY_COPY.noRoute]);
    await expect(quoteShareTrueBuy(demoContext(NOW), { ticker: 'TSLA', usd: 1e6 })).rejects.toThrow(/limit of \$5000/);
    await expect(quoteShareTrueBuy(demoContext(NOW), { ticker: 'ZZZZ', usd: 5 })).rejects.toThrow(
      /no tokenized wrapper/,
    );
  });

  it('refuses when depth cannot be measured', async () => {
    const ctx = demoContext(NOW);
    const api = ctx.buy!.api as FakeTradeApi;
    const orig = api.quote.bind(api);
    let n = 0;
    api.quote = async (p) => {
      if (n++ % 2 === 1) throw new Error('min order size'); // every probe fails
      return orig(p);
    };
    const q = await quoteShareTrueBuy(ctx, { ticker: 'MSFTB', usd: 100 });
    expect(q.wrappers[0]!.reasons).toEqual([BUY_COPY.depthUnknown]);
  });

  it('does not invent a USD1 address', async () => {
    await expect(quoteShareTrueBuy(demoContext(NOW), { ticker: 'NVDA', usd: 10, payIn: 'USD1' })).rejects.toThrow(
      'USD1: token search found no BSC contract',
    );
    // A search hit that is not USD1 on chain is rejected.
    const ctx = demoContext(NOW);
    ctx.buy!.api = new FakeTradeApi({
      marks: demoMarks().marks,
      rwa: demoRwa(),
      spender: DEMO_RFQ_SPENDER,
      stable: [DEMO_USDT],
      search: [{ address: DEMO_USDT, symbol: 'USD1', decimals: 18 }],
    });
    await expect(quoteShareTrueBuy(ctx, { ticker: 'NVDA', usd: 10, payIn: 'USD1' })).rejects.toThrow(
      /does not answer symbol\(\) = "USD1" on BSC \(it says "USDT"\)/,
    );
  });
});

describe('prepare and submit (demo)', () => {
  const nvdab = getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436');

  it('asks for an exact approve first, checked and simulated', async () => {
    const r = await prepareBuy(demoContext(NOW), { token: nvdab, usd: 50, wallet: DEMO_ADDRESS });
    expect(r.step).toBe('approve');
    if (r.step !== 'approve') return;
    expect(r.approve.tx).toMatchObject({ from: DEMO_ADDRESS, to: DEMO_USDT, value: '0' });
    expect(r.approve.spender).toBe(DEMO_RFQ_SPENDER);
    expect(r.approve.amountRaw).toBe('50000000000000000000');
    expect(r.approve.simulation!.allowanceChanges[0]).toMatchObject({ post: '50000000000000000000', pre: '0' });
  });

  it('then returns an EIP-712 order that names the wallet and the token', async () => {
    const r = await prepareBuy(demoContext(NOW), {
      token: nvdab,
      usd: 50,
      wallet: DEMO_ADDRESS,
      demoSkipAllowance: true,
    });
    expect(r.step).toBe('sign');
    if (r.step !== 'sign') return;
    expect(r.order.checks.every((c) => c.ok)).toBe(true);
    expect(JSON.parse(r.order.typedData).message.maker).toBe(DEMO_ADDRESS);
    expect(r.note).toBe(BUY_COPY.rfqNote);
  });

  it('refuses an order that pays someone else', async () => {
    const ctx = demoContext(NOW);
    const api = ctx.buy!.api as FakeTradeApi;
    const orig = api.buildSwap.bind(api);
    api.buildSwap = async (p): Promise<BuiltSwap> => {
      const b = await orig({ ...p, wallet: getAddress('0x000000000000000000000000000000000000dead') });
      return b;
    };
    const r = await prepareBuy(ctx, { token: nvdab, usd: 50, wallet: DEMO_ADDRESS, demoSkipAllowance: true });
    expect(r.step).toBe('refused');
    if (r.step === 'refused') expect(r.reasons[0]).toContain('does not name your wallet');
  });

  it('refuses approve calldata for a different spender', async () => {
    const ctx = demoContext(NOW);
    const api = ctx.buy!.api as FakeTradeApi;
    const orig = api.approveTx.bind(api);
    api.approveTx = async (p) => ({
      ...(await orig(p)),
      spender: getAddress('0x000000000000000000000000000000000000beef'),
    });
    const quoteRoutes = api.quote.bind(api);
    api.quote = async (p) => (await quoteRoutes(p)).map((r) => ({ ...r, approveTarget: null }));
    await expect(prepareBuy(ctx, { token: nvdab, usd: 50, wallet: DEMO_ADDRESS })).rejects.toThrow(
      /Approve calldata does not match/,
    );
  });

  it('never submits in demo mode', async () => {
    await expect(
      submitBuy(demoContext(NOW), {
        requestId: '3b241101-e2bb-4255-8caf-4136c566a962',
        signature: `0x${'11'.repeat(65)}`,
        vendor: 'DemoRFQ',
        quoteId: 'demo000001',
      }),
    ).rejects.toThrow(BuyError);
  });
});

describe('Binance Web3 API adapter (official connector, local server)', () => {
  const SECRET = 'test-secret';
  let server: Server;
  let base: string;
  const seen: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] =
    [];
  let reply: (url: string) => unknown = () => ({ code: 0, data: [] });

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let body = '';
      for await (const c of req) body += c;
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(reply(req.url!)));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/build`;
  });
  afterAll(() => server.close());

  const api = () => new BinanceWeb3Api({ apiKey: 'test-key', apiSecret: SECRET, basePath: base });

  it('signs timestamp + method + path?query + body with HMAC-SHA256', async () => {
    reply = () => ({
      code: 0,
      success: true,
      data: [
        {
          quoteId: 'q1',
          vendorName: 'PcsXRfq',
          fromTokenAmount: '5000000000000000000',
          toTokenAmount: '21600000000000000',
          priceImpactPercent: '0.12',
          executionMode: 'RFQ',
          approveTarget: '0x000000000022d473030f116ddee9f6b43ac78ba3',
          isBest: true,
        },
      ],
    });
    const routes = await api().quote({
      from: USDT_BSC,
      to: getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436'),
      amount: 5n * 10n ** 18n,
      wallet: DEMO_ADDRESS,
    });
    expect(routes[0]).toMatchObject({
      quoteId: 'q1',
      toAmount: 21600000000000000n,
      priceImpactPercent: 0.12,
      executionMode: 'RFQ',
    });
    const req = seen.at(-1)!;
    expect(req.method).toBe('GET');
    expect(req.url.startsWith('/build/api/v1/dex/aggregator/quote?')).toBe(true);
    expect(req.headers['x-oc-apikey']).toBe('test-key');
    const ts = String(req.headers['x-oc-timestamp']);
    const expected = createHmac('sha256', SECRET).update(`${ts}GET${req.url}${req.body}`).digest('base64');
    expect(req.headers['x-oc-sign']).toBe(expected);
    const q = new URL(req.url, 'http://x').searchParams;
    expect(q.get('binanceChainId')).toBe('56');
    expect(q.get('amount')).toBe('5000000000000000000');
    expect(q.get('userWalletAddress')).toBe(DEMO_ADDRESS);
  });

  it('treats a non-zero business code as an error', async () => {
    reply = () => ({ code: 40001, msg: 'PARAM_ERROR', success: false, data: null });
    await expect(api().rwaTokens()).rejects.toThrow(TradeApiError);
    await expect(api().rwaTokens()).rejects.toThrow('RWA token list: PARAM_ERROR (code 40001)');
  });

  it('reads the RFQ order from /swap and signs POST bodies', async () => {
    reply = (url) =>
      url.includes('/aggregator/swap')
        ? {
            code: 0,
            data: {
              executionMode: 'RFQ',
              tx: null,
              rfq: { vendor: 'PcsXRfq', txType: 'EIP712', typedDataToSign: '{"a":1}', signingScheme: 'eip712' },
            },
          }
        : { code: 0, data: { orderId: 'o1', status: 'PENDING_VENDOR', createdAt: 1 } };
    const built = await api().buildSwap({
      from: USDT_BSC,
      to: getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436'),
      amount: 1n,
      wallet: DEMO_ADDRESS,
      quoteId: 'q1',
      slippagePercent: '0.5',
    });
    expect(built.rfq).toMatchObject({ vendor: 'PcsXRfq', typedDataToSign: '{"a":1}', orderId: null });
    const sub = await api().submitOrder({
      requestId: '3b241101-e2bb-4255-8caf-4136c566a962',
      userSignature: `0x${'11'.repeat(65)}`,
      vendor: 'PcsXRfq',
      quoteId: 'q1',
    });
    expect(sub).toEqual({ orderId: 'o1', status: 'PENDING_VENDOR' });
    const req = seen.at(-1)!;
    expect(req.method).toBe('POST');
    const ts = String(req.headers['x-oc-timestamp']);
    expect(req.headers['x-oc-sign']).toBe(
      createHmac('sha256', SECRET).update(`${ts}POST${req.url}${req.body}`).digest('base64'),
    );
  });

  it('sends the same requests as the official connector', async () => {
    reply = () => ({ code: 0, data: [] });
    const sdk = new Web3Wallet({ configurationRestAPI: { apiKey: 'test-key', apiSecret: SECRET, basePath: base } })
      .restAPI as unknown as Record<string, (p: object) => Promise<unknown>>;
    const ours = api();
    const W = DEMO_ADDRESS;
    const B = getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436');
    const pairs: [string, () => Promise<unknown>, () => Promise<unknown>][] = [
      ['rwa', () => sdk.getRwaTokenList!({ binanceChainId: '56' }), () => ours.rwaTokens()],
      [
        'quote',
        () =>
          sdk.getAggregatedQuote!({
            binanceChainId: '56',
            amount: '5',
            fromTokenAddress: USDT_BSC,
            toTokenAddress: B,
            userWalletAddress: W,
          }),
        () => ours.quote({ from: USDT_BSC, to: B, amount: 5n, wallet: W }),
      ],
      [
        'approve',
        () =>
          sdk.getErc20ApproveTransaction!({
            binanceChainId: '56',
            tokenContractAddress: USDT_BSC,
            approveAmount: '5',
            vendor: 'PcsXRfq',
          }),
        () => ours.approveTx({ token: USDT_BSC, amount: 5n, vendor: 'PcsXRfq' }),
      ],
      [
        'swap',
        () =>
          sdk.buildSwapTransaction!({
            binanceChainId: '56',
            amount: '5',
            fromTokenAddress: USDT_BSC,
            toTokenAddress: B,
            userWalletAddress: W,
            quoteId: 'q1',
            slippagePercent: '0.5',
          }),
        () => ours.buildSwap({ from: USDT_BSC, to: B, amount: 5n, wallet: W, quoteId: 'q1', slippagePercent: '0.5' }),
      ],
      [
        'submit',
        () =>
          sdk.submitRfqOrder!({
            requestId: 'r1',
            userSignature: '0xab',
            vendor: 'PcsXRfq',
            quoteId: 'q1',
            signingScheme: 'eip712',
          }),
        () =>
          ours.submitOrder({
            requestId: 'r1',
            userSignature: '0xab',
            vendor: 'PcsXRfq',
            quoteId: 'q1',
            signingScheme: 'eip712',
          }),
      ],
      ['status', () => sdk.getRfqOrderStatus!({ orderId: 'o1' }), () => ours.orderStatus('o1')],
      ['search', () => sdk.searchToken!({ chains: '56', search: 'USD1' }), () => ours.searchToken('USD1')],
      ['defi', () => sdk.getDeFiPositions!({ addresses: [W], binanceChainIds: ['56'] }), () => ours.defiPositions(W)],
    ];
    const shape = (r: (typeof seen)[number]) => {
      const u = new URL(r.url, 'http://x');
      return {
        method: r.method,
        path: u.pathname,
        query: [...u.searchParams].sort(),
        body: r.method === 'POST' ? JSON.parse(r.body) : null,
        signed:
          r.headers['x-oc-sign'] ===
          createHmac('sha256', SECRET)
            .update(`${r.headers['x-oc-timestamp']}${r.method}${r.url}${r.body}`)
            .digest('base64'),
      };
    };
    for (const [name, a, b] of pairs) {
      const i = seen.length;
      await a().catch(() => undefined);
      await b().catch(() => undefined);
      expect(seen.length - i, name).toBe(2);
      expect(shape(seen[i + 1]!), name).toEqual(shape(seen[i]!));
      expect(shape(seen[i + 1]!).signed, name).toBe(true);
    }
    // The connector refuses an EVM-only simulate; ours sends the same evmTx body.
    const tx = { from: W, to: USDT_BSC, value: '0', data: '0x095ea7b3' as const };
    await expect(sdk.simulateTransactions!({ binanceChainId: '56', evmTx: tx })).rejects.toThrow(/solTx/);
    const i = seen.length;
    await ours.simulate(tx).catch(() => undefined);
    expect(shape(seen[i]!)).toMatchObject({
      method: 'POST',
      path: '/build/api/v1/dex/pre-transaction/simulate',
      body: { binanceChainId: '56', evmTx: tx },
      signed: true,
    });
  });

  it('keeps the error message the connector drops', async () => {
    reply = () => ({ code: 40401, msg: 'QUOTE_EXPIRED', success: false, data: null });
    const sdk = new Web3Wallet({ configurationRestAPI: { apiKey: 'k', apiSecret: SECRET, basePath: base } }).restAPI;
    const res = await sdk.getRfqOrderStatus({ orderId: 'o1' });
    expect(await res.data()).toBeNull(); // code and msg are gone
    await expect(api().orderStatus('o1')).rejects.toThrow('Order status: QUOTE_EXPIRED (code 40401)');
  });
});

describe('/api/buy routes', () => {
  const ctx = demoContext(NOW);
  const app = createApp({ mode: 'demo', live: () => ctx, demo: () => ctx });
  const post = (path: string, body: object) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('lists tickers and limits', async () => {
    const r = (await (await app.request('/api/buy/config')).json()) as {
      enabled: boolean;
      tickers: { ticker: string; wrappers: { symbol: string }[] }[];
    };
    expect(r.enabled).toBe(true);
    expect(r.tickers.find((t) => t.ticker === 'NVDA')!.wrappers.map((w) => w.symbol)).toEqual(['NVDAB', 'NVDAon']);
  });

  it('quotes, prepares, and refuses to submit in demo', async () => {
    const q = await app.request('/api/buy/quote?ticker=NVDA&usd=40');
    expect(q.status).toBe(200);
    expect(((await q.json()) as { best: string }).best).toBe(getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436'));
    const bad = await app.request('/api/buy/quote?ticker=NVDA&usd=-1');
    expect(bad.status).toBe(400);
    const prep = await post('/api/buy/prepare', {
      token: '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436',
      usd: 40,
      wallet: DEMO_ADDRESS,
    });
    expect(((await prep.json()) as { step: string }).step).toBe('approve');
    const sub = await post('/api/buy/submit', {
      requestId: '3b241101-e2bb-4255-8caf-4136c566a962',
      signature: `0x${'11'.repeat(65)}`,
      vendor: 'DemoRFQ',
      quoteId: 'x',
    });
    expect(sub.status).toBe(422);
  });

  it('answers 503 when no trade API is configured', async () => {
    const bare = { ...ctx, mode: 'live' as const, buy: undefined };
    const live = createApp({ mode: 'live', live: () => bare, demo: () => ctx });
    const r = await live.request('/api/buy/quote?ticker=NVDA&usd=5');
    expect(r.status).toBe(503);
    expect(((await r.json()) as { error: string }).error).toContain('BINANCE_WEB3_API_KEY');
  });
});

describe('compliance refusals (code 40304)', () => {
  const compliance = () =>
    new TradeApiError('Quote: Service not available due to compliance restriction (code 40304)', 40304);

  it('refuses each wrapper once, with one clear note', async () => {
    const ctx = demoContext(NOW);
    (ctx.buy!.api as FakeTradeApi).quote = async () => {
      throw compliance();
    };
    const q = await quoteShareTrueBuy(ctx, { ticker: 'NVDA', usd: 5 });
    expect(q.wrappers.map((w) => w.reasons)).toEqual([[BUY_COPY.compliance], [BUY_COPY.compliance]]);
    expect(q.notes.join(' ')).toContain('/api/buy/diagnose');
    expect(q.notes.join(' ')).not.toContain('Nothing to buy');
  });

  it('diagnose tells a location or account block from an equity-only block', async () => {
    const ctx = demoContext(NOW);
    const api = ctx.buy!.api as FakeTradeApi;
    const orig = api.quote.bind(api);
    api.quote = async (p) => {
      if (p.to !== USDC_BSC) throw compliance();
      return orig(p);
    };
    const app = createApp({ mode: 'demo', live: () => ctx, demo: () => ctx });
    const d = (await (await app.request('/api/buy/diagnose')).json()) as {
      steps: { name: string; ok: boolean; code: number }[];
      reading: string;
    };
    expect(d.steps.map((s) => s.ok)).toEqual([true, true, true, false]);
    expect(d.steps[3]!.code).toBe(40304);
    expect(d.reading).toMatch(/^Only the equity-token quote is refused/);

    const all = demoContext(NOW);
    all.buy!.api = new FakeTradeApi({
      marks: demoMarks().marks,
      rwa: demoRwa(),
      spender: DEMO_RFQ_SPENDER,
      stable: [DEMO_USDT],
      fail: { rwaTokens: compliance(), searchToken: compliance(), quote: compliance() },
    });
    const app2 = createApp({ mode: 'demo', live: () => all, demo: () => all });
    const d2 = (await (await app2.request('/api/buy/diagnose')).json()) as { reading: string };
    expect(d2.reading).toMatch(/^Every call is refused/);
  });
});
