import { getAddress, pad, type Address, type Hex } from 'viem';
import { ondoOracleAbi } from './abi.js';
import type { Chain, ReadCall } from './chain.js';
import type { TokenInfo } from './registry.js';
import { isPlausibleMultiplier } from './units.js';

/**
 * Finds Ondo's SyntheticSharesOracle on BSC without a published address.
 *
 * 1. Scan recent logs from *any* contract whose first or second indexed topic
 *    is an Ondo token address. An oracle that updates sValue per asset emits
 *    exactly that; almost nothing else does.
 * 2. Every contract seen for two or more Ondo tokens, plus any hint addresses,
 *    is called with getSValue(asset) for every Ondo token.
 * 3. A contract that answers with a plausible 1e18-scaled sValue for a majority
 *    of Ondo tokens is the oracle. Nothing is adopted on log evidence alone.
 */

export interface OracleCandidate {
  address: Address;
  /** Distinct Ondo tokens this contract emitted indexed events for. */
  tokensSeen: number;
  /** Distinct topic0 values it emitted with an Ondo token indexed. */
  eventTopics: Hex[];
  /** Ondo tokens for which getSValue(asset) returned a plausible value. */
  answered: number;
  source: 'logs' | 'hint';
}

export interface OracleDiscovery {
  found: Address | null;
  answered: number;
  total: number;
  scannedFrom: string | null;
  scannedTo: string;
  candidates: OracleCandidate[];
  notes: string[];
}

export interface DiscoveryOptions {
  /** How far back to look (default ~10 days of BSC blocks). */
  lookbackBlocks?: bigint;
  /** Blocks per backward step; each step goes through Chain.getLogs' adaptive splitting. */
  window?: bigint;
  budgetMs?: number;
  /** Unverified addresses to test as well (e.g. search hits). */
  hints?: Address[];
  log?: (line: string) => void;
}

export async function discoverOndoOracle(
  chain: Chain,
  ondoTokens: TokenInfo[],
  head: bigint,
  opts: DiscoveryOptions = {},
): Promise<OracleDiscovery> {
  const log = opts.log ?? (() => undefined);
  const lookback = opts.lookbackBlocks ?? 2_000_000n;
  const window = opts.window ?? 200_000n;
  const budget = opts.budgetMs ?? 90_000;
  const started = Date.now();
  const notes: string[] = [];
  const tokenSet = new Set(ondoTokens.map((t) => t.address.toLowerCase()));
  const tokenTopics = ondoTokens.map((t) => pad(t.address.toLowerCase() as Hex, { size: 32 }));
  const seen = new Map<Address, { tokens: Set<string>; topics: Set<Hex> }>();

  const verify = async (addresses: Address[]): Promise<Map<Address, number>> => {
    const calls: ReadCall[] = addresses.flatMap((a) =>
      ondoTokens.map((t) => ({ to: a, abi: ondoOracleAbi, functionName: 'getSValue', args: [t.address] }) as ReadCall),
    );
    const res = await chain.readMany(calls, head);
    const out = new Map<Address, number>();
    addresses.forEach((a, i) => {
      let n = 0;
      for (let k = 0; k < ondoTokens.length; k++) {
        const r = res[i * ondoTokens.length + k];
        if (r?.ok) {
          const [sValue] = r.value as readonly [bigint, boolean];
          if (isPlausibleMultiplier(sValue)) n++;
        }
      }
      out.set(a, n);
    });
    return out;
  };

  const majority = Math.ceil(ondoTokens.length / 2);
  const candidates = new Map<Address, OracleCandidate>();
  const judge = async (addrs: Address[], source: OracleCandidate['source']) => {
    const fresh = addrs.filter((a) => !candidates.has(a));
    if (!fresh.length) return null;
    const answered = await verify(fresh);
    for (const a of fresh) {
      const s = seen.get(a);
      candidates.set(a, {
        address: a,
        tokensSeen: s?.tokens.size ?? 0,
        eventTopics: [...(s?.topics ?? [])],
        answered: answered.get(a) ?? 0,
        source,
      });
    }
    return fresh.find((a) => (answered.get(a) ?? 0) >= majority) ?? null;
  };

  // Hints first: cheap, and conclusive if one of them is the oracle.
  let found = opts.hints?.length ? await judge(opts.hints, 'hint') : null;

  let scannedFrom: bigint | null = null;
  const floor = head > lookback ? head - lookback : 0n;
  let to = head;
  while (!found && to > floor) {
    if (Date.now() - started > budget) {
      notes.push(`Time budget reached after scanning back to block ${scannedFrom ?? head}.`);
      break;
    }
    const from = to - window + 1n > floor ? to - window + 1n : floor;
    for (const position of [1, 2]) {
      const topics: (Hex | Hex[] | null)[] = position === 1 ? [null, tokenTopics] : [null, null, tokenTopics];
      const logs = await chain.getLogs({ topics, fromBlock: from, toBlock: to });
      for (const l of logs) {
        if (tokenSet.has(l.address.toLowerCase())) continue; // the token's own events
        const t = l.topics[position]?.slice(-40);
        if (!t) continue;
        const entry = seen.get(l.address) ?? { tokens: new Set<string>(), topics: new Set<Hex>() };
        entry.tokens.add(t);
        if (l.topics[0]) entry.topics.add(l.topics[0]);
        seen.set(l.address, entry);
      }
    }
    scannedFrom = from;
    log(`ondo discovery: blocks ${from}–${head}, ${seen.size} contract(s) emitted Ondo-indexed events`);
    const multi = [...seen].filter(([, v]) => v.tokens.size >= 2).map(([a]) => a);
    found = await judge(multi, 'logs');
    to = from - 1n;
  }

  // Single-token emitters are weak evidence, but test them before giving up.
  if (!found) {
    const singles = [...seen].filter(([, v]) => v.tokens.size === 1).map(([a]) => a);
    if (singles.length) found = await judge(singles.slice(0, 50), 'logs');
  }

  const list = [...candidates.values()].sort((a, b) => b.answered - a.answered || b.tokensSeen - a.tokensSeen);
  if (!found) {
    notes.push(
      list.length
        ? `No candidate answered getSValue(asset) for at least ${majority} of ${ondoTokens.length} Ondo tokens.`
        : 'No contract emitted events indexing an Ondo token in the scanned range.',
    );
  }
  return {
    found,
    answered: found ? (candidates.get(found)?.answered ?? 0) : 0,
    total: ondoTokens.length,
    scannedFrom: scannedFrom?.toString() ?? null,
    scannedTo: head.toString(),
    candidates: list.slice(0, 20),
    notes,
  };
}

/**
 * Unverified addresses from a web search for "SyntheticSharesOracle" on BscScan.
 * Tested on-chain like any other candidate; never trusted on their own.
 */
export const ONDO_ORACLE_SEARCH_HINTS: Address[] = [
  '0x2484487c395bc0b5abacad334b9ab063c3c5f636',
  '0x7B7c49DBa058d978aF747e8B4054cF0830A9b491',
  '0x308bfaeAaC8BDab6e9Fc5Ead8EdCb5f95b0599d9',
  '0x4fce25bae8c12943b972c7aae0a0491bc9d22525',
].map((a) => getAddress(a.toLowerCase()));
