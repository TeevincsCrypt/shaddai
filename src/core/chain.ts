import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  numberToHex,
  type Abi,
  type Address,
  type Hex,
} from 'viem';
import { multicall3Abi } from './abi.js';
import { MULTICALL3 } from './registry.js';
import { CallRevertedError, RANGE_RE, RpcError, StateUnavailableError, type RpcTransport } from './rpc.js';

export type BlockTag = bigint | 'latest';

export interface BlockHeader {
  number: bigint;
  timestamp: number;
  hash: Hex;
}

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  /** Some nodes include it in eth_getLogs; saves a header fetch. */
  blockTimestamp?: number;
}

export interface LogFilter {
  address: Address | Address[];
  topics: (Hex | Hex[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

export interface ReadCall {
  to: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type ReadResult = { ok: true; value: unknown } | { ok: false; error: string };

export class TooManyLogsError extends Error {
  constructor(readonly limit: number) {
    super(`more than ${limit} logs; refusing to replay`);
    this.name = 'TooManyLogsError';
  }
}

export interface ChainOptions {
  /** Separate transport for eth_getLogs (defaults to rpc). */
  logRpc?: RpcTransport;
  logChunk?: number;
  minLogChunk?: number;
  maxLogChunk?: number;
  logConcurrency?: number;
  multicall?: Address | null;
  multicallBatch?: number;
}

const toTag = (b: BlockTag) => (b === 'latest' ? 'latest' : numberToHex(b));

export class Chain {
  readonly rpc: RpcTransport;
  readonly logRpc: RpcTransport;
  private readonly blockCache = new Map<bigint, Promise<BlockHeader>>();
  private logChunk: bigint;
  private readonly minLogChunk: bigint;
  private readonly maxLogChunk: bigint;
  private readonly logConcurrency: number;
  private readonly multicallAddr: Address | null;
  private readonly multicallBatch: number;
  /** Counters surfaced in /api/status and the DevEx notes. */
  readonly stats = { calls: 0, multicalls: 0, logRequests: 0, logSplits: 0, headers: 0 };

  constructor(rpc: RpcTransport, opts: ChainOptions = {}) {
    this.rpc = rpc;
    this.logRpc = opts.logRpc ?? rpc;
    this.logChunk = BigInt(opts.logChunk ?? 50_000);
    this.minLogChunk = BigInt(opts.minLogChunk ?? 500);
    this.maxLogChunk = BigInt(opts.maxLogChunk ?? 200_000);
    this.logConcurrency = opts.logConcurrency ?? 4;
    this.multicallAddr = opts.multicall === undefined ? MULTICALL3 : opts.multicall;
    this.multicallBatch = opts.multicallBatch ?? 120;
  }

  async chainId(): Promise<number> {
    return Number(BigInt(await this.rpc.request<Hex>('eth_chainId', [])));
  }

  async blockNumber(): Promise<bigint> {
    return BigInt(await this.rpc.request<Hex>('eth_blockNumber', []));
  }

  getBlock(n: bigint): Promise<BlockHeader> {
    let p = this.blockCache.get(n);
    if (!p) {
      this.stats.headers++;
      p = this.rpc
        .request<{ number: Hex; timestamp: Hex; hash: Hex } | null>('eth_getBlockByNumber', [numberToHex(n), false])
        .then((b) => {
          if (!b) throw new RpcError(`block ${n} not found`);
          return { number: BigInt(b.number), timestamp: Number(BigInt(b.timestamp)), hash: b.hash };
        });
      p.catch(() => this.blockCache.delete(n));
      this.blockCache.set(n, p);
    }
    return p;
  }

  async call(to: Address, data: Hex, block: BlockTag = 'latest'): Promise<Hex> {
    this.stats.calls++;
    return this.rpc.request<Hex>('eth_call', [{ to, data }, toTag(block)]);
  }

  /** Single typed read; throws on revert or undecodable output. */
  async read<T = unknown>(c: ReadCall, block: BlockTag = 'latest'): Promise<T> {
    const data = encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as never);
    const out = await this.call(c.to, data, block);
    return decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data: out } as never) as T;
  }

  /**
   * Batched reads through Multicall3.aggregate3 with allowFailure. Falls back
   * to one eth_call per read if the aggregate itself fails.
   */
  async readMany(calls: ReadCall[], block: BlockTag = 'latest'): Promise<ReadResult[]> {
    if (calls.length === 0) return [];
    const encoded = calls.map((c) =>
      encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args ?? [] } as never),
    );
    const decode = (i: number, ok: boolean, data: Hex): ReadResult => {
      if (!ok) return { ok: false, error: 'reverted' };
      if (data === '0x') return { ok: false, error: 'empty return (not a contract or no such function)' };
      try {
        const c = calls[i]!;
        return {
          ok: true,
          value: decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data } as never),
        };
      } catch (e) {
        return { ok: false, error: `undecodable: ${(e as Error).message.split('\n')[0]}` };
      }
    };

    const out: ReadResult[] = new Array(calls.length);
    if (this.multicallAddr) {
      try {
        const batches: number[][] = [];
        for (let i = 0; i < calls.length; i += this.multicallBatch) {
          batches.push([...Array(Math.min(this.multicallBatch, calls.length - i)).keys()].map((k) => k + i));
        }
        await Promise.all(
          batches.map(async (idx) => {
            this.stats.multicalls++;
            const data = encodeFunctionData({
              abi: multicall3Abi,
              functionName: 'aggregate3',
              args: [idx.map((i) => ({ target: calls[i]!.to, allowFailure: true, callData: encoded[i]! }))],
            });
            const raw = await this.call(this.multicallAddr!, data, block);
            const res = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: raw }) as readonly {
              success: boolean;
              returnData: Hex;
            }[];
            idx.forEach((i, k) => {
              const r = res[k]!;
              out[i] = decode(i, r.success, r.returnData);
            });
          }),
        );
        return out;
      } catch (e) {
        if (e instanceof StateUnavailableError) throw e;
        // fall through to individual calls
      }
    }
    await Promise.all(
      calls.map(async (c, i) => {
        try {
          const raw = await this.call(c.to, encoded[i]!, block);
          out[i] = decode(i, true, raw);
        } catch (e) {
          if (e instanceof StateUnavailableError) throw e;
          out[i] = e instanceof CallRevertedError ? { ok: false, error: 'reverted' } : { ok: false, error: (e as Error).message };
        }
      }),
    );
    return out;
  }

  /**
   * eth_getLogs over an arbitrary range. Ranges are fetched by a small worker
   * pool; a range the node rejects as too large is split in half and retried.
   */
  async getLogs(
    filter: LogFilter,
    opts: { maxLogs?: number; onProgress?: (done: bigint, total: bigint) => void } = {},
  ): Promise<RawLog[]> {
    if (filter.fromBlock > filter.toBlock) return [];
    const total = filter.toBlock - filter.fromBlock + 1n;
    let done = 0n;
    const queue: [bigint, bigint][] = [];
    for (let from = filter.fromBlock; from <= filter.toBlock; from += this.logChunk) {
      const to = from + this.logChunk - 1n;
      queue.push([from, to > filter.toBlock ? filter.toBlock : to]);
    }
    const results: RawLog[] = [];
    let fatal: unknown;
    const addr = Array.isArray(filter.address) ? filter.address : filter.address;

    const worker = async () => {
      while (queue.length && !fatal) {
        const [from, to] = queue.shift()!;
        try {
          this.stats.logRequests++;
          const logs = await this.logRpc.request<
            {
              address: Hex;
              topics: Hex[];
              data: Hex;
              blockNumber: Hex;
              transactionHash: Hex;
              logIndex: Hex;
              blockTimestamp?: Hex;
              removed?: boolean;
            }[]
          >('eth_getLogs', [{ address: addr, topics: filter.topics, fromBlock: numberToHex(from), toBlock: numberToHex(to) }]);
          for (const l of logs) {
            if (l.removed) continue;
            results.push({
              address: getAddress(l.address),
              topics: l.topics,
              data: l.data,
              blockNumber: BigInt(l.blockNumber),
              transactionHash: l.transactionHash,
              logIndex: Number(BigInt(l.logIndex)),
              blockTimestamp: l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : undefined,
            });
          }
          if (opts.maxLogs !== undefined && results.length > opts.maxLogs) {
            fatal = new TooManyLogsError(opts.maxLogs);
            return;
          }
          done += to - from + 1n;
          opts.onProgress?.(done, total);
          if (this.logChunk < this.maxLogChunk && to - from + 1n >= this.logChunk) {
            this.logChunk = (this.logChunk * 5n) / 4n;
          }
        } catch (e) {
          const size = to - from + 1n;
          const splittable = size > this.minLogChunk && !(e instanceof CallRevertedError);
          if (splittable && (e instanceof RpcError || RANGE_RE.test((e as Error).message))) {
            this.stats.logSplits++;
            const mid = from + size / 2n;
            queue.unshift([from, mid - 1n], [mid, to]);
            const half = size / 2n;
            if (half < this.logChunk) this.logChunk = half < this.minLogChunk ? this.minLogChunk : half;
            continue;
          }
          fatal = e;
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: this.logConcurrency }, worker));
    if (fatal) throw fatal;
    results.sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
    return results;
  }

  async timestampOf(log: RawLog): Promise<number> {
    if (log.blockTimestamp !== undefined) return log.blockTimestamp;
    return (await this.getBlock(log.blockNumber)).timestamp;
  }

  /**
   * First block whose timestamp is >= ts, searched in [lo, hi].
   * Returns hi + 1 when ts is after block hi (i.e. in the future).
   * Alternates interpolation and bisection so uneven block times still converge.
   */
  async blockAtOrAfter(ts: number, lo: bigint, hi: bigint): Promise<bigint> {
    let loB = await this.getBlock(lo);
    if (loB.timestamp >= ts) return lo;
    let hiB = await this.getBlock(hi);
    if (hiB.timestamp < ts) return hi + 1n;
    // invariant: ts(lo) < ts <= ts(hi)
    let step = 0;
    while (hiB.number - loB.number > 1n) {
      let mid: bigint;
      const span = hiB.number - loB.number;
      if (step++ % 2 === 0 && hiB.timestamp > loB.timestamp) {
        const frac = (ts - loB.timestamp) / (hiB.timestamp - loB.timestamp);
        mid = loB.number + BigInt(Math.floor(Number(span) * frac));
      } else {
        mid = loB.number + span / 2n;
      }
      if (mid <= loB.number) mid = loB.number + 1n;
      if (mid >= hiB.number) mid = hiB.number - 1n;
      const m = await this.getBlock(mid);
      if (m.timestamp >= ts) hiB = m;
      else loB = m;
    }
    return hiB.number;
  }
}
