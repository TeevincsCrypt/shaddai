/**
 * Fixture stand-in for the Binance Web3 API, for the demo and tests. Prices come
 * from the demo marks; depth is a straight line (price worsens by ticket ÷
 * liquidity), so small tickets pass the 1% rule and large ones on thin wrappers
 * do not. Every route is RFQ, as the real API returns for equity tokens.
 */
import { decodeFunctionData, encodeFunctionData, type Address, type Hex } from 'viem';
import { approveAbi } from '../core/abi.js';
import type { MarkQuote } from '../core/prices.js';
import type {
  BuiltSwap,
  DefiPosition,
  EvmTx,
  OrderStatus,
  Route,
  RwaToken,
  Simulation,
  TradeApi,
} from '../core/trade-api.js';

const SPREAD = 0.002;

export class FakeTradeApi implements TradeApi {
  readonly label = 'Demo trade API (fixture)';
  private quotes = new Map<string, { from: Address; to: Address; amount: bigint; toAmount: bigint }>();
  private n = 0;
  /** Calls by method, for tests. */
  readonly calls: Record<string, number> = {};

  constructor(
    private readonly opts: {
      marks: Map<Address, MarkQuote>;
      rwa: RwaToken[];
      spender: Address;
      /** Pay-in tokens the fixture prices at $1. */
      stable: Address[];
      search?: { address: Address; symbol: string; decimals: number | null }[];
      defi?: DefiPosition[];
      /** Force a failure for one method (tests). */
      fail?: Partial<Record<keyof TradeApi, string>>;
    },
  ) {}

  private hit(m: keyof TradeApi) {
    this.calls[m] = (this.calls[m] ?? 0) + 1;
    const f = this.opts.fail?.[m];
    if (f) throw new Error(f);
  }

  async rwaTokens(): Promise<RwaToken[]> {
    this.hit('rwaTokens');
    return this.opts.rwa;
  }

  async quote(p: { from: Address; to: Address; amount: bigint; wallet?: Address }): Promise<Route[]> {
    this.hit('quote');
    const mark = this.opts.marks.get(p.to);
    if (!mark || !this.opts.stable.includes(p.from)) return [];
    const usd = Number(p.amount) / 1e18;
    const price = mark.rawUsd * (1 + SPREAD + usd / mark.liquidityUsd);
    const toAmount = BigInt(Math.floor((usd / price) * 1e12)) * 10n ** 6n;
    const quoteId = `demo${(++this.n).toString().padStart(6, '0')}`;
    this.quotes.set(quoteId, { from: p.from, to: p.to, amount: p.amount, toAmount });
    return [
      {
        quoteId,
        vendorName: 'DemoRFQ',
        fromAmount: p.amount,
        toAmount,
        priceImpactPercent: null,
        executionMode: 'RFQ',
        approveTarget: this.opts.spender,
        isBest: true,
        tradeFeeUsd: null,
      },
    ];
  }

  async approveTx(p: { token: Address; amount: bigint }) {
    this.hit('approveTx');
    const data = encodeFunctionData({ abi: approveAbi, functionName: 'approve', args: [this.opts.spender, p.amount] });
    return { tx: { to: p.token, data, value: '0', gas: '60000' }, spender: this.opts.spender };
  }

  async buildSwap(p: {
    from: Address;
    to: Address;
    amount: bigint;
    wallet: Address;
    quoteId: string;
  }): Promise<BuiltSwap> {
    this.hit('buildSwap');
    const q = this.quotes.get(p.quoteId);
    if (!q || q.to !== p.to || q.amount !== p.amount) throw new Error('SWAP_QUOTE_MISMATCH (fixture)');
    const typed = {
      types: {
        EIP712Domain: [
          { name: 'name', type: 'string' },
          { name: 'version', type: 'string' },
          { name: 'chainId', type: 'uint256' },
          { name: 'verifyingContract', type: 'address' },
        ],
        Order: [
          { name: 'maker', type: 'address' },
          { name: 'makerAsset', type: 'address' },
          { name: 'takerAsset', type: 'address' },
          { name: 'makingAmount', type: 'uint256' },
          { name: 'takingAmount', type: 'uint256' },
        ],
      },
      primaryType: 'Order',
      domain: { name: 'Shaddai demo RFQ', version: '1', chainId: 56, verifyingContract: this.opts.spender },
      message: {
        maker: p.wallet,
        makerAsset: p.from,
        takerAsset: p.to,
        makingAmount: p.amount.toString(),
        takingAmount: ((q.toAmount * 995n) / 1000n).toString(),
      },
    };
    return {
      executionMode: 'RFQ',
      tx: null,
      rfq: {
        vendor: 'DemoRFQ',
        txType: 'EIP712',
        typedDataToSign: JSON.stringify(typed),
        signingScheme: 'eip712',
        orderId: null,
      },
    };
  }

  async submitOrder(): Promise<{ orderId: string; status: string }> {
    this.hit('submitOrder');
    throw new Error('Demo: no order is sent.');
  }

  async orderStatus(orderId: string): Promise<OrderStatus> {
    this.hit('orderStatus');
    return { orderId, status: 'CANCELLED', txHash: null, fromAmount: null, toAmount: null };
  }

  async simulate(tx: EvmTx & { from: Address }): Promise<Simulation> {
    this.hit('simulate');
    try {
      const { args } = decodeFunctionData({ abi: approveAbi, data: tx.data as Hex });
      const [spender, amount] = args as [Address, bigint];
      return {
        status: 'SUCCESS',
        failReason: null,
        balanceChanges: [],
        allowanceChanges: [{ token: tx.to, owner: tx.from, spender, pre: '0', post: amount.toString() }],
      };
    } catch {
      return {
        status: 'FAILED',
        failReason: 'fixture only simulates approve()',
        balanceChanges: [],
        allowanceChanges: [],
      };
    }
  }

  async searchToken(symbol: string) {
    this.hit('searchToken');
    return (this.opts.search ?? []).filter((s) => s.symbol === symbol);
  }

  async defiPositions(): Promise<DefiPosition[]> {
    this.hit('defiPositions');
    return this.opts.defi ?? [];
  }
}
