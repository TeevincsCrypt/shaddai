import { decodeEventLog, type Address, type Hex } from 'viem';
import { multiplierEvent4Abi, multiplierEventsAbi, TOPICS } from './abi.js';
import type { KV } from './cache.js';
import type { Chain, RawLog } from './chain.js';
import type { TokenInfo } from './registry.js';
import type { MultiplierEvent, TokenRef } from './types.js';
import { fetchOndoSValueEvents } from './ondo-events.js';
import { classifyChange, multiplierString } from './units.js';

export interface DecodedMultiplierLog {
  token: Address;
  type: 'updated' | 'overwritten' | 'cancelled';
  layout: 'bep677-3' | 'variant-4' | 'ondo-svalue';
  oldMultiplier: bigint;
  newMultiplier: bigint;
  effectiveAt: bigint;
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  blockTimestamp?: number;
}

export const MULTIPLIER_TOPICS: Hex[] = [
  TOPICS.multiplierUpdated3,
  TOPICS.multiplierUpdated4,
  TOPICS.multiplierOverwritten,
  TOPICS.multiplierCancelled,
];

export function decodeMultiplierLog(log: RawLog): DecodedMultiplierLog | null {
  const topic0 = log.topics[0];
  const base = {
    token: log.address,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    txHash: log.transactionHash,
    blockTimestamp: log.blockTimestamp,
  };
  try {
    if (topic0 === TOPICS.multiplierUpdated3) {
      const d = decodeEventLog({ abi: multiplierEventsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const a = d.args as { oldMultiplier: bigint; newMultiplier: bigint; effectiveAtTimestamp: bigint };
      return {
        ...base,
        type: 'updated',
        layout: 'bep677-3',
        oldMultiplier: a.oldMultiplier,
        newMultiplier: a.newMultiplier,
        effectiveAt: a.effectiveAtTimestamp,
      };
    }
    if (topic0 === TOPICS.multiplierUpdated4) {
      const d = decodeEventLog({ abi: multiplierEvent4Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const a = d.args as { oldMultiplier: bigint; newMultiplier: bigint; effectiveAtTimestamp: bigint };
      return {
        ...base,
        type: 'updated',
        layout: 'variant-4',
        oldMultiplier: a.oldMultiplier,
        newMultiplier: a.newMultiplier,
        effectiveAt: a.effectiveAtTimestamp,
      };
    }
    if (topic0 === TOPICS.multiplierOverwritten) {
      const d = decodeEventLog({ abi: multiplierEventsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const a = d.args as { overwrittenMultiplier: bigint; overwrittenEffectiveAt: bigint };
      return {
        ...base,
        type: 'overwritten',
        layout: 'bep677-3',
        oldMultiplier: 0n,
        newMultiplier: a.overwrittenMultiplier,
        effectiveAt: a.overwrittenEffectiveAt,
      };
    }
    if (topic0 === TOPICS.multiplierCancelled) {
      const d = decodeEventLog({ abi: multiplierEventsAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      const a = d.args as { cancelledMultiplier: bigint; cancelledEffectiveAt: bigint };
      return {
        ...base,
        type: 'cancelled',
        layout: 'bep677-3',
        oldMultiplier: 0n,
        newMultiplier: a.cancelledMultiplier,
        effectiveAt: a.cancelledEffectiveAt,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function tokenRef(t: TokenInfo): TokenRef {
  return {
    symbol: t.symbol,
    ticker: t.ticker,
    name: t.name,
    issuer: t.issuer,
    address: t.address,
    needsVerification: t.needsVerification,
    note: t.note,
    demoOnly: t.demoOnly,
  };
}

/**
 * Turns decoded logs into a per-token timeline.
 *
 * The event fires when a change is *scheduled*; the multiplier only switches
 * once block.timestamp >= effectiveAt. A schedule is "overwritten" when a later
 * UIMultiplierUpdated for the same token lands before it took effect, or a
 * cancel/overwrite event names it.
 */
export function buildTimeline(
  decoded: (DecodedMultiplierLog & { scheduledAt: number })[],
  tokens: Map<Address, TokenInfo>,
  headTimestamp: number,
  effectiveBlocks: Map<string, bigint>,
): MultiplierEvent[] {
  const byToken = new Map<Address, (DecodedMultiplierLog & { scheduledAt: number })[]>();
  for (const d of decoded) {
    if (!tokens.has(d.token)) continue;
    const arr = byToken.get(d.token) ?? [];
    arr.push(d);
    byToken.set(d.token, arr);
  }
  const out: MultiplierEvent[] = [];
  for (const [token, list] of byToken) {
    list.sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
    const updates = list.filter((d) => d.type === 'updated');
    const kills = list.filter((d) => d.type !== 'updated');
    updates.forEach((u, i) => {
      const id = `${u.txHash}:${u.logIndex}`;
      const later = updates.slice(i + 1);
      const supersededByLater = later.some((l) => l.scheduledAt < Number(u.effectiveAt));
      const killed = kills.some(
        (k) =>
          k.newMultiplier === u.newMultiplier &&
          k.effectiveAt === u.effectiveAt &&
          (k.blockNumber > u.blockNumber || (k.blockNumber === u.blockNumber && k.logIndex > u.logIndex)),
      );
      const cls = classifyChange(u.oldMultiplier, u.newMultiplier);
      let status: MultiplierEvent['status'];
      if (supersededByLater || killed) status = 'overwritten';
      else if (Number(u.effectiveAt) > headTimestamp) status = 'pending';
      else status = 'effective';
      const eb = effectiveBlocks.get(id);
      out.push({
        id,
        token: tokenRef(tokens.get(token)!),
        kind: cls.kind,
        splitLabel: cls.splitLabel,
        status,
        oldMultiplier: multiplierString(u.oldMultiplier),
        newMultiplier: multiplierString(u.newMultiplier),
        ratio: cls.ratio,
        scheduledAt: u.scheduledAt,
        scheduledBlock: u.blockNumber.toString(),
        txHash: u.txHash,
        logIndex: u.logIndex,
        effectiveAt: Number(u.effectiveAt),
        effectiveBlock: status === 'effective' && eb !== undefined ? eb.toString() : null,
        eventLayout: u.layout,
      });
    });
  }
  out.sort((a, b) => b.effectiveAt - a.effectiveAt || b.scheduledAt - a.scheduledAt);
  return out;
}

interface FeedCacheShape {
  version: number;
  tokensKey: string;
  fromBlock: string;
  scannedTo: string;
  logs: (Omit<DecodedMultiplierLog, 'oldMultiplier' | 'newMultiplier' | 'effectiveAt' | 'blockNumber'> & {
    oldMultiplier: string;
    newMultiplier: string;
    effectiveAt: string;
    blockNumber: string;
    scheduledAt: number;
  })[];
  effectiveBlocks: Record<string, string>;
}

const CACHE_VERSION = 3;

export interface FeedSnapshot {
  status: 'ready' | 'indexing' | 'unavailable';
  progress?: number;
  error?: string;
  scannedFrom?: bigint;
  scannedTo?: bigint;
  decoded: (DecodedMultiplierLog & { scheduledAt: number })[];
  effectiveBlocks: Map<string, bigint>;
}

/**
 * Keeps the global multiplier-event index for the whole registry. Scans are
 * incremental and persisted, so only new blocks are fetched after the first run.
 */
export class FeedIndexer {
  private decoded: (DecodedMultiplierLog & { scheduledAt: number })[] = [];
  private effectiveBlocks = new Map<string, bigint>();
  private scannedTo: bigint | null = null;
  private fromBlock: bigint | null = null;
  private status: FeedSnapshot['status'] = 'indexing';
  private progress = 0;
  private error: string | undefined;
  private inflight: Promise<void> | null = null;
  private loaded = false;
  private readonly tokensKey: string;

  constructor(
    private readonly chain: Chain,
    private readonly tokens: TokenInfo[],
    private readonly kv: KV,
    private readonly startBlock: () => Promise<bigint>,
    private readonly cacheKey = 'feed',
    /** Ondo's SyntheticSharesOracle; its sValue changes are indexed alongside BEP-677 events. */
    private readonly ondoOracle: Address | null = null,
  ) {
    this.tokensKey = [
      ...tokens.map((t) => t.address.toLowerCase()).sort(),
      `ondo:${ondoOracle?.toLowerCase() ?? '-'}`,
    ].join(',');
  }

  /** sValue logs the oracle emitted that could not be turned into old/new values (no archive state). */
  ondoUnresolved = 0;

  snapshot(): FeedSnapshot {
    return {
      status: this.status,
      progress: this.progress,
      error: this.error,
      scannedFrom: this.fromBlock ?? undefined,
      scannedTo: this.scannedTo ?? undefined,
      decoded: this.decoded,
      effectiveBlocks: this.effectiveBlocks,
    };
  }

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    const c = await this.kv.get<FeedCacheShape>(this.cacheKey);
    if (!c || c.version !== CACHE_VERSION || c.tokensKey !== this.tokensKey) return;
    this.fromBlock = BigInt(c.fromBlock);
    this.scannedTo = BigInt(c.scannedTo);
    this.decoded = c.logs.map((l) => ({
      ...l,
      oldMultiplier: BigInt(l.oldMultiplier),
      newMultiplier: BigInt(l.newMultiplier),
      effectiveAt: BigInt(l.effectiveAt),
      blockNumber: BigInt(l.blockNumber),
    }));
    this.effectiveBlocks = new Map(Object.entries(c.effectiveBlocks).map(([k, v]) => [k, BigInt(v)]));
    this.status = 'ready';
    this.progress = 1;
  }

  private async save() {
    if (this.scannedTo === null || this.fromBlock === null) return; // nothing scanned yet
    const shape: FeedCacheShape = {
      version: CACHE_VERSION,
      tokensKey: this.tokensKey,
      fromBlock: (this.fromBlock ?? 0n).toString(),
      scannedTo: (this.scannedTo ?? 0n).toString(),
      logs: this.decoded.map((d) => ({
        ...d,
        oldMultiplier: d.oldMultiplier.toString(),
        newMultiplier: d.newMultiplier.toString(),
        effectiveAt: d.effectiveAt.toString(),
        blockNumber: d.blockNumber.toString(),
      })),
      effectiveBlocks: Object.fromEntries([...this.effectiveBlocks].map(([k, v]) => [k, v.toString()])),
    };
    await this.kv.set(this.cacheKey, shape);
  }

  /** Loads the persisted index (cache or deploy-time snapshot) without touching the chain. */
  async loadPersisted(): Promise<void> {
    await this.load();
  }

  /** True while a scan is in flight in this process. */
  get running(): boolean {
    return this.inflight !== null;
  }

  /** Loads persisted state, resolves the start block, and returns the next block to scan. */
  async nextBlock(): Promise<bigint> {
    await this.load();
    if (this.fromBlock === null) this.fromBlock = await this.startBlock();
    return this.scannedTo === null ? this.fromBlock : this.scannedTo + 1n;
  }

  /** Bring the index up to `head`. Concurrent callers share one scan. */
  refresh(head: { number: bigint; timestamp: number }): Promise<void> {
    if (!this.inflight) {
      this.inflight = this.doRefresh(head).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async doRefresh(head: { number: bigint; timestamp: number }) {
    await this.load();
    try {
      if (this.fromBlock === null) this.fromBlock = await this.startBlock();
      const from = this.scannedTo === null ? this.fromBlock : this.scannedTo + 1n;
      if (from <= head.number) {
        if (this.scannedTo === null) this.status = 'indexing';
        const logs = await this.chain.getLogs(
          {
            address: this.tokens.map((t) => t.address),
            topics: [MULTIPLIER_TOPICS],
            fromBlock: from,
            toBlock: head.number,
          },
          {
            onProgress: (done, total) => {
              if (this.status === 'indexing') this.progress = Number(done) / Number(total);
            },
          },
        );
        // Commit only after the whole range decoded, so a failed header fetch
        // cannot leave half a batch behind to be appended again on retry.
        const batch: (DecodedMultiplierLog & { scheduledAt: number })[] = [];
        for (const log of logs) {
          const d = decodeMultiplierLog(log);
          if (!d) continue;
          batch.push({ ...d, scheduledAt: await this.chain.timestampOf(log) });
        }
        const ondoTokens = this.tokens.filter((t) => t.model === 'ondo');
        if (this.ondoOracle && ondoTokens.length) {
          const o = await fetchOndoSValueEvents(this.chain, this.ondoOracle, ondoTokens, from, head.number);
          batch.push(...o.events);
          this.ondoUnresolved += o.unresolved;
          // sValue applies in the block it is written: pin activation to that block.
          for (const e of o.events) this.effectiveBlocks.set(`${e.txHash}:${e.logIndex}`, e.blockNumber);
        }
        this.decoded.push(...batch);
        this.scannedTo = head.number;
      }
      await this.resolveEffectiveBlocks(head);
      this.status = 'ready';
      this.progress = 1;
      this.error = undefined;
      await this.save();
    } catch (e) {
      this.error = (e as Error).message;
      if (this.scannedTo === null) this.status = 'unavailable';
      throw e;
    }
  }

  private async resolveEffectiveBlocks(head: { number: bigint; timestamp: number }) {
    const tokenMap = new Map(this.tokens.map((t) => [t.address, t]));
    const timeline = buildTimeline(this.decoded, tokenMap, head.timestamp, this.effectiveBlocks);
    for (const ev of timeline) {
      if (ev.status !== 'effective' || this.effectiveBlocks.has(ev.id)) continue;
      const b = await this.chain.blockAtOrAfter(ev.effectiveAt, BigInt(ev.scheduledBlock), head.number);
      if (b <= head.number) this.effectiveBlocks.set(ev.id, b);
    }
  }

  timeline(headTimestamp: number): MultiplierEvent[] {
    const tokenMap = new Map(this.tokens.map((t) => [t.address, t]));
    return buildTimeline(this.decoded, tokenMap, headTimestamp, this.effectiveBlocks);
  }
}
