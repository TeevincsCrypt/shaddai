/**
 * Share-true Buy: size a spot buy in dollars of shares, compare wrappers on
 * share-equivalents received (not token count), refuse thin books, and hand the
 * user's own wallet an approve and an order to sign. Shaddai never holds funds
 * or keys; the Binance Web3 API key stays on the server.
 */
import {
  decodeFunctionData,
  getAddress,
  hexToString,
  isAddress,
  isHex,
  parseUnits,
  type Address,
  type Hex,
} from 'viem';
import { approveAbi, erc20Abi, scaledUiAbi } from './abi.js';
import { tokenRef } from './events.js';
import { probeTokens, type TokenProbe } from './probe.js';
import type { TokenInfo } from './registry.js';
import type { ShaddaiContext } from './scan.js';
import {
  TradeApiError,
  type EvmTx,
  type Route,
  type RwaStatus,
  type RwaToken,
  type Simulation,
  type TradeApi,
} from './trade-api.js';
import type { TokenRef } from './types.js';
import { decimalString, fixedToNumber, multiplierString, ONE, toUI } from './units.js';

/** BSC USDT, the chain-56 pay-in token in Binance's own Web3 API example. */
export const USDT_BSC: Address = getAddress('0x55d398326f99059fF775485246999027B3197955');
/** BSC USDC, the chain-56 buy token in the same examples; used only for the diagnostic non-equity quote. */
export const USDC_BSC: Address = getAddress('0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d');

/** Binance Web3 API business code for a compliance refusal. */
export const COMPLIANCE_CODE = 40304;
export const isCompliance = (e: unknown) => e instanceof TradeApiError && Number(e.code) === COMPLIANCE_CODE;

export type PayInSymbol = 'USDT' | 'USD1';
export const PAY_IN_SYMBOLS: PayInSymbol[] = ['USDT', 'USD1'];

export interface BuyConfig {
  api: TradeApi;
  /** Largest ticket the server will quote or prepare (small live amounts only). */
  maxUsd: number;
  /** Hard refusal above this price impact, in percent. */
  maxImpactPct: number;
  /** Slippage passed to /swap, percent string. */
  slippagePct: string;
  /** Address used to request RFQ quotes when the caller has not connected a wallet. */
  quoteWallet: Address | null;
  /** USD1 contract if pinned by env; otherwise resolved through token search and checked on chain. */
  usd1: Address | null;
}

export class BuyError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 422 | 502 | 503 = 400,
  ) {
    super(message);
  }
}

export const BUY_COPY = {
  ondoUnread: 'Ondo total-return factor not read — do not treat 1 token as 1 share.',
  xstocksUnread: 'Display factor not on this token — do not invent it.',
  bstockUnread: 'uiMultiplier() did not answer — share-equivalents unknown, so this wrapper is not quoted.',
  noRoute: 'No route returned for this pair.',
  compliance:
    'Binance declined to quote for compliance reasons (code 40304). It limits tokenized-stock services by jurisdiction, and the location of the server calling it counts.',
  depthUnknown:
    'Depth not measured: the quote gave no price impact and the smaller probe quote failed. Refused rather than assumed deep.',
  rfqNote:
    'RFQ order: the vendor settles on-chain after you sign, so there is no swap transaction to simulate. Shaddai checks that the order names your wallet and the token before asking for a signature.',
} as const;

/** Market-level or asset-level halts reported by the RWA Data API. */
const HARD_STOP_CODES = new Set(['MARKET_PAUSED', 'MARKET_MAINTENANCE', 'ASSET_PAUSED', 'UNSUPPORTED']);

export interface PayIn {
  symbol: PayInSymbol;
  address: Address;
  decimals: number;
  /** How the address was established. */
  source: 'pinned' | 'env' | 'token-search';
}

export interface WrapperQuote {
  token: TokenRef;
  status: 'ok' | 'refused';
  reasons: string[];
  notes: string[];
  /** On-chain share factor (uiMultiplier or Ondo sValue), 18-decimal string. */
  factor: string | null;
  factorSource: 'uiMultiplier' | 'sValue' | null;
  /** Binance RWA tokenToShareRatio, for comparison only. */
  binanceRatio: string | null;
  market: RwaStatus | null;
  referencePrice: number | null;
  referenceSource: 'binance-rwa' | 'dex-mark' | null;
  /** Share-equivalents the ticket buys at the reference price. */
  targetShares: string | null;
  /** Raw tokens that equal targetShares: the contract's fromUIAmount(), or shares ÷ sValue for Ondo. */
  targetRaw: string | null;
  targetRawSource: 'fromUIAmount' | 'computed' | null;
  route: { vendor: string; executionMode: string; quoteId: string; approveTarget: Address | null } | null;
  rawOut: string | null;
  shareEqOut: string | null;
  usdPerShare: number | null;
  /** Share-equivalents received as a share of the target, in percent. */
  fillOfTargetPct: number | null;
  impactPct: number | null;
  impactSource: 'vendor' | 'measured' | 'both' | null;
}

export interface BuyQuote {
  mode: 'live' | 'demo';
  ticker: string;
  usd: number;
  payIn: PayIn & { amountRaw: string };
  wallet: Address | null;
  walletSource: 'caller' | 'quote-wallet' | 'none';
  block: string;
  generatedAt: number;
  limits: { maxUsd: number; maxImpactPct: number; slippagePct: string };
  wrappers: WrapperQuote[];
  /** Most share-equivalents received among wrappers that passed every check. */
  best: Address | null;
  /** What a token-count comparison would pick. Shown when it differs from `best`. */
  rawCountPick: Address | null;
  notes: string[];
  api: string;
}

export function requireBuy(ctx: ShaddaiContext): BuyConfig {
  if (!ctx.buy) {
    throw new BuyError(
      'Buy is not configured on this server: set BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET.',
      503,
    );
  }
  return ctx.buy;
}

function parseUsd(v: unknown, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new BuyError('Amount must be a positive number of US dollars.');
  if (n > max)
    throw new BuyError(`Amount is above this server's limit of $${max} per ticket (small live amounts only).`);
  return Math.round(n * 100) / 100;
}

export function parseWallet(v: string): Address {
  const s = v.trim();
  if (!isAddress(s, { strict: false }))
    throw new BuyError('Wallet is not a BSC address (0x followed by 40 hex characters).');
  return getAddress(s.toLowerCase());
}

const toFixedUnits = (x: number, decimals: number) => parseUnits(x.toFixed(Math.min(decimals, 12)), decimals);

const usd1Cache = new WeakMap<BuyConfig, PayIn>();

/** Pay-in token, confirmed on chain: the contract must answer symbol() with the expected symbol. */
export async function resolvePayIn(ctx: ShaddaiContext, cfg: BuyConfig, symbol: PayInSymbol): Promise<PayIn> {
  if (!PAY_IN_SYMBOLS.includes(symbol)) throw new BuyError('Pay-in must be USDT or USD1.');
  if (symbol === 'USD1' && usd1Cache.has(cfg)) return usd1Cache.get(cfg)!;
  let address: Address;
  let source: PayIn['source'];
  if (symbol === 'USDT') {
    address = USDT_BSC;
    source = 'pinned';
  } else if (cfg.usd1) {
    address = cfg.usd1;
    source = 'env';
  } else {
    const hits = (
      await cfg.api.searchToken('USD1').catch((e: Error) => {
        throw new BuyError(`USD1: token search failed (${e.message}).`, 502);
      })
    ).filter((h) => h.symbol === 'USD1');
    const unique = [...new Set(hits.map((h) => h.address))];
    if (unique.length !== 1) {
      throw new BuyError(
        unique.length
          ? `USD1: token search returned ${unique.length} BSC contracts; set SHADDAI_USD1_ADDRESS to the one to use.`
          : 'USD1: token search found no BSC contract. Pay with USDT, or set SHADDAI_USD1_ADDRESS.',
        422,
      );
    }
    address = unique[0]!;
    source = 'token-search';
  }
  const [sym, dec] = await ctx.chain.readMany([
    { to: address, abi: erc20Abi, functionName: 'symbol' },
    { to: address, abi: erc20Abi, functionName: 'decimals' },
  ]);
  if (!sym?.ok || sym.value !== symbol || !dec?.ok) {
    throw new BuyError(
      `${symbol}: ${address} does not answer symbol() = "${symbol}" on BSC${sym?.ok ? ` (it says "${String(sym.value)}")` : ''}. Not using it.`,
      422,
    );
  }
  const payIn: PayIn = { symbol, address, decimals: Number(dec.value), source };
  if (symbol === 'USD1') usd1Cache.set(cfg, payIn);
  return payIn;
}

function wrappersFor(ctx: ShaddaiContext, ticker: string): { key: string; wrappers: TokenInfo[] } {
  const q = ticker.trim().toUpperCase();
  const key = ctx.tokens.find((k) => k.symbol.toUpperCase() === q)?.ticker ?? q;
  return { key, wrappers: ctx.tokens.filter((k) => k.ticker === key && (ctx.mode === 'demo' || !k.demoOnly)) };
}

const bestRoute = (routes: Route[]) =>
  routes.reduce<Route | null>((b, r) => (!b || r.toAmount > b.toAmount ? r : b), null);

export interface QuoteInput {
  ticker: string;
  usd: number | string;
  payIn?: PayInSymbol;
  wallet?: string | null;
  /** Restrict to one wrapper (the prepare step re-quotes only the chosen one). */
  only?: Address;
}

export async function quoteShareTrueBuy(ctx: ShaddaiContext, input: QuoteInput): Promise<BuyQuote> {
  const cfg = requireBuy(ctx);
  const usd = parseUsd(input.usd, cfg.maxUsd);
  const callerWallet = input.wallet ? parseWallet(input.wallet) : null;
  const wallet = callerWallet ?? cfg.quoteWallet;
  const { key, wrappers: all } = wrappersFor(ctx, input.ticker);
  const wrappers = input.only ? all.filter((w) => w.address === input.only) : all;
  if (!wrappers.length) {
    throw new BuyError(`${input.ticker}: no tokenized wrapper for this ticker in Shaddai's registry.`, 404);
  }
  const payIn = await resolvePayIn(ctx, cfg, input.payIn ?? 'USDT');
  const amount = toFixedUnits(usd, payIn.decimals);
  const head = await ctx.chain.blockNumber();
  const hdr = await ctx.chain.getBlock(head);

  const [probes, rwa, marks] = await Promise.all([
    probeTokens(ctx.chain, wrappers, null, head, hdr.timestamp, { ondoOracle: ctx.ondoOracle }),
    cfg.api
      .rwaTokens()
      .then((list) => ({ ok: true as const, list }))
      .catch((e: Error) => ({ ok: false as const, error: e.message })),
    ctx.prices.quote(wrappers.map((w) => w.address)).catch(() => null),
  ]);

  const notes: string[] = [];
  if (!rwa.ok)
    notes.push(`Binance RWA data not read (${rwa.error}): market status and reference price come from DEX marks.`);
  if (!wallet) {
    notes.push('No wallet given: RFQ quotes for equity tokens may need one. Connect a wallet to quote as yourself.');
  } else if (!callerWallet) {
    notes.push('Quoted with the server quote wallet; connect your wallet before buying.');
  }

  let complianceHits = 0;
  const evaluate = async (w: TokenInfo): Promise<WrapperQuote> => {
    const p = probes.get(w.address) as TokenProbe;
    const r: RwaToken | null = rwa.ok ? (rwa.list.find((x) => x.address === w.address) ?? null) : null;
    const q: WrapperQuote = {
      token: tokenRef(w),
      status: 'ok',
      reasons: [],
      notes: [],
      factor: p.mult === null ? null : multiplierString(p.mult),
      factorSource: p.unit.kind === 'bep677' ? 'uiMultiplier' : p.unit.kind === 'ondo-svalue' ? 'sValue' : null,
      binanceRatio: r?.tokenToShareRatio ?? null,
      market: r?.status ?? null,
      referencePrice: null,
      referenceSource: null,
      targetShares: null,
      targetRaw: null,
      targetRawSource: null,
      route: null,
      rawOut: null,
      shareEqOut: null,
      usdPerShare: null,
      fillOfTargetPct: null,
      impactPct: null,
      impactSource: null,
    };
    const refuse = (why: string) => {
      q.status = 'refused';
      q.reasons.push(why);
    };

    if (p.mult === null) {
      refuse(
        w.model === 'ondo'
          ? BUY_COPY.ondoUnread
          : w.model === 'xstocks'
            ? BUY_COPY.xstocksUnread
            : BUY_COPY.bstockUnread,
      );
    }
    if (rwa.ok && !r) q.notes.push('Not listed in Binance RWA data for BSC.');
    const st = r?.status;
    if (st?.reasonCode && HARD_STOP_CODES.has(st.reasonCode)) {
      refuse(`Trading halted: ${st.reasonCode}${st.reasonMsg ? ` (${st.reasonMsg})` : ''}.`);
    } else if (st && st.openState === false) {
      q.notes.push(
        `Underlying market ${st.marketStatus ?? 'closed'}${st.reasonMsg ? ` (${st.reasonMsg})` : ''}${
          st.nextOpenTime
            ? `; next open ${new Date(st.nextOpenTime).toISOString().slice(0, 16).replace('T', ' ')} UTC`
            : ''
        }. Reference prices are stale until then.`,
      );
    }
    if (p.unit.ondo?.paused) refuse('Ondo oracle is paused for this asset (corporate action in progress).');
    if (p.unit.pending) {
      q.notes.push(
        `Multiplier change to ${p.unit.pending.multiplier}× scheduled for ${new Date(p.unit.pending.effectiveAt * 1000)
          .toISOString()
          .slice(0, 16)
          .replace('T', ' ')} UTC; this quote uses the current factor.`,
      );
    }
    if (q.factor && q.binanceRatio) {
      const a = Number(q.factor);
      const b = Number(q.binanceRatio);
      if (Number.isFinite(b) && b > 0 && Math.abs(a / b - 1) > 0.001) {
        q.notes.push(
          `Binance lists ${q.binanceRatio} shares per token; the chain says ${q.factor}. Shaddai uses the chain.`,
        );
      }
    }
    if (q.status === 'refused' || p.mult === null) return q;
    const mult = p.mult;
    const dec = p.unit.decimals;

    // Reference price per share-equivalent: Binance RWA first, else the DEX mark ÷ factor.
    const mark = marks?.marks.get(w.address);
    if (r?.referencePrice) {
      q.referencePrice = r.referencePrice;
      q.referenceSource = 'binance-rwa';
    } else if (mark) {
      q.referencePrice = mark.rawUsd / fixedToNumber(mult, 18);
      q.referenceSource = 'dex-mark';
    }
    if (q.referencePrice) {
      const shares = toFixedUnits(usd / q.referencePrice, dec);
      q.targetShares = decimalString(shares, dec);
      if (p.unit.kind === 'bep677') {
        const [fr] = await ctx.chain.readMany(
          [{ to: w.address, abi: scaledUiAbi, functionName: 'fromUIAmount', args: [shares] }],
          head,
        );
        if (fr?.ok) {
          q.targetRaw = decimalString(fr.value as bigint, dec);
          q.targetRawSource = 'fromUIAmount';
        }
      }
      if (!q.targetRaw) {
        q.targetRaw = decimalString((shares * ONE) / mult, dec);
        q.targetRawSource = 'computed';
      }
    }

    // Full ticket plus a probe at a tenth of it (at least one pay-in unit) to measure depth.
    const unit = 10n ** BigInt(payIn.decimals);
    let probeAmt = amount / 10n;
    if (probeAmt < unit) probeAmt = amount > unit ? unit : 0n;
    const ask = (amt: bigint) =>
      cfg.api.quote({ from: payIn.address, to: w.address, amount: amt, wallet: wallet ?? undefined });
    const [full, small] = await Promise.all([
      ask(amount).then(
        (x) => x,
        (e: Error) => e,
      ),
      probeAmt > 0n
        ? ask(probeAmt).then(
            (x) => x,
            (e: Error) => e,
          )
        : Promise.resolve(null),
    ]);
    if (full instanceof Error) {
      if (isCompliance(full)) {
        complianceHits++;
        refuse(BUY_COPY.compliance);
      } else refuse(full.message);
      return q;
    }
    const route = bestRoute(full);
    if (!route || route.toAmount <= 0n) {
      refuse(BUY_COPY.noRoute);
      return q;
    }
    q.route = {
      vendor: route.vendorName,
      executionMode: route.executionMode,
      quoteId: route.quoteId,
      approveTarget: route.approveTarget,
    };
    q.rawOut = decimalString(route.toAmount, dec);
    const shareEq = toUI(route.toAmount, mult);
    q.shareEqOut = decimalString(shareEq, dec);
    const shareEqNum = fixedToNumber(shareEq, dec);
    q.usdPerShare = shareEqNum > 0 ? usd / shareEqNum : null;
    if (q.targetShares) q.fillOfTargetPct = (shareEqNum / Number(q.targetShares)) * 100;

    const smallRoute = small && !(small instanceof Error) ? bestRoute(small) : null;
    let measured: number | null = null;
    if (smallRoute && smallRoute.toAmount > 0n && probeAmt > 0n && probeAmt < amount) {
      const fullRate = Number(route.toAmount) / Number(amount);
      const smallRate = Number(smallRoute.toAmount) / Number(probeAmt);
      measured = Math.max(0, (1 - fullRate / smallRate) * 100);
    }
    const vendor = route.priceImpactPercent !== null ? Math.abs(route.priceImpactPercent) : null;
    if (measured === null && vendor === null) {
      refuse(BUY_COPY.depthUnknown);
      return q;
    }
    q.impactPct = Math.max(measured ?? 0, vendor ?? 0);
    q.impactSource = measured !== null && vendor !== null ? 'both' : measured !== null ? 'measured' : 'vendor';
    if (q.impactPct > cfg.maxImpactPct) {
      refuse(`Thin book: a $${usd} ticket moves the price ${q.impactPct.toFixed(2)}% (limit ${cfg.maxImpactPct}%).`);
    }
    if (route.executionMode !== 'RFQ') q.notes.push(`Route type ${route.executionMode}, not RFQ.`);
    return q;
  };

  const results = await Promise.all(wrappers.map(evaluate));
  const ok = results.filter((x) => x.status === 'ok' && x.shareEqOut !== null);
  const argmax = (f: (x: WrapperQuote) => number) =>
    ok.reduce<WrapperQuote | null>((b, x) => (!b || f(x) > f(b) ? x : b), null)?.token.address ?? null;
  const best = argmax((x) => Number(x.shareEqOut));
  const rawCountPick = argmax((x) => Number(x.rawOut));
  if (best && rawCountPick && best !== rawCountPick) {
    const sym = (a: Address) => results.find((x) => x.token.address === a)!.token.symbol;
    notes.push(
      `Counting tokens would pick ${sym(rawCountPick)}; counting shares picks ${sym(best)}. The wrappers carry different share factors.`,
    );
  }
  if (complianceHits) {
    notes.push(
      'Binance refused this request for compliance reasons. Check /api/buy/diagnose: it shows the server region and which Binance calls are refused.',
    );
  } else if (!ok.length) notes.push('Nothing to buy: every wrapper was refused. Reasons are listed per wrapper.');

  return {
    mode: ctx.mode,
    ticker: key,
    usd,
    payIn: { ...payIn, amountRaw: amount.toString() },
    wallet,
    walletSource: callerWallet ? 'caller' : wallet ? 'quote-wallet' : 'none',
    block: head.toString(),
    generatedAt: Math.floor(Date.now() / 1000),
    limits: { maxUsd: cfg.maxUsd, maxImpactPct: cfg.maxImpactPct, slippagePct: cfg.slippagePct },
    wrappers: results,
    best,
    rawCountPick,
    notes,
    api: cfg.api.label,
  };
}

// ---------------------------------------------------------------------------
// Prepare: approve (simulated) or the order to sign, for the chosen wrapper.

export interface TypedDataCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TypedData {
  domain: Record<string, unknown>;
  types: Record<string, unknown>;
  primaryType: string;
  message: Record<string, unknown>;
}

export type PrepareResult =
  | { step: 'refused'; quote: BuyQuote; reasons: string[] }
  | {
      step: 'approve';
      quote: BuyQuote;
      approve: {
        tx: EvmTx & { from: Address };
        spender: Address;
        amountRaw: string;
        allowanceRaw: string;
        simulation: Simulation | null;
        simulationError: string | null;
      };
    }
  | {
      step: 'sign';
      quote: BuyQuote;
      order: {
        vendor: string;
        quoteId: string;
        signingScheme: string | null;
        /** JSON string for eth_signTypedData_v4. */
        typedData: string;
        primaryType: string;
        domain: Record<string, unknown>;
        checks: TypedDataCheck[];
      };
      note: string;
    }
  | {
      step: 'send';
      quote: BuyQuote;
      tx: EvmTx & { from: Address; minReceiveAmount: string | null };
      simulation: Simulation | null;
      simulationError: string | null;
    };

export function parseTypedData(s: string): TypedData {
  let v: unknown = s.trim();
  if (typeof v === 'string' && isHex(v)) v = hexToString(v as Hex);
  for (let i = 0; i < 2 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v);
    } catch {
      throw new BuyError('The order to sign is not valid EIP-712 JSON.', 502);
    }
  }
  const t = v as Partial<TypedData>;
  if (!t || typeof t !== 'object' || !t.domain || !t.types || !t.primaryType || !t.message) {
    throw new BuyError('The order to sign is missing domain, types, primaryType or message.', 502);
  }
  return t as TypedData;
}

function containsAddress(v: unknown, a: Address): boolean {
  const needle = a.toLowerCase().slice(2);
  if (typeof v === 'string') return v.toLowerCase().includes(needle);
  if (Array.isArray(v)) return v.some((x) => containsAddress(x, a));
  if (v && typeof v === 'object') return Object.values(v).some((x) => containsAddress(x, a));
  return false;
}

export function checkTypedData(t: TypedData, wallet: Address, token: TokenRef, payIn: PayIn): TypedDataCheck[] {
  const chainId = t.domain.chainId;
  const checks: TypedDataCheck[] = [
    chainId === undefined
      ? { name: 'chain', ok: true, detail: 'Domain does not state a chain id.' }
      : { name: 'chain', ok: Number(chainId) === 56, detail: `Domain chain id ${String(chainId)} (BSC is 56).` },
    {
      name: 'wallet',
      ok: containsAddress(t.message, wallet),
      detail: `Order ${containsAddress(t.message, wallet) ? 'names' : 'does not name'} your wallet ${wallet}.`,
    },
    {
      name: 'token',
      ok: containsAddress(t.message, token.address),
      detail: `Order ${containsAddress(t.message, token.address) ? 'names' : 'does not name'} ${token.symbol} (${token.address}).`,
    },
  ];
  // The pay-in token may sit in a Permit2 witness instead of the message body; report, do not block.
  checks.push({
    name: 'pay-in',
    ok: true,
    detail: containsAddress(t, payIn.address)
      ? `Order names ${payIn.symbol}.`
      : `Order does not name ${payIn.symbol} directly (some vendors carry it in the permit).`,
  });
  return checks;
}

export interface PrepareInput {
  token: string;
  usd: number | string;
  payIn?: PayInSymbol;
  wallet: string;
  /** Demo only: skip the allowance step to preview the order. */
  demoSkipAllowance?: boolean;
}

export async function prepareBuy(ctx: ShaddaiContext, input: PrepareInput): Promise<PrepareResult> {
  const cfg = requireBuy(ctx);
  const wallet = parseWallet(input.wallet);
  if (!isAddress(input.token, { strict: false })) throw new BuyError('Token is not an address.');
  const tokenAddr = getAddress(input.token.toLowerCase());
  const info = ctx.tokens.find((t) => t.address === tokenAddr);
  if (!info) throw new BuyError("Token is not in Shaddai's registry.", 404);

  const quote = await quoteShareTrueBuy(ctx, {
    ticker: info.symbol,
    usd: input.usd,
    payIn: input.payIn,
    wallet,
    only: tokenAddr,
  });
  const w = quote.wrappers[0]!;
  if (w.status !== 'ok' || !w.route) return { step: 'refused', quote, reasons: w.reasons };
  const amount = BigInt(quote.payIn.amountRaw);
  const vendor = w.route.executionMode === 'RFQ' ? w.route.vendor : undefined;

  // Allowance: the spender comes from the quote, or from the approve endpoint (it resolves the vendor's spender).
  let approve: Awaited<ReturnType<TradeApi['approveTx']>> | null = null;
  let spender = w.route.approveTarget;
  if (!spender) {
    approve = await cfg.api.approveTx({ token: quote.payIn.address, amount, vendor });
    spender = approve.spender;
  }
  const skip = ctx.mode === 'demo' && input.demoSkipAllowance === true;
  const [al] = await ctx.chain.readMany([
    { to: quote.payIn.address, abi: erc20Abi, functionName: 'allowance', args: [wallet, spender] },
  ]);
  if (!al?.ok) throw new BuyError(`Could not read the ${quote.payIn.symbol} allowance on BSC.`, 502);
  const allowance = al.value as bigint;

  if (allowance < amount && !skip) {
    approve ??= await cfg.api.approveTx({ token: quote.payIn.address, amount, vendor });
    // Check the calldata before a wallet sees it: approve(spender, amount) on the pay-in token, nothing else.
    let decoded: { args: readonly unknown[] };
    try {
      decoded = decodeFunctionData({ abi: approveAbi, data: approve.tx.data }) as { args: readonly unknown[] };
    } catch {
      throw new BuyError('Approve calldata from the API is not an ERC-20 approve(). Refused.', 502);
    }
    const [sp, amt] = decoded.args as [Address, bigint];
    if (approve.tx.to !== quote.payIn.address || getAddress(sp) !== getAddress(spender) || amt !== amount) {
      throw new BuyError(
        `Approve calldata does not match: expected approve(${spender}, ${amount}) on ${quote.payIn.symbol}. Refused.`,
        502,
      );
    }
    const tx = { ...approve.tx, from: wallet };
    let simulation: Simulation | null = null;
    let simulationError: string | null = null;
    try {
      simulation = await cfg.api.simulate(tx);
    } catch (e) {
      simulationError = (e as Error).message;
    }
    return {
      step: 'approve',
      quote,
      approve: {
        tx,
        spender,
        amountRaw: amount.toString(),
        allowanceRaw: allowance.toString(),
        simulation,
        simulationError,
      },
    };
  }

  const built = await cfg.api.buildSwap({
    from: quote.payIn.address,
    to: tokenAddr,
    amount,
    wallet,
    quoteId: w.route.quoteId,
    slippagePercent: cfg.slippagePct,
  });
  if (built.rfq) {
    const typed = parseTypedData(built.rfq.typedDataToSign);
    const checks = checkTypedData(typed, wallet, w.token, quote.payIn);
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) return { step: 'refused', quote, reasons: failed.map((c) => `Order check failed: ${c.detail}`) };
    return {
      step: 'sign',
      quote,
      order: {
        vendor: built.rfq.vendor,
        quoteId: built.rfq.orderId ?? w.route.quoteId,
        signingScheme: built.rfq.signingScheme,
        typedData: JSON.stringify(typed),
        primaryType: typed.primaryType,
        domain: typed.domain,
        checks,
      },
      note: BUY_COPY.rfqNote,
    };
  }
  if (built.tx) {
    if (built.tx.from && built.tx.from !== wallet)
      throw new BuyError('Swap transaction is not from your wallet. Refused.', 502);
    const tx = { ...built.tx, from: wallet };
    let simulation: Simulation | null = null;
    let simulationError: string | null = null;
    try {
      simulation = await cfg.api.simulate(tx);
    } catch (e) {
      simulationError = (e as Error).message;
    }
    return { step: 'send', quote, tx, simulation, simulationError };
  }
  throw new BuyError('The swap endpoint returned neither an order nor a transaction.', 502);
}

// ---------------------------------------------------------------------------
// Submit and follow the signed order.

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function submitBuy(
  ctx: ShaddaiContext,
  input: { requestId: string; signature: string; vendor: string; quoteId: string; signingScheme?: string | null },
) {
  const cfg = requireBuy(ctx);
  if (ctx.mode === 'demo') throw new BuyError('Demo: no order is sent.', 422);
  if (!UUID_V4.test(input.requestId)) throw new BuyError('requestId must be a UUID v4.');
  if (!/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new BuyError('Signature must be 65 bytes of hex.');
  if (!/^[\w.-]{1,64}$/.test(input.vendor) || !/^[\w-]{1,128}$/.test(input.quoteId)) {
    throw new BuyError('vendor or quoteId has an unexpected format.');
  }
  return cfg.api.submitOrder({
    requestId: input.requestId,
    userSignature: input.signature as Hex,
    vendor: input.vendor,
    quoteId: input.quoteId,
    signingScheme: input.signingScheme ?? undefined,
  });
}

export async function buyOrderStatus(ctx: ShaddaiContext, orderId: string) {
  const cfg = requireBuy(ctx);
  if (!/^[\w-]{1,128}$/.test(orderId)) throw new BuyError('orderId has an unexpected format.');
  return cfg.api.orderStatus(orderId);
}

// ---------------------------------------------------------------------------

export function quoteText(q: BuyQuote): string {
  const lines = [
    `Share-true buy quote: $${q.usd} of ${q.ticker} share-equivalents, paid in ${q.payIn.symbol}, at BSC block ${q.block}${
      q.mode === 'demo' ? ' — DEMO FIXTURE, not a live quote' : ''
    }.`,
    'Wrappers are compared on share-equivalents received (raw × on-chain factor), not on token count.',
    '',
  ];
  for (const w of q.wrappers) {
    const head = `${w.token.symbol} (${w.token.issuer})${w.token.address === q.best ? ' — BEST' : ''}`;
    if (w.status === 'refused') {
      lines.push(`${head}: REFUSED. ${w.reasons.join(' ')}`);
      continue;
    }
    lines.push(
      `${head}: ${w.rawOut} raw × ${w.factorSource} ${w.factor} = ${w.shareEqOut} share-eq · $${w.usdPerShare?.toFixed(2)}/share-eq${
        w.referencePrice ? ` vs reference $${w.referencePrice.toFixed(2)}` : ''
      } · impact ${w.impactPct?.toFixed(2)}% (${w.impactSource}) · ${w.route?.vendor} ${w.route?.executionMode}${
        w.targetRaw ? ` · raw for the full target (${w.targetRawSource}): ${w.targetRaw}` : ''
      }`,
    );
    for (const n of w.notes) lines.push(`  note: ${n}`);
  }
  for (const n of q.notes) lines.push(`Note: ${n}`);
  lines.push(
    '',
    `Limits: $${q.limits.maxUsd} per ticket, refuse above ${q.limits.maxImpactPct}% price impact, ${q.limits.slippagePct}% slippage. Spot only, BSC only. Quote only: nothing was traded.`,
    'Tokens are not the listed share and carry no voting rights. Not investment advice.',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Diagnose: which Binance Web3 API calls this server may make, and from where.

export interface DiagnoseStep {
  name: string;
  ok: boolean;
  code: number | string | null;
  detail: string;
}

export async function diagnoseBuy(ctx: ShaddaiContext, region: string | null) {
  const cfg = requireBuy(ctx);
  const step = async (name: string, f: () => Promise<string>): Promise<DiagnoseStep> => {
    try {
      return { name, ok: true, code: 0, detail: await f() };
    } catch (e) {
      const err = e as TradeApiError;
      return { name, ok: false, code: err.code ?? null, detail: err.message };
    }
  };
  const nvdab = ctx.tokens.find((t) => t.symbol === 'NVDAB')!.address;
  const wallet = cfg.quoteWallet ?? undefined;
  const steps = [
    await step('RWA Data: token list', async () => `${(await cfg.api.rwaTokens()).length} tokens`),
    await step('Market: token search (USDT)', async () => `${(await cfg.api.searchToken('USDT')).length} hits`),
    await step('Trading: quote 1 USDT → USDC (not an equity token)', async () => {
      const r = await cfg.api.quote({ from: USDT_BSC, to: USDC_BSC, amount: 10n ** 18n });
      return r.length ? `${r.length} route(s), best ${bestRoute(r)!.vendorName}` : 'no route';
    }),
    await step(`Trading: quote 5 USDT → NVDAB${wallet ? ' (quote wallet)' : ' (no wallet)'}`, async () => {
      const r = await cfg.api.quote({ from: USDT_BSC, to: nvdab, amount: 5n * 10n ** 18n, wallet });
      return r.length ? `${r.length} route(s), ${bestRoute(r)!.executionMode}` : 'no route';
    }),
  ];
  const refused = steps.filter((s) => !s.ok && Number(s.code) === COMPLIANCE_CODE).map((s) => s.name);
  const unreachable = steps.filter((s) => !s.ok && /network error/.test(s.detail)).length;
  const reading =
    unreachable === steps.length
      ? 'The Binance Web3 API could not be reached from this machine (network error on every call), so nothing was learned about compliance. See each step for the reason.'
      : refused.length === 0
        ? steps.every((s) => s.ok)
          ? 'Every call succeeded: no compliance refusals.'
          : 'No compliance refusals, but some calls failed; see each step.'
        : refused.length === steps.length
          ? 'Every call is refused, including market data: the refusal is about where the server runs or the API key account, not the token.'
          : refused.every((n) => n.includes('NVDAB'))
            ? 'Only the equity-token quote is refused: tokenized stocks are restricted for this server location or account; other services work.'
            : 'Some calls are refused; see each step.';
  return { region, api: cfg.api.label, quoteWallet: Boolean(cfg.quoteWallet), steps, reading };
}
