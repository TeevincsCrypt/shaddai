import { pad, type Address, type Hex } from 'viem';
import { ondoOracleAbi } from './abi.js';
import type { Chain, ReadCall } from './chain.js';
import type { DecodedMultiplierLog } from './events.js';
import type { TokenInfo } from './registry.js';
import { isPlausibleMultiplier } from './units.js';

export type OndoDecoded = DecodedMultiplierLog & { scheduledAt: number };

/**
 * Ondo sValue changes, as ledger events.
 *
 * The oracle's event layout is not published, so logs are only used to find
 * *when* an asset was touched. Old and new values come from getSValue(asset)
 * at the block before and the block itself (needs archive state). A log that
 * did not change the value (a pause toggle, a role change) is dropped.
 * sValue changes apply in the block they are written, so activation = that block.
 */
export async function fetchOndoSValueEvents(
  chain: Chain,
  oracle: Address,
  ondoTokens: TokenInfo[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ events: OndoDecoded[]; unresolved: number }> {
  if (!ondoTokens.length || fromBlock > toBlock) return { events: [], unresolved: 0 };
  const topicToToken = new Map(ondoTokens.map((t) => [pad(t.address.toLowerCase() as Hex, { size: 32 }), t.address]));
  const logs = await chain.getLogs({
    address: oracle,
    topics: [null, [...topicToToken.keys()]],
    fromBlock,
    toBlock,
  });

  // One entry per (block, asset); keep the first log for tx hash and ordering.
  const touched = new Map<string, { block: bigint; asset: Address; txHash: Hex; logIndex: number; ts?: number }>();
  for (const l of logs) {
    const asset = topicToToken.get(l.topics[1]?.toLowerCase() as Hex);
    if (!asset) continue;
    const key = `${l.blockNumber}:${asset}`;
    if (!touched.has(key)) {
      touched.set(key, {
        block: l.blockNumber,
        asset,
        txHash: l.transactionHash,
        logIndex: l.logIndex,
        ts: l.blockTimestamp,
      });
    }
  }
  const byBlock = new Map<bigint, { asset: Address; txHash: Hex; logIndex: number; ts?: number }[]>();
  for (const t of touched.values()) {
    const arr = byBlock.get(t.block) ?? [];
    arr.push(t);
    byBlock.set(t.block, arr);
  }

  const read = async (assets: Address[], block: bigint) => {
    const calls: ReadCall[] = assets.map((a) => ({
      to: oracle,
      abi: ondoOracleAbi,
      functionName: 'getSValue',
      args: [a],
    }));
    const res = await chain.readMany(calls, block);
    return res.map((r) => (r.ok ? (r.value as readonly [bigint, boolean])[0] : null));
  };

  const events: OndoDecoded[] = [];
  let unresolved = 0;
  const blocks = [...byBlock.keys()].sort((a, b) => (a < b ? -1 : 1));
  await Promise.all(
    blocks.map(async (block) => {
      const items = byBlock.get(block)!;
      const assets = items.map((i) => i.asset);
      let before: (bigint | null)[];
      let after: (bigint | null)[];
      try {
        [before, after] = await Promise.all([read(assets, block - 1n), read(assets, block)]);
      } catch {
        unresolved += items.length;
        return;
      }
      const ts = items[0]!.ts ?? (await chain.getBlock(block)).timestamp;
      items.forEach((it, k) => {
        const oldV = before[k];
        const newV = after[k];
        if (oldV == null || newV == null || !isPlausibleMultiplier(newV)) {
          unresolved++;
          return;
        }
        if (oldV === newV) return;
        events.push({
          token: it.asset,
          type: 'updated',
          layout: 'ondo-svalue',
          oldMultiplier: oldV,
          newMultiplier: newV,
          effectiveAt: BigInt(ts),
          blockNumber: block,
          logIndex: it.logIndex,
          txHash: it.txHash,
          blockTimestamp: ts,
          scheduledAt: ts,
        });
      });
    }),
  );
  events.sort((a, b) =>
    a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
  );
  return { events, unresolved };
}
