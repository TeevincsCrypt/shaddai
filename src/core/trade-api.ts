/**
 * The slice of the Binance Web3 API that the Buy flow uses, behind a small
 * interface so the demo and tests can swap in a fixture. Paths, parameter names
 * and signing follow the official connector (@binance-web3/wallet 12.3.1); a
 * parity test checks this client sends the same requests.
 *
 * Why not call the connector directly: its data() returns only the `data`
 * field, so business errors (HTTP 200 with a non-zero `code`, e.g. an expired
 * quote) arrive as null with the message dropped, and its simulate call refuses
 * an EVM-only request.
 *
 * Equity tokens (bStocks, Ondo) quote as either route type. SWAP: an
 * aggregator returns a transaction the wallet sends. RFQ: the user signs an
 * EIP-712 order, the API forwards it to a vendor, and the vendor settles.
 * The API docs say equity tokens always return RFQ; live BSC quotes have come
 * back as SWAP, so both paths are kept.
 */
import { createHmac } from 'node:crypto';
import { getAddress, type Address, type Hex } from 'viem';

export const BINANCE_BSC_CHAIN_ID = '56';

export interface RwaStatus {
  openState: boolean | null;
  marketStatus: string | null;
  reasonCode: string | null;
  reasonMsg: string | null;
  nextOpenTime: number | null;
}

export interface RwaToken {
  address: Address;
  symbol: string;
  platformId: string | null;
  underlyingTicker: string | null;
  /** Binance's own token-to-share ratio. Shown next to the on-chain factor, never used instead of it. */
  tokenToShareRatio: string | null;
  referencePrice: number | null;
  tokenPrice: number | null;
  status: RwaStatus | null;
}

export interface Route {
  quoteId: string;
  vendorName: string;
  fromAmount: bigint;
  toAmount: bigint;
  priceImpactPercent: number | null;
  executionMode: 'RFQ' | 'SWAP' | string;
  approveTarget: Address | null;
  isBest: boolean;
  tradeFeeUsd: number | null;
}

export interface EvmTx {
  from?: Address;
  to: Address;
  data: Hex;
  value: string;
  gas?: string;
}

export interface BuiltSwap {
  executionMode: string;
  tx: (EvmTx & { minReceiveAmount: string | null }) | null;
  rfq: {
    vendor: string;
    txType: string | null;
    typedDataToSign: string;
    signingScheme: string | null;
    /** Some responses carry an order id to submit with; the docs name it but the schema does not. */
    orderId: string | null;
  } | null;
}

export interface OrderStatus {
  orderId: string;
  status: string;
  txHash: Hex | null;
  fromAmount: string | null;
  toAmount: string | null;
}

/** One token line of a DeFi position, flattened from address → protocol → pool → collection → position. */
export interface DefiPosition {
  protocolId: string;
  protocolName: string;
  poolType: string;
  pool: Address | null;
  /** Lending collections only. */
  healthFactor: string | null;
  side: 'supply' | 'borrow';
  token: Address;
  symbol: string;
  /** Human-readable amount as the API reports it. Which unit (raw or share) is not documented. */
  amount: string;
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface Simulation {
  status: string;
  failReason: string | null;
  balanceChanges: { token: string; owner: string; change: string }[];
  allowanceChanges: { token: string; owner: string; spender: string; pre: string; post: string }[];
}

export interface TradeApi {
  readonly label: string;
  /** True for sources that can quote but not trade (the on-chain fallback). */
  readonly quoteOnly?: boolean;
  rwaTokens(): Promise<RwaToken[]>;
  quote(p: { from: Address; to: Address; amount: bigint; wallet?: Address }): Promise<Route[]>;
  approveTx(p: { token: Address; amount: bigint; vendor?: string }): Promise<{ tx: EvmTx; spender: Address }>;
  buildSwap(p: {
    from: Address;
    to: Address;
    amount: bigint;
    wallet: Address;
    quoteId: string;
    slippagePercent: string;
  }): Promise<BuiltSwap>;
  submitOrder(p: {
    requestId: string;
    userSignature: Hex;
    vendor: string;
    quoteId: string;
    signingScheme?: string;
  }): Promise<{ orderId: string; status: string }>;
  orderStatus(orderId: string): Promise<OrderStatus>;
  simulate(tx: EvmTx & { from: Address }): Promise<Simulation>;
  searchToken(symbol: string): Promise<{ address: Address; symbol: string; decimals: number | null }[]>;
  defiPositions(address: Address): Promise<DefiPosition[]>;
}

export class TradeApiError extends Error {
  /** Set when the API answered with a non-2xx status. */
  httpStatus?: number;
  /** From a Retry-After header on a 429. */
  retryAfterMs?: number;
  constructor(
    message: string,
    readonly code?: number | string,
  ) {
    super(message);
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const addr = (v: unknown): Address | null => {
  try {
    return typeof v === 'string' && v ? getAddress(v) : null;
  } catch {
    return null;
  }
};

interface Envelope<T> {
  code?: number | string;
  msg?: string;
  success?: boolean;
  data?: T;
}

/** A 200 response can still carry a business error: `code` non-zero or `success: false`. */
function unwrap<T>(body: Envelope<T>, what: string): T {
  const code = body.code === undefined ? 0 : Number(body.code);
  if (body.success === false || code !== 0) {
    throw new TradeApiError(`${what}: ${body.msg ?? 'error'} (code ${body.code})`, body.code);
  }
  if (body.data === undefined || body.data === null) throw new TradeApiError(`${what}: empty response`);
  return body.data;
}

export const BINANCE_WEB3_BASE = 'https://web3.binance.com/build';

/** Binance Web3 API with HMAC-signed requests. The key and secret stay on the server. */
export class BinanceWeb3Api implements TradeApi {
  readonly label = 'Binance Web3 API';
  private readonly base: string;

  constructor(
    private readonly opts: {
      apiKey: string;
      apiSecret: string;
      basePath?: string;
      timeoutMs?: number;
      fetchImpl?: typeof fetch;
      /** Waits before each retry of a rate-limited (HTTP 429) request. */
      retryDelaysMs?: number[];
    },
  ) {
    this.base = (opts.basePath ?? BINANCE_WEB3_BASE).replace(/\/$/, '');
  }

  /**
   * X-OC-SIGN = base64(HMAC-SHA256(secret, timestamp + METHOD + path?query + body)),
   * where path includes the base path ("/build") and timestamp is ISO-8601.
   */
  private async call<T>(
    what: string,
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    // A 429 means the request was turned away before it was processed, so it is safe to send again.
    const delays = this.opts.retryDelaysMs ?? [800, 2000];
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(what, method, path, params);
      } catch (e) {
        if (!(e instanceof TradeApiError) || e.httpStatus !== 429 || attempt >= delays.length) throw e;
        const hinted = e.retryAfterMs ?? 0;
        await new Promise((r) => setTimeout(r, Math.min(Math.max(delays[attempt]!, hinted), 5000)));
      }
    }
  }

  private async send<T>(
    what: string,
    method: 'GET' | 'POST',
    path: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const url = new URL(this.base + path);
    let body = '';
    if (method === 'GET') {
      for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    } else {
      body = JSON.stringify(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined)));
    }
    const timestamp = new Date().toISOString();
    const requestPath = url.pathname + url.search;
    const sign = createHmac('sha256', this.opts.apiSecret)
      .update(timestamp + method + requestPath + body, 'utf8')
      .digest('base64');
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(url, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'X-OC-APIKEY': this.opts.apiKey,
          'X-OC-TIMESTAMP': timestamp,
          'X-OC-SIGN': sign,
        },
        body: method === 'POST' ? body : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
    } catch (e) {
      // Node's fetch says only "fetch failed"; the reason (DNS, reset, TLS, timeout) is in `cause`.
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      const why = [cause?.code, cause?.message].filter(Boolean).join(': ');
      throw new TradeApiError(`${what}: network error (${(e as Error).message}${why ? ` — ${why}` : ''})`);
    }
    const text = await res.text();
    let parsed: Envelope<T> | null = null;
    try {
      parsed = JSON.parse(text) as Envelope<T>;
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = new TradeApiError(
        `${what}: HTTP ${res.status}${parsed?.msg ? ` ${parsed.msg}` : ''}`,
        parsed?.code ?? res.status,
      );
      err.httpStatus = res.status;
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
      throw err;
    }
    if (!parsed) throw new TradeApiError(`${what}: response is not JSON`);
    return unwrap(parsed, what);
  }

  async rwaTokens(): Promise<RwaToken[]> {
    const data = await this.call<Record<string, unknown>[]>('RWA token list', 'GET', '/api/v1/dex/market/rwa/tokens', {
      binanceChainId: BINANCE_BSC_CHAIN_ID,
    });
    return data.flatMap((t) => {
      const address = addr(t.tokenContractAddress);
      if (!address) return [];
      const s = (t.statusInfo ?? null) as Record<string, unknown> | null;
      return [
        {
          address,
          symbol: String(t.tokenSymbol ?? ''),
          platformId: str(t.platformId),
          underlyingTicker: str(t.underlyingTicker),
          tokenToShareRatio: str(t.tokenToShareRatio),
          referencePrice: num(t.referencePrice),
          tokenPrice: num(t.tokenPrice),
          status: s
            ? {
                openState: typeof s.openState === 'boolean' ? s.openState : null,
                marketStatus: str(s.marketStatus),
                reasonCode: str(s.reasonCode),
                reasonMsg: str(s.reasonMsg),
                nextOpenTime: num(s.nextOpenTime),
              }
            : null,
        },
      ];
    });
  }

  async quote(p: { from: Address; to: Address; amount: bigint; wallet?: Address }): Promise<Route[]> {
    const data = await this.call<Record<string, unknown>[]>('Quote', 'GET', '/api/v1/dex/aggregator/quote', {
      binanceChainId: BINANCE_BSC_CHAIN_ID,
      amount: p.amount.toString(),
      fromTokenAddress: p.from,
      toTokenAddress: p.to,
      userWalletAddress: p.wallet,
    });
    return data.flatMap((r) => {
      if (!r.quoteId || r.toTokenAmount === undefined) return [];
      return [
        {
          quoteId: String(r.quoteId),
          vendorName: String(r.vendorName ?? 'unknown'),
          fromAmount: BigInt(String(r.fromTokenAmount ?? p.amount)),
          toAmount: BigInt(String(r.toTokenAmount)),
          priceImpactPercent: num(r.priceImpactPercent),
          executionMode: String(r.executionMode ?? 'SWAP'),
          approveTarget: addr(r.approveTarget),
          isBest: r.isBest === true,
          tradeFeeUsd: num(r.tradeFee),
        },
      ];
    });
  }

  async approveTx(p: { token: Address; amount: bigint; vendor?: string }) {
    const data = await this.call<Record<string, unknown>[]>(
      'Approve transaction',
      'GET',
      '/api/v1/dex/aggregator/approve-transaction',
      {
        binanceChainId: BINANCE_BSC_CHAIN_ID,
        tokenContractAddress: p.token,
        approveAmount: p.amount.toString(),
        vendor: p.vendor,
      },
    );
    const first = data[0];
    const spender = addr(first?.dexContractAddress);
    if (!first?.data || !spender) throw new TradeApiError('Approve transaction: no calldata or spender returned');
    return {
      tx: { to: p.token, data: first.data as Hex, value: '0', gas: str(first.gasLimit) ?? undefined },
      spender,
    };
  }

  async buildSwap(p: {
    from: Address;
    to: Address;
    amount: bigint;
    wallet: Address;
    quoteId: string;
    slippagePercent: string;
  }): Promise<BuiltSwap> {
    const data = await this.call<Record<string, unknown>>('Build swap', 'GET', '/api/v1/dex/aggregator/swap', {
      binanceChainId: BINANCE_BSC_CHAIN_ID,
      amount: p.amount.toString(),
      fromTokenAddress: p.from,
      toTokenAddress: p.to,
      userWalletAddress: p.wallet,
      quoteId: p.quoteId,
      slippagePercent: p.slippagePercent,
    });
    const tx = data.tx as Record<string, unknown> | null | undefined;
    const rfq = data.rfq as Record<string, unknown> | null | undefined;
    return {
      executionMode: String(data.executionMode ?? (rfq ? 'RFQ' : 'SWAP')),
      tx:
        tx && tx.to && tx.data
          ? {
              from: addr(tx.from) ?? undefined,
              to: getAddress(String(tx.to)),
              data: tx.data as Hex,
              value: String(tx.value ?? '0'),
              gas: str(tx.gas) ?? undefined,
              minReceiveAmount: str(tx.minReceiveAmount),
            }
          : null,
      rfq:
        rfq && rfq.typedDataToSign
          ? {
              vendor: String(rfq.vendor ?? ''),
              txType: str(rfq.txType),
              typedDataToSign: String(rfq.typedDataToSign),
              signingScheme: str(rfq.signingScheme),
              orderId: str(rfq.orderId),
            }
          : null,
    };
  }

  async submitOrder(p: {
    requestId: string;
    userSignature: Hex;
    vendor: string;
    quoteId: string;
    signingScheme?: string;
  }) {
    const data = await this.call<Record<string, unknown>>(
      'Submit order',
      'POST',
      '/api/v1/dex/aggregator/order/submit',
      {
        requestId: p.requestId,
        userSignature: p.userSignature,
        vendor: p.vendor,
        quoteId: p.quoteId,
        signingScheme: p.signingScheme,
      },
    );
    return { orderId: String(data.orderId ?? ''), status: String(data.status ?? 'unknown') };
  }

  async orderStatus(orderId: string): Promise<OrderStatus> {
    const data = await this.call<Record<string, unknown>>(
      'Order status',
      'GET',
      `/api/v1/dex/aggregator/order/${encodeURIComponent(orderId)}`,
      {},
    );
    return {
      orderId: String(data.orderId ?? orderId),
      status: String(data.status ?? 'unknown'),
      txHash: (str(data.txHash) as Hex | null) ?? null,
      fromAmount: str(data.fromAmount),
      toAmount: str(data.toAmount),
    };
  }

  async simulate(tx: EvmTx & { from: Address }): Promise<Simulation> {
    const data = await this.call<Record<string, unknown>>('Simulate', 'POST', '/api/v1/dex/pre-transaction/simulate', {
      binanceChainId: BINANCE_BSC_CHAIN_ID,
      evmTx: { from: tx.from, to: tx.to, value: tx.value, data: tx.data },
    });
    const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
    return {
      status: String(data.status ?? 'unknown'),
      failReason: str(data.failReason),
      balanceChanges: list(data.balanceChanges).map((b) => ({
        token: String(b.contractAddress ?? ''),
        owner: String(b.owner ?? ''),
        change: String(b.change ?? '0'),
      })),
      allowanceChanges: list(data.allowanceChanges).map((a) => ({
        token: String(a.tokenAddress ?? ''),
        owner: String(a.owner ?? ''),
        spender: String(a.spender ?? ''),
        pre: String(a.preAmount ?? '0'),
        post: String(a.postAmount ?? '0'),
      })),
    };
  }

  async searchToken(symbol: string) {
    const data = await this.call<Record<string, unknown>[]>('Token search', 'GET', '/api/v1/dex/market/token/search', {
      chains: BINANCE_BSC_CHAIN_ID,
      search: symbol,
    });
    return data.flatMap((t) => {
      const a = addr(t.tokenContractAddress);
      return a && String(t.binanceChainId ?? BINANCE_BSC_CHAIN_ID) === BINANCE_BSC_CHAIN_ID
        ? [{ address: a, symbol: String(t.tokenSymbol ?? ''), decimals: num(t.decimals) }]
        : [];
    });
  }

  async defiPositions(address: Address): Promise<DefiPosition[]> {
    const data = await this.call<Record<string, unknown>>('DeFi positions', 'POST', '/api/v1/defi/data/position/list', {
      addresses: [address],
      binanceChainIds: [BINANCE_BSC_CHAIN_ID],
    });
    return flattenDefi(data);
  }
}

const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);

export function flattenDefi(data: Record<string, unknown>): DefiPosition[] {
  const out: DefiPosition[] = [];
  for (const a of arr(data.addressList)) {
    for (const pr of arr(a.protocolList)) {
      if (String(pr.binanceChainId ?? BINANCE_BSC_CHAIN_ID) !== BINANCE_BSC_CHAIN_ID) continue;
      for (const pool of arr(pr.poolList)) {
        for (const col of arr(pool.positionCollectionList)) {
          const detail = (col.positionCollectionDetail ?? null) as Record<string, unknown> | null;
          for (const pos of arr(col.positionList)) {
            const tl = (pos.tokenList ?? {}) as Record<string, unknown>;
            for (const side of ['supply', 'borrow'] as const) {
              for (const t of arr(tl[side])) {
                const token = addr(t.tokenAddress);
                if (!token || t.tokenAmount === undefined) continue;
                out.push({
                  protocolId: String(pr.defiProtocolId ?? ''),
                  protocolName: String(pr.protocolName ?? pr.defiProtocolId ?? 'unknown'),
                  poolType: String(pool.poolType ?? ''),
                  pool: addr(pool.poolCa),
                  healthFactor: str(detail?.healthFactor),
                  side,
                  token,
                  symbol: String(t.tokenSymbol ?? ''),
                  amount: String(t.tokenAmount),
                  priceUsd: num(t.tokenPrice),
                  valueUsd: num(t.tokenValue),
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}
