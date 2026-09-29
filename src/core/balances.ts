import { pad, type Address } from 'viem';
import { erc20Abi, TOPICS } from './abi.js';
import { TooManyLogsError, type Chain, type RawLog } from './chain.js';
import type { RawAtEventSource } from './types.js';

export interface RawAt {
  raw: bigint | null;
  source: RawAtEventSource;
  note?: string;
}

export interface RawAtOptions {
  /** Refuse to replay more Transfer logs than this (busy contracts). */
  maxLogs?: number;
  /** Skip the archive attempt (known pruned node). */
  skipArchive?: boolean;
}

/**
 * Raw balance of `holder` at the end of each target block.
 *
 * 1. Historical eth_call balanceOf (exact; needs an archive node).
 * 2. Replay: current balance minus Transfers after the block (exact if the
 *    token only moves through Transfer, which ERC-20 guarantees).
 * 3. Fall back to the current balance and say so.
 */
export async function rawAtBlocks(
  chain: Chain,
  token: Address,
  holder: Address,
  targets: bigint[],
  head: bigint,
  currentRaw: bigint,
  opts: RawAtOptions = {},
): Promise<Map<bigint, RawAt>> {
  const out = new Map<bigint, RawAt>();
  const pending = [...new Set(targets)].filter((t) => t <= head);
  for (const t of targets)
    if (t > head)
      out.set(t, { raw: currentRaw, source: 'assumed-current', note: 'Block is in the future; current balance used.' });

  if (!opts.skipArchive) {
    const remaining: bigint[] = [];
    for (const t of pending) {
      if (remaining.length) {
        remaining.push(t);
        continue;
      }
      try {
        const v = await chain.read<bigint>({ to: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder] }, t);
        out.set(t, { raw: v, source: 'archive' });
      } catch {
        remaining.push(t);
      }
    }
    pending.splice(0, pending.length, ...remaining);
  }
  if (pending.length === 0) return out;

  const minT = pending.reduce((a, b) => (b < a ? b : a));
  const holderTopic = pad(holder.toLowerCase() as Address, { size: 32 });
  let incoming: RawLog[];
  let outgoing: RawLog[];
  try {
    [incoming, outgoing] = await Promise.all([
      chain.getLogs(
        { address: token, topics: [TOPICS.transfer, null, holderTopic], fromBlock: minT + 1n, toBlock: head },
        { maxLogs: opts.maxLogs },
      ),
      chain.getLogs(
        { address: token, topics: [TOPICS.transfer, holderTopic], fromBlock: minT + 1n, toBlock: head },
        { maxLogs: opts.maxLogs },
      ),
    ]);
  } catch (e) {
    const why =
      e instanceof TooManyLogsError
        ? `Too many transfers to replay (> ${e.limit}); current balance used.`
        : `No archive state and Transfer replay failed (${(e as Error).message.slice(0, 120)}); current balance used.`;
    for (const t of pending) out.set(t, { raw: currentRaw, source: 'assumed-current', note: why });
    return out;
  }

  const value = (l: RawLog) => BigInt(l.data);
  for (const t of pending) {
    let raw = currentRaw;
    for (const l of incoming) if (l.blockNumber > t) raw -= value(l);
    for (const l of outgoing) if (l.blockNumber > t) raw += value(l);
    if (raw < 0n) {
      out.set(t, { raw: null, source: 'unavailable', note: 'Transfer replay went negative; history is incomplete.' });
    } else {
      out.set(t, { raw, source: 'replay' });
    }
  }
  return out;
}
