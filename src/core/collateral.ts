import { getAddress, type Address, type Hex } from 'viem';
import { moolahAbi, v2PairAbi, venusComptrollerAbi, venusOracleAbi, vTokenAbi } from './abi.js';
import type { BlockTag, Chain, ReadCall, ReadResult } from './chain.js';
import { tokenRef } from './events.js';
import type { ListaMarketSource } from './lista.js';
import type { MarkQuote, PoolRef } from './prices.js';
import type { TokenProbe } from './probe.js';
import { LINKS, LISTA_LISTED_SYMBOLS, type TokenInfo } from './registry.js';
import type { CheckStatus, CollateralListing, CollateralPosition, OracleCheck, Severity } from './types.js';
import { fixedToNumber, fmtAmount, fmtMultiplier, isNearOne, ONE, ratio, toUI } from './units.js';

export interface CollateralInput {
  chain: Chain;
  block: BlockTag;
  headTimestamp: number;
  holder: Address;
  tokens: TokenInfo[];
  probes: Map<Address, TokenProbe>;
  marks: Map<Address, MarkQuote>;
  pools: Map<Address, PoolRef[]>;
  venus: { comptroller: Address; known: { underlying: Address; vToken: Address; symbol: string }[] } | null;
  lista: { moolah: Address; source: ListaMarketSource | null; extraMarketIds: Hex[] } | null;
}

export interface CollateralOutput {
  positions: CollateralPosition[];
  listings: CollateralListing[];
  checks: CheckStatus[];
  /** underlying token -> vToken, for listings. */
  venusMarkets: Map<Address, Address>;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const ok = <T>(r: ReadResult | undefined): T | undefined => (r && r.ok ? (r.value as T) : undefined);
const dateOf = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Severity from the brief: info / watch (pending) / alert (>1% off or split-sized). */
export function severityFor(p: TokenProbe): { severity: Severity; reasons: string[] } {
  const reasons: string[] = [];
  let severity: Severity = 'info';
  const bump = (s: Severity) => {
    const rank = { info: 0, watch: 1, alert: 2 } as const;
    if (rank[s] > rank[severity]) severity = s;
  };
  const m = p.mult ?? ONE;
  if (!isNearOne(m, 100)) {
    bump('alert');
    reasons.push(`Multiplier ${fmtMultiplier(m)} is more than 1% away from 1.0.`);
  }
  if (p.pendingMult !== null && p.unit.pending) {
    const r = ratio(m, p.pendingMult);
    if (!isNearOne(r, 100)) {
      bump('alert');
      reasons.push(
        `Split-sized change scheduled${p.unit.pending.splitLabel ? ` (${p.unit.pending.splitLabel})` : ''} for ${dateOf(p.unit.pending.effectiveAt)}.`,
      );
    } else {
      bump('watch');
      reasons.push(`Multiplier update scheduled for ${dateOf(p.unit.pending.effectiveAt)}.`);
    }
  }
  if (p.unit.ondo?.paused) {
    bump('watch');
    reasons.push('Ondo oracle paused for a corporate action.');
  }
  if (reasons.length === 0) reasons.push('Multiplier within 1% of 1.0 and nothing scheduled.');
  return { severity, reasons };
}

function driftLines(p: TokenProbe, severity: Severity): string[] {
  const m = p.mult ?? ONE;
  if (p.unit.kind === 'none') {
    return [
      'No multiplier interface answered on this token, so Shaddai cannot size the drift. Treat displayed units as unverified.',
    ];
  }
  if (severity === 'alert') {
    const lines: string[] = [];
    if (!isNearOne(m, 100)) {
      const pct = (fixedToNumber(m > ONE ? m - ONE : ONE - m, 18) * 100).toFixed(2);
      lines.push(`Displayed shares and protocol units already differ by ${pct}%.`);
    }
    if (p.unit.pending && p.pendingMult !== null && !isNearOne(ratio(m, p.pendingMult), 100)) {
      lines.push(
        `A ${p.unit.pending.splitLabel ?? 'large'} change to ${fmtMultiplier(p.pendingMult)} takes effect ${dateOf(p.unit.pending.effectiveAt)}. After it, share count and protocol units diverge by that factor.`,
      );
    }
    lines.push('Check the market oracle before you add borrow.');
    return lines;
  }
  if (severity === 'watch' && p.unit.pending && p.pendingMult !== null) {
    return [
      `A multiplier update to ${fmtMultiplier(p.pendingMult)} is scheduled for ${dateOf(p.unit.pending.effectiveAt)}. Small today; watch it if you borrow against this.`,
    ];
  }
  return [
    'Drift is small today (dividend-scale). A split would make displayed shares and protocol units diverge. Check the market oracle before you add borrow.',
  ];
}

export function oracleCheck(
  oracleRawUsd: number | null,
  mark: MarkQuote | undefined,
  mult: bigint | null,
): OracleCheck {
  const dexRaw = mark?.rawUsd ?? null;
  if (oracleRawUsd === null) {
    return { oracleRawUsd, dexRawUsd: dexRaw, basis: 'unknown', note: 'Protocol oracle price not readable.' };
  }
  if (dexRaw === null) {
    return { oracleRawUsd, dexRawUsd: null, basis: 'unknown', note: 'No DEX mark to compare the oracle against.' };
  }
  const m = mult ?? ONE;
  if (isNearOne(m, 50)) {
    return {
      oracleRawUsd,
      dexRawUsd: dexRaw,
      basis: 'indistinguishable',
      note: 'Multiplier is within 0.5% of 1.0, so a per-token and a per-share oracle look the same today.',
    };
  }
  const dexShare = dexRaw / fixedToNumber(m, 18);
  const dRaw = Math.abs(oracleRawUsd - dexRaw) / dexRaw;
  const dShare = Math.abs(oracleRawUsd - dexShare) / dexShare;
  if (Math.min(dRaw, dShare) > 0.05) {
    return {
      oracleRawUsd,
      dexRawUsd: dexRaw,
      basis: 'unknown',
      note: 'Oracle is more than 5% from both the per-token and per-share DEX mark.',
    };
  }
  return dRaw <= dShare
    ? {
        oracleRawUsd,
        dexRawUsd: dexRaw,
        basis: 'raw',
        note: 'Oracle prices one raw token, which matches the raw balance the protocol counts.',
      }
    : {
        oracleRawUsd,
        dexRawUsd: dexRaw,
        basis: 'share',
        note: 'Oracle looks like a per-share price while the protocol counts raw tokens: collateral may be mis-stated by the multiplier.',
      };
}

async function venusScan(input: CollateralInput, out: CollateralOutput) {
  const { chain, block, holder, venus } = input;
  if (!venus) {
    out.checks.push({ name: 'Venus', status: 'skipped', detail: 'Venus disabled in config.' });
    return;
  }
  const registry = new Map(input.tokens.map((t) => [t.address, t]));
  const markets = new Map<Address, Address>();
  for (const k of venus.known) markets.set(k.underlying, k.vToken);

  let discovery = 'hardcoded vTokens only';
  try {
    const all = await chain.read<readonly Address[]>(
      { to: venus.comptroller, abi: venusComptrollerAbi, functionName: 'getAllMarkets' },
      block,
    );
    const und = await chain.readMany(
      all.map((v) => ({ to: v, abi: vTokenAbi, functionName: 'underlying' }) as ReadCall),
      block,
    );
    all.forEach((v, i) => {
      const u = ok<Address>(und[i]);
      if (u && registry.has(getAddress(u))) markets.set(getAddress(u), getAddress(v));
    });
    discovery = `${all.length} Core Pool markets scanned`;
  } catch (e) {
    discovery = `getAllMarkets() failed (${(e as Error).message.slice(0, 80)}); hardcoded vTokens only`;
  }
  out.venusMarkets = markets;

  const pairs = [...markets].filter(([u]) => registry.has(u));
  if (pairs.length === 0) {
    out.checks.push({ name: 'Venus', status: 'ok', detail: `${discovery}; no registry token listed.` });
    return;
  }

  let oracle: Address | undefined;
  try {
    oracle = await chain.read<Address>(
      { to: venus.comptroller, abi: venusComptrollerAbi, functionName: 'oracle' },
      block,
    );
  } catch {
    oracle = undefined;
  }

  const calls: ReadCall[] = [];
  for (const [, v] of pairs) {
    calls.push({ to: v, abi: vTokenAbi, functionName: 'balanceOf', args: [holder] });
    calls.push({ to: v, abi: vTokenAbi, functionName: 'exchangeRateStored' });
    calls.push({ to: venus.comptroller, abi: venusComptrollerAbi, functionName: 'checkMembership', args: [holder, v] });
    calls.push({ to: v, abi: vTokenAbi, functionName: 'symbol' });
    calls.push(
      oracle
        ? { to: oracle, abi: venusOracleAbi, functionName: 'getUnderlyingPrice', args: [v] }
        : { to: v, abi: vTokenAbi, functionName: 'symbol' },
    );
  }
  const res = await chain.readMany(calls, block);
  let failures = 0;
  pairs.forEach(([u, v], i) => {
    const [bal, rate, member, sym, price] = res.slice(i * 5, i * 5 + 5);
    const vBal = ok<bigint>(bal);
    const exRate = ok<bigint>(rate);
    if (vBal === undefined || exRate === undefined) {
      failures++;
      return;
    }
    if (vBal === 0n) return;
    const token = registry.get(u)!;
    const probe = input.probes.get(u);
    if (!probe) return;
    const raw = (vBal * exRate) / ONE;
    const shareEq = probe.mult !== null ? toUI(raw, probe.mult) : raw;
    const dec = probe.unit.decimals;
    const vSym = ok<string>(sym) ?? `v${token.symbol}`;
    const { severity, reasons } = severityFor(probe);
    const entered = ok<boolean>(member) ?? null;
    const priceRaw = oracle ? ok<bigint>(price) : undefined;
    const oracleRawUsd =
      priceRaw !== undefined && priceRaw > 0n ? fixedToNumber(priceRaw * 10n ** BigInt(dec), 36) : null;
    const lines = [
      `${token.symbol} on this address is supplied to Venus (${vSym} ${short(v)}).`,
      'Venus reads the ERC-20 balance, not balanceOfUI.',
      `Current raw: ${fmtAmount(raw, dec)} · multiplier: ${probe.mult !== null ? fmtMultiplier(probe.mult) : 'none found'} · share-eq: ${fmtAmount(shareEq, dec)}.`,
      ...driftLines(probe, severity),
    ];
    if (entered === false) lines.push('Supplied but not enabled as collateral (checkMembership is false).');
    out.positions.push({
      token: tokenRef(token),
      protocol: 'Venus',
      side: entered === false ? 'lend' : 'collateral',
      market: { label: vSym, address: v, url: LINKS.bscscanAddress(v) },
      raw: fmtAmount(raw, dec, dec, 0),
      shareEq: fmtAmount(shareEq, dec, dec, 0),
      multiplier: probe.unit.multiplier,
      enteredAsCollateral: entered,
      hasBorrow: null,
      severity,
      reasons,
      lines,
      oracle: oracleCheck(oracleRawUsd, input.marks.get(u), probe.mult),
    });
  });
  out.checks.push({
    name: 'Venus',
    status: failures ? 'partial' : 'ok',
    detail: `${discovery}; ${pairs.length} registry market(s) checked${failures ? `, ${failures} unreadable` : ''}.`,
  });
}

async function listaScan(input: CollateralInput, out: CollateralOutput) {
  const { chain, block, holder, lista } = input;
  if (!lista) {
    out.checks.push({ name: 'Lista', status: 'skipped', detail: 'Lista disabled in config.' });
    return;
  }
  const registry = new Map(input.tokens.map((t) => [t.address, t]));
  const ids = new Set<Hex>(lista.extraMarketIds);
  let discovery = '';
  if (lista.source) {
    try {
      for (const id of await lista.source.candidateMarkets(input.tokens, holder)) ids.add(id);
      discovery = `${lista.source.label}: ${ids.size} candidate market(s)`;
    } catch (e) {
      discovery = `${lista.source.label} unreachable (${(e as Error).message.slice(0, 80)})`;
    }
  }
  const idList = [...ids];
  if (idList.length === 0) {
    out.checks.push({
      name: 'Lista',
      status: 'partial',
      detail: `${discovery || 'no market source'}; positions not verifiable, falling back to listed-ticker warnings.`,
    });
    return;
  }
  const calls: ReadCall[] = idList.flatMap((id) => [
    { to: lista.moolah, abi: moolahAbi, functionName: 'idToMarketParams', args: [id] },
    { to: lista.moolah, abi: moolahAbi, functionName: 'position', args: [id, holder] },
    { to: lista.moolah, abi: moolahAbi, functionName: 'market', args: [id] },
  ]);
  const res = await chain.readMany(calls, block);
  let verified = 0;
  idList.forEach((id, i) => {
    const params = ok<readonly [Address, Address, Address, Address, bigint]>(res[i * 3]);
    const pos = ok<readonly [bigint, bigint, bigint]>(res[i * 3 + 1]);
    const mkt = ok<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(res[i * 3 + 2]);
    if (!params || !pos) return;
    const loanToken = getAddress(params[0]);
    const collateralToken = getAddress(params[1]);
    if (!registry.has(loanToken) && !registry.has(collateralToken)) return;
    verified++;
    const [supplyShares, borrowShares, collateral] = pos;
    const market = { label: `Market ${short(id)}`, id, url: `https://lista.org/lending/market/bsc/${id}` };
    const multLabel = (p: TokenProbe) => (p.mult !== null ? fmtMultiplier(p.mult) : 'none found');

    // Collateral side: the address owns these tokens, the market counts them raw.
    const cProbe = registry.has(collateralToken) ? input.probes.get(collateralToken) : undefined;
    if (cProbe && collateral > 0n) {
      const token = registry.get(collateralToken)!;
      const dec = cProbe.unit.decimals;
      const shareEq = cProbe.mult !== null ? toUI(collateral, cProbe.mult) : collateral;
      const { severity, reasons } = severityFor(cProbe);
      const hasBorrow = borrowShares > 0n;
      const lines = [
        `${token.symbol} on this address is posted as collateral on Lista Lending (market ${short(id)}).`,
        'Lista reads the ERC-20 balance, not balanceOfUI.',
        `Current raw: ${fmtAmount(collateral, dec)} · multiplier: ${multLabel(cProbe)} · share-eq: ${fmtAmount(shareEq, dec)}.`,
        ...driftLines(cProbe, severity),
      ];
      if (hasBorrow) lines.push('This market position has an open borrow.');
      out.positions.push({
        token: tokenRef(token),
        protocol: 'Lista',
        side: 'collateral',
        market,
        raw: fmtAmount(collateral, dec, dec, 0),
        shareEq: fmtAmount(shareEq, dec, dec, 0),
        multiplier: cProbe.unit.multiplier,
        enteredAsCollateral: true,
        hasBorrow,
        severity,
        reasons,
        lines,
        oracle: null,
      });
    }

    // Loan side: supply shares are tokens lent out; borrow shares are tokens owed.
    const lProbe = registry.has(loanToken) ? input.probes.get(loanToken) : undefined;
    if (lProbe && mkt && (supplyShares > 0n || borrowShares > 0n)) {
      const token = registry.get(loanToken)!;
      const dec = lProbe.unit.decimals;
      const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] = mkt;
      const { severity, reasons } = severityFor(lProbe);
      const noBorrowAdvice = (l: string) => !l.includes('add borrow');
      if (supplyShares > 0n) {
        const raw = sharesToAssetsDown(supplyShares, totalSupplyAssets, totalSupplyShares);
        const shareEq = lProbe.mult !== null ? toUI(raw, lProbe.mult) : raw;
        out.positions.push({
          token: tokenRef(token),
          protocol: 'Lista',
          side: 'lend',
          market,
          raw: fmtAmount(raw, dec, dec, 0),
          shareEq: fmtAmount(shareEq, dec, dec, 0),
          multiplier: lProbe.unit.multiplier,
          enteredAsCollateral: false,
          hasBorrow: null,
          severity,
          reasons,
          lines: [
            `${token.symbol} on this address is lent out on Lista Lending (market ${short(id)}).`,
            'The market counts what you supplied in raw ERC-20 units, not balanceOfUI.',
            `Supplied raw: ${fmtAmount(raw, dec)} · multiplier: ${multLabel(lProbe)} · share-eq: ${fmtAmount(shareEq, dec)} (as of the market's last interest accrual).`,
            ...driftLines(lProbe, severity).filter(noBorrowAdvice),
          ],
          oracle: null,
        });
      }
      if (borrowShares > 0n) {
        const raw = sharesToAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
        const shareEq = lProbe.mult !== null ? toUI(raw, lProbe.mult) : raw;
        out.positions.push({
          token: tokenRef(token),
          protocol: 'Lista',
          side: 'borrow',
          market,
          raw: fmtAmount(raw, dec, dec, 0),
          shareEq: fmtAmount(shareEq, dec, dec, 0),
          multiplier: lProbe.unit.multiplier,
          enteredAsCollateral: null,
          hasBorrow: true,
          severity,
          reasons,
          lines: [
            `This address has borrowed ${token.symbol} on Lista Lending (market ${short(id)}) and owes it back in raw tokens.`,
            'Each multiplier increase makes every raw token worth more, including the ones owed, so a borrower pays the reinvested dividend.',
            `Owed raw: ${fmtAmount(raw, dec)} · multiplier: ${multLabel(lProbe)} · owed share-eq: ${fmtAmount(shareEq, dec)} (as of the market's last interest accrual).`,
            ...driftLines(lProbe, severity).filter(noBorrowAdvice),
          ],
          oracle: null,
        });
      }
    }
  });
  out.checks.push({
    name: 'Lista',
    status: 'ok',
    detail: `${discovery ? `${discovery}; ` : ''}${verified} market(s) verified on Moolah via idToMarketParams(); collateral, lending and borrowing read with position().`,
  });
}

/** Morpho-style share math (Lista Moolah is a Morpho Blue fork): virtual shares 1e6, virtual assets 1. */
const VIRTUAL_SHARES = 10n ** 6n;
export function sharesToAssetsDown(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  return (shares * (totalAssets + 1n)) / (totalShares + VIRTUAL_SHARES);
}
export function sharesToAssetsUp(shares: bigint, totalAssets: bigint, totalShares: bigint): bigint {
  const d = totalShares + VIRTUAL_SHARES;
  return (shares * (totalAssets + 1n) + d - 1n) / d;
}

async function lpScan(input: CollateralInput, out: CollateralOutput) {
  const { chain, block, holder } = input;
  const registry = new Map(input.tokens.map((t) => [t.address, t]));
  const entries: { token: Address; pool: PoolRef }[] = [];
  const seen = new Set<string>();
  for (const [token, pools] of input.pools) {
    for (const pool of pools) {
      if (pool.labels.some((l) => /v3|v4|infinity|cl/i.test(l))) continue;
      const k = `${token}:${pool.pair}`;
      if (seen.has(k)) continue;
      seen.add(k);
      entries.push({ token, pool });
    }
  }
  if (entries.length === 0) {
    out.checks.push({
      name: 'DEX LP (V2)',
      status: 'ok',
      detail: 'No V2-style pools known for held tokens. V3 positions are not scanned.',
    });
    return;
  }
  const bals = await chain.readMany(
    entries.map((e) => ({ to: e.pool.pair, abi: v2PairAbi, functionName: 'balanceOf', args: [holder] }) as ReadCall),
    block,
  );
  const held = entries.filter((_, i) => (ok<bigint>(bals[i]) ?? 0n) > 0n);
  const lpBal = new Map(entries.map((e, i) => [e.pool.pair, ok<bigint>(bals[i]) ?? 0n]));
  let found = 0;
  if (held.length) {
    const res = await chain.readMany(
      held.flatMap((e) => [
        { to: e.pool.pair, abi: v2PairAbi, functionName: 'totalSupply' },
        { to: e.pool.pair, abi: v2PairAbi, functionName: 'getReserves' },
        { to: e.pool.pair, abi: v2PairAbi, functionName: 'token0' },
      ]),
      block,
    );
    held.forEach((e, i) => {
      const supply = ok<bigint>(res[i * 3]);
      const reserves = ok<readonly [bigint, bigint, number]>(res[i * 3 + 1]);
      const t0 = ok<Address>(res[i * 3 + 2]);
      if (!supply || !reserves || !t0 || supply === 0n) return;
      const token = registry.get(e.token)!;
      const probe = input.probes.get(e.token);
      if (!probe) return;
      const reserve = getAddress(t0) === e.token ? reserves[0] : reserves[1];
      const raw = (reserve * lpBal.get(e.pool.pair)!) / supply;
      if (raw === 0n) return;
      const dec = probe.unit.decimals;
      const shareEq = probe.mult !== null ? toUI(raw, probe.mult) : raw;
      const { severity, reasons } = severityFor(probe);
      const dexName = e.pool.dex === 'pancakeswap' ? 'PancakeSwap V2' : `${e.pool.dex} (V2-style)`;
      found++;
      out.positions.push({
        token: tokenRef(token),
        protocol: 'PancakeSwap V2',
        side: 'lp',
        market: {
          label: `${e.pool.token0Symbol}/${e.pool.token1Symbol} LP`,
          address: e.pool.pair,
          url: e.pool.url ?? LINKS.bscscanAddress(e.pool.pair),
        },
        raw: fmtAmount(raw, dec, dec, 0),
        shareEq: fmtAmount(shareEq, dec, dec, 0),
        multiplier: probe.unit.multiplier,
        enteredAsCollateral: null,
        hasBorrow: null,
        severity,
        reasons,
        lines: [
          `${token.symbol} on this address sits in a ${dexName} pool (${short(e.pool.pair)}).`,
          'The pool holds raw tokens and its price is per raw token; your LP balance says nothing about the multiplier.',
          `Your share of the pool: ${fmtAmount(raw, dec)} raw · multiplier: ${probe.mult !== null ? fmtMultiplier(probe.mult) : 'none found'} · share-eq: ${fmtAmount(shareEq, dec)}.`,
          ...driftLines(probe, severity).filter((l) => !l.includes('borrow')),
        ],
        oracle: null,
      });
    });
  }
  out.checks.push({
    name: 'DEX LP (V2)',
    status: 'ok',
    detail: `${entries.length} V2-style pool(s) checked, ${found} LP position(s) found. V3 positions are not scanned.`,
  });
}

function listings(input: CollateralInput, out: CollateralOutput) {
  const supplied = new Set(out.positions.map((p) => `${p.protocol}:${p.token.address}`));
  const listaVerified = out.checks.find((c) => c.name === 'Lista')?.status === 'ok';
  for (const t of input.tokens) {
    const p = input.probes.get(t.address);
    if (!p || p.raw === 0n) continue;
    const dec = p.unit.decimals;
    const mark = input.marks.get(t.address);
    const dust = mark ? fixedToNumber(p.raw, dec) * mark.rawUsd < 1 : p.raw < 10n ** BigInt(Math.max(dec - 6, 0));
    if (dust) continue;
    const ui = fmtAmount(p.shareEq, dec);
    const raw = fmtAmount(p.raw, dec);
    const counts = (proto: string) =>
      p.mult === null || p.mult === ONE
        ? `${proto} will count ${raw} tokens. That equals ${ui} share-equivalents only while the multiplier stays at 1.0.`
        : `${proto} will count ${raw} tokens, not ${ui} share-equivalents.`;
    if (out.venusMarkets.has(t.address) && !supplied.has(`Venus:${t.address}`)) {
      out.listings.push({
        token: tokenRef(t),
        protocol: 'Venus',
        severity: 'info',
        lines: [`${t.symbol} is a Venus Core Pool market. If you supply the ${raw} in this wallet, ${counts('Venus')}`],
      });
    }
    if (LISTA_LISTED_SYMBOLS.has(t.symbol) && !supplied.has(`Lista:${t.address}`)) {
      out.listings.push({
        token: tokenRef(t),
        protocol: 'Lista',
        severity: 'info',
        lines: [
          `${t.symbol} is listed as Lista Lending collateral. If you post the ${raw} in this wallet, ${counts('Lista')}`,
          ...(listaVerified ? [] : ['Lista positions for this address could not be verified on-chain in this scan.']),
        ],
      });
    }
  }
}

export async function scanCollateral(input: CollateralInput): Promise<CollateralOutput> {
  const out: CollateralOutput = { positions: [], listings: [], checks: [], venusMarkets: new Map() };
  const guard = async (name: string, f: () => Promise<void>) => {
    try {
      await f();
    } catch (e) {
      out.checks.push({ name, status: 'unavailable', detail: (e as Error).message.slice(0, 160) });
    }
  };
  await Promise.all([
    guard('Venus', () => venusScan(input, out)),
    guard('Lista', () => listaScan(input, out)),
    guard('DEX LP (V2)', () => lpScan(input, out)),
  ]);
  listings(input, out);
  const rank = { alert: 0, watch: 1, info: 2 } as const;
  out.positions.sort((a, b) => rank[a.severity] - rank[b.severity] || a.token.symbol.localeCompare(b.token.symbol));
  return out;
}
