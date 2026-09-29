/**
 * In-process JSON-RPC emulator. It answers the exact calls Shaddai makes
 * (eth_call incl. Multicall3.aggregate3, eth_getLogs, block headers) from a
 * scripted scenario. Token multiplier semantics mirror
 * bnb-chain/bep-677-contracts ERC8056BaseUpgradeable, so the demo and the
 * tests exercise the same decoding and timeline logic as mainnet.
 */
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  getAddress,
  keccak256,
  numberToHex,
  pad,
  toFunctionSelector,
  toHex,
  type Abi,
  type AbiFunction,
  type Address,
  type Hex,
} from 'viem';
import {
  erc20Abi,
  moolahAbi,
  multicall3Abi,
  ondoOracleAbi,
  scaledUiAbi,
  TOPICS,
  v2PairAbi,
  venusComptrollerAbi,
  venusOracleAbi,
  vTokenAbi,
} from '../core/abi.js';
import { MULTICALL3 } from '../core/registry.js';
import { classifyRpcError, type RpcTransport } from '../core/rpc.js';

const MAX = (1n << 256n) - 1n;
const ONE = 10n ** 18n;
const ZERO: Address = '0x0000000000000000000000000000000000000000';

export interface FakeSchedule {
  block: bigint;
  newMultiplier: bigint;
  effectiveAt: number;
}

export interface FakeTransfer {
  block: bigint;
  from: Address;
  to: Address;
  value: bigint;
}

export interface FakeToken {
  address: Address;
  symbol: string;
  name?: string;
  decimals: number;
  /** Implements BEP-677. False = plain ERC-20. */
  bep677: boolean;
  deployBlock: bigint;
  schedules: FakeSchedule[];
  transfers: FakeTransfer[];
}

export interface FakeVToken {
  address: Address;
  symbol: string;
  underlying: Address | null;
  exchangeRate: bigint;
  balances: Map<Address, bigint>;
  members: Set<Address>;
  /** Venus oracle price (1e(36-dec)). 0n = reverts. */
  price: bigint;
}

export interface FakeMoolahMarket {
  id: Hex;
  loanToken: Address;
  collateralToken: Address;
  lltv: bigint;
  /** [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares]; zeros if omitted. */
  totals?: [bigint, bigint, bigint, bigint];
  positions: Map<Address, { supplyShares: bigint; borrowShares: bigint; collateral: bigint }>;
}

export interface FakePair {
  address: Address;
  token0: Address;
  token1: Address;
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  balances: Map<Address, bigint>;
}

export interface FakeScenario {
  baseBlock: bigint;
  baseTimestamp: number;
  blockTimeMs: number;
  /** Returns the current head; lets the demo chain follow wall-clock time. */
  head: () => bigint;
  tokens: FakeToken[];
  venus?: { comptroller: Address; oracle: Address; vTokens: FakeVToken[] };
  moolah?: { address: Address; markets: FakeMoolahMarket[] };
  pairs?: FakePair[];
  ondoOracle?: {
    address: Address;
    values: Map<Address, { sValue: bigint; paused: boolean }>;
    /** sValue changes over time; each also emits an oracle log indexing the asset. */
    history?: { block: bigint; asset: Address; sValue: bigint }[];
  };
  /** Arbitrary extra logs (discovery tests: oracle updates, decoys). */
  extraLogs?: { address: Address; topics: Hex[]; data: Hex; block: bigint }[];
  /** Serve historical eth_call. False mimics a pruned node (128-block window). */
  archive: boolean;
  /** eth_getLogs range cap, to exercise adaptive chunking. */
  maxLogRange?: bigint;
}

class RpcFail extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

interface MultState {
  current: bigint;
  next: bigint;
  nextEff: bigint;
}

interface EmittedLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
}

const word = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v]);
/** Stand-in topic for the fixture oracle's update event; Shaddai never decodes it. */
const SVALUE_UPDATED = keccak256(toHex('SValueUpdated(address,uint128)'));
const addrTopic = (a: Address) => pad(a.toLowerCase() as Hex, { size: 32 });

export class FakeChain implements RpcTransport {
  readonly label = 'fixture-chain';
  private readonly selectors = new Map<Hex, { abi: Abi; fn: AbiFunction }>();
  private readonly tokens: Map<Address, FakeToken>;
  private readonly vTokens: Map<Address, FakeVToken>;
  private readonly pairs: Map<Address, FakePair>;
  private logs: EmittedLog[] | null = null;
  readonly calls: Record<string, number> = {};

  constructor(readonly s: FakeScenario) {
    for (const abi of [
      erc20Abi,
      scaledUiAbi,
      vTokenAbi,
      venusComptrollerAbi,
      venusOracleAbi,
      moolahAbi,
      v2PairAbi,
      ondoOracleAbi,
      multicall3Abi,
    ] as Abi[]) {
      for (const item of abi) {
        if (item.type !== 'function') continue;
        const sel = toFunctionSelector(item);
        if (!this.selectors.has(sel)) this.selectors.set(sel, { abi: [item], fn: item });
      }
    }
    this.tokens = new Map(s.tokens.map((t) => [getAddress(t.address), t]));
    this.vTokens = new Map((s.venus?.vTokens ?? []).map((v) => [getAddress(v.address), v]));
    this.pairs = new Map((s.pairs ?? []).map((p) => [getAddress(p.address), p]));
  }

  timestampOf(block: bigint): number {
    return this.s.baseTimestamp + Math.floor((Number(block - this.s.baseBlock) * this.s.blockTimeMs) / 1000);
  }

  blockAt(ts: number): bigint {
    // First block with timestamp >= ts.
    let b = this.s.baseBlock + BigInt(Math.floor(((ts - this.s.baseTimestamp) * 1000) / this.s.blockTimeMs));
    while (this.timestampOf(b) < ts) b++;
    while (this.timestampOf(b - 1n) >= ts) b--;
    return b;
  }

  /** Replays schedules up to `block`, exactly like ERC8056BaseUpgradeable._setUIMultiplier. */
  private multState(t: FakeToken, block: bigint): MultState {
    const st: MultState = { current: ONE, next: ONE, nextEff: MAX };
    for (const sc of t.schedules) {
      if (sc.block > block) break;
      const ts = BigInt(this.timestampOf(sc.block));
      if (ts >= st.nextEff) st.current = st.next;
      st.next = sc.newMultiplier;
      st.nextEff = BigInt(sc.effectiveAt);
    }
    return st;
  }

  private uiMultiplier(t: FakeToken, block: bigint): bigint {
    const st = this.multState(t, block);
    return BigInt(this.timestampOf(block)) >= st.nextEff ? st.next : st.current;
  }

  private hasPending(t: FakeToken, block: bigint): boolean {
    const st = this.multState(t, block);
    return BigInt(this.timestampOf(block)) < st.nextEff && st.nextEff !== MAX;
  }

  private balanceOf(t: FakeToken, who: Address, block: bigint): bigint {
    let b = 0n;
    const w = getAddress(who);
    for (const tr of t.transfers) {
      if (tr.block > block) continue;
      if (getAddress(tr.to) === w) b += tr.value;
      if (getAddress(tr.from) === w) b -= tr.value;
    }
    return b;
  }

  private totalSupply(t: FakeToken, block: bigint): bigint {
    let s = 0n;
    for (const tr of t.transfers) {
      if (tr.block > block) continue;
      if (tr.from === ZERO) s += tr.value;
      if (tr.to === ZERO) s -= tr.value;
    }
    return s;
  }

  private allLogs(): EmittedLog[] {
    if (this.logs) return this.logs;
    const logs: EmittedLog[] = [];
    let n = 0;
    const tx = () => pad(numberToHex(++n), { size: 32 });
    for (const t of this.tokens.values()) {
      if (t.bep677) {
        logs.push({
          address: t.address,
          topics: [TOPICS.multiplierUpdated3],
          data: `0x${[0n, ONE, BigInt(this.timestampOf(t.deployBlock))].map((v) => word(v).slice(2)).join('')}`,
          blockNumber: t.deployBlock,
          logIndex: 0,
          transactionHash: tx(),
        });
        const st: MultState = { current: ONE, next: ONE, nextEff: MAX };
        for (const sc of t.schedules) {
          const ts = BigInt(this.timestampOf(sc.block));
          const currentMult = ts >= st.nextEff ? st.next : st.current;
          const h = tx();
          if (ts < st.nextEff && st.nextEff !== MAX) {
            logs.push({
              address: t.address,
              topics: [TOPICS.multiplierOverwritten],
              data: `0x${[st.next, st.nextEff, sc.newMultiplier, BigInt(sc.effectiveAt)].map((v) => word(v).slice(2)).join('')}`,
              blockNumber: sc.block,
              logIndex: 0,
              transactionHash: h,
            });
          } else if (ts >= st.nextEff) st.current = st.next;
          st.next = sc.newMultiplier;
          st.nextEff = BigInt(sc.effectiveAt);
          logs.push({
            address: t.address,
            topics: [TOPICS.multiplierUpdated3],
            data: `0x${[currentMult, sc.newMultiplier, BigInt(sc.effectiveAt)].map((v) => word(v).slice(2)).join('')}`,
            blockNumber: sc.block,
            logIndex: 1,
            transactionHash: h,
          });
        }
      }
      t.transfers.forEach((tr, i) => {
        logs.push({
          address: t.address,
          topics: [TOPICS.transfer, addrTopic(tr.from), addrTopic(tr.to)],
          data: word(tr.value),
          blockNumber: tr.block,
          logIndex: 10 + i,
          transactionHash: tx(),
        });
      });
    }
    (this.s.ondoOracle?.history ?? []).forEach((h, i) =>
      logs.push({
        address: getAddress(this.s.ondoOracle!.address),
        topics: [SVALUE_UPDATED, addrTopic(h.asset)],
        data: word(h.sValue),
        blockNumber: h.block,
        logIndex: 500 + i,
        transactionHash: tx(),
      }),
    );
    (this.s.extraLogs ?? []).forEach((l, i) =>
      logs.push({
        address: getAddress(l.address),
        topics: l.topics,
        data: l.data,
        blockNumber: l.block,
        logIndex: 1000 + i,
        transactionHash: tx(),
      }),
    );
    logs.sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
    this.logs = logs;
    return logs;
  }

  private checkState(block: bigint) {
    const head = this.s.head();
    if (block > head) throw new RpcFail('header not found', -32000);
    if (!this.s.archive && head - block > 128n) throw new RpcFail(`missing trie node (block ${block})`, -32000);
  }

  private exec(to: Address, data: Hex, block: bigint): Hex {
    const target = getAddress(to);
    if (target === MULTICALL3) {
      const { args } = decodeFunctionData({ abi: multicall3Abi, data });
      const calls = args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[];
      const results = calls.map((c) => {
        try {
          return { success: true, returnData: this.exec(c.target, c.callData, block) };
        } catch (e) {
          if (!c.allowFailure) throw e;
          return { success: false, returnData: '0x' as Hex };
        }
      });
      return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: results });
    }
    const sel = data.slice(0, 10) as Hex;
    const entry = this.selectors.get(sel);
    const known =
      this.tokens.has(target) ||
      this.vTokens.has(target) ||
      this.pairs.has(target) ||
      target === this.s.venus?.comptroller ||
      target === this.s.venus?.oracle ||
      target === this.s.moolah?.address ||
      target === this.s.ondoOracle?.address;
    if (!known) return '0x'; // EOA / nothing deployed
    if (!entry) throw new RpcFail('execution reverted', 3);
    const { args = [] } = decodeFunctionData({ abi: entry.abi, data }) as { args?: readonly unknown[] };
    const result = this.dispatch(target, entry.fn.name, args, block);
    if (result === undefined) throw new RpcFail('execution reverted', 3);
    return encodeFunctionResult({ abi: entry.abi, functionName: entry.fn.name, result } as never);
  }

  private dispatch(target: Address, fn: string, args: readonly unknown[], block: bigint): unknown {
    const ts = BigInt(this.timestampOf(block));
    const tok = this.tokens.get(target);
    if (tok) {
      if (block < tok.deployBlock) return undefined;
      const bal = (a: unknown) => this.balanceOf(tok, a as Address, block);
      switch (fn) {
        case 'symbol':
          return tok.symbol;
        case 'name':
          return tok.name ?? tok.symbol;
        case 'decimals':
          return tok.decimals;
        case 'balanceOf':
          return bal(args[0]);
        case 'totalSupply':
          return this.totalSupply(tok, block);
      }
      if (!tok.bep677) return undefined;
      const m = this.uiMultiplier(tok, block);
      switch (fn) {
        case 'uiMultiplier':
          return m;
        case 'newUIMultiplier':
          return this.hasPending(tok, block) ? this.multState(tok, block).next : m;
        case 'effectiveAt':
          return this.hasPending(tok, block) ? this.multState(tok, block).nextEff : 0n;
        case 'hasPendingMultiplier':
          return this.hasPending(tok, block);
        case 'pendingMultiplier': {
          if (!this.hasPending(tok, block)) return [0n, 0n];
          const st = this.multState(tok, block);
          return [st.next, st.nextEff];
        }
        case 'balanceOfUI':
          return (bal(args[0]) * m) / ONE;
        case 'totalSupplyUI':
          return (this.totalSupply(tok, block) * m) / ONE;
        case 'toUIAmount':
          return ((args[0] as bigint) * m) / ONE;
        case 'fromUIAmount':
          return ((args[0] as bigint) * ONE) / m;
        case 'supportsInterface':
          return ['0xa60bf13d', '0x4bd27648', '0x57854fc3', '0xd890fd71', '0x01ffc9a7'].includes(
            String(args[0]).toLowerCase(),
          );
      }
      return undefined;
    }
    const v = this.vTokens.get(target);
    if (v) {
      switch (fn) {
        case 'underlying':
          return v.underlying ?? undefined;
        case 'balanceOf':
          return v.balances.get(getAddress(args[0] as Address)) ?? 0n;
        case 'exchangeRateStored':
          return v.exchangeRate;
        case 'symbol':
          return v.symbol;
      }
      return undefined;
    }
    const venus = this.s.venus;
    if (venus && target === venus.comptroller) {
      switch (fn) {
        case 'getAllMarkets':
          return venus.vTokens.map((x) => x.address);
        case 'checkMembership':
          return this.vTokens.get(getAddress(args[1] as Address))?.members.has(getAddress(args[0] as Address)) ?? false;
        case 'oracle':
          return venus.oracle;
      }
      return undefined;
    }
    if (venus && target === venus.oracle && fn === 'getUnderlyingPrice') {
      const p = this.vTokens.get(getAddress(args[0] as Address))?.price ?? 0n;
      return p > 0n ? p : undefined;
    }
    const moolah = this.s.moolah;
    if (moolah && target === moolah.address) {
      const m = moolah.markets.find((x) => x.id.toLowerCase() === String(args[0]).toLowerCase());
      if (fn === 'idToMarketParams') {
        return m ? [m.loanToken, m.collateralToken, ZERO, ZERO, m.lltv] : [ZERO, ZERO, ZERO, ZERO, 0n];
      }
      if (fn === 'market') {
        const t = m?.totals ?? [0n, 0n, 0n, 0n];
        return [t[0], t[1], t[2], t[3], 0n, 0n];
      }
      if (fn === 'position') {
        const p = m?.positions.get(getAddress(args[1] as Address));
        return p ? [p.supplyShares, p.borrowShares, p.collateral] : [0n, 0n, 0n];
      }
      return undefined;
    }
    const pair = this.pairs.get(target);
    if (pair) {
      switch (fn) {
        case 'token0':
          return pair.token0;
        case 'token1':
          return pair.token1;
        case 'getReserves':
          return [pair.reserve0, pair.reserve1, Number(ts & 0xffffffffn)];
        case 'totalSupply':
          return pair.totalSupply;
        case 'balanceOf':
          return pair.balances.get(getAddress(args[0] as Address)) ?? 0n;
      }
      return undefined;
    }
    const oracle = this.s.ondoOracle;
    if (oracle && target === oracle.address && fn === 'getSValue') {
      const asset = getAddress(args[0] as Address);
      const r = oracle.values.get(asset);
      const hist = (oracle.history ?? []).filter((h) => getAddress(h.asset) === asset);
      if (hist.length) {
        const past = hist.filter((h) => h.block <= block).sort((a, b) => (a.block < b.block ? -1 : 1));
        return [past.length ? past[past.length - 1]!.sValue : ONE, r?.paused ?? false];
      }
      return r ? [r.sValue, r.paused] : undefined;
    }
    return undefined;
  }

  private getLogs(f: { address?: Address | Address[]; topics?: (Hex | Hex[] | null)[]; fromBlock: Hex; toBlock: Hex }) {
    const from = BigInt(f.fromBlock);
    const to = BigInt(f.toBlock);
    if (this.s.maxLogRange !== undefined && to - from + 1n > this.s.maxLogRange) {
      throw new RpcFail(`exceed maximum block range: ${this.s.maxLogRange}`, -32005);
    }
    const addrs =
      f.address === undefined
        ? null
        : new Set((Array.isArray(f.address) ? f.address : [f.address]).map((a) => getAddress(a)));
    const topics = f.topics ?? [];
    return this.allLogs()
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to && l.blockNumber <= this.s.head())
      .filter((l) => !addrs || addrs.has(l.address))
      .filter((l) =>
        topics.every((t, i) => {
          if (t === null) return true;
          const want = (Array.isArray(t) ? t : [t]).map((x) => x.toLowerCase());
          return l.topics[i] !== undefined && want.includes(l.topics[i]!.toLowerCase());
        }),
      )
      .map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: numberToHex(l.blockNumber),
        logIndex: numberToHex(l.logIndex),
        transactionHash: l.transactionHash,
        removed: false,
      }));
  }

  async request<T>(method: string, params: unknown[]): Promise<T> {
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    try {
      return this.handle(method, params) as T;
    } catch (e) {
      if (e instanceof RpcFail) throw classifyRpcError({ code: e.code, message: e.message }, this.label);
      throw e;
    }
  }

  private handle(method: string, params: unknown[]): unknown {
    const head = this.s.head();
    switch (method) {
      case 'eth_chainId':
        return '0x38';
      case 'eth_blockNumber':
        return numberToHex(head);
      case 'eth_getBlockByNumber': {
        const tag = params[0] as string;
        const n = tag === 'latest' ? head : BigInt(tag);
        if (n > head || n < 0n) return null;
        return {
          number: numberToHex(n),
          timestamp: numberToHex(this.timestampOf(n)),
          hash: pad(numberToHex(n), { size: 32 }),
        };
      }
      case 'eth_call': {
        const [{ to, data }, tag] = params as [{ to: Address; data: Hex }, string];
        const block = tag === 'latest' ? head : BigInt(tag);
        this.checkState(block);
        return this.exec(to, data, block);
      }
      case 'eth_getLogs':
        return this.getLogs(params[0] as never);
      default:
        throw new RpcFail(`method ${method} not supported`, -32601);
    }
  }
}
