import type { Address } from 'viem';
import { rawAtBlocks, type RawAtOptions } from './balances.js';
import type { Chain } from './chain.js';
import type { TokenProbe } from './probe.js';
import type { LedgerRow, MultiplierEvent, Price } from './types.js';
import { decimalString, fixedToNumber, ONE } from './units.js';

export const WITHHOLDING_NOTE = 'Net of typical 30% US withholding. Not tax advice.';
export const NO_TRANSFER_NOTE = 'No Transfer event. Tax exporters will miss this.';

const parseFixed = (s: string, decimals = 18): bigint => {
  const [w, f = ''] = s.split('.');
  return BigInt(w!) * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
};

export interface LedgerInput {
  chain: Chain;
  holder: Address;
  head: { number: bigint; timestamp: number };
  events: MultiplierEvent[];
  probes: Map<Address, TokenProbe>;
  prices: Map<Address, Price>;
  /** Tokens the address holds through a protocol (Venus, Lista, LP) right now. */
  protocolExposure: Map<Address, string[]>;
  rawAt?: RawAtOptions;
}

/**
 * Per-address statement of multiplier events. Covers tokens the address holds
 * now (wallet or protocol). Δ share-eq uses the *wallet* raw balance at the
 * block before the change took effect.
 */
export async function buildLedger(input: LedgerInput): Promise<LedgerRow[]> {
  const { chain, holder, head, probes, prices } = input;
  const relevant = new Set<Address>();
  for (const [a, p] of probes) if (p.raw > 0n) relevant.add(a);
  for (const a of input.protocolExposure.keys()) relevant.add(a);

  const events = input.events.filter((e) => e.kind !== 'init' && relevant.has(e.token.address));
  const byToken = new Map<Address, MultiplierEvent[]>();
  for (const e of events) {
    const arr = byToken.get(e.token.address) ?? [];
    arr.push(e);
    byToken.set(e.token.address, arr);
  }

  const rows: LedgerRow[] = [];
  await Promise.all(
    [...byToken].map(async ([token, evs]) => {
      const probe = probes.get(token)!;
      const decimals = probe.unit.decimals;
      // Resolve effective blocks the indexer has not pinned yet.
      const effBlocks = new Map<string, bigint>();
      for (const e of evs) {
        if (e.status !== 'effective') continue;
        if (e.effectiveBlock) effBlocks.set(e.id, BigInt(e.effectiveBlock));
        else {
          const b = await chain.blockAtOrAfter(e.effectiveAt, BigInt(e.scheduledBlock), head.number);
          if (b <= head.number) effBlocks.set(e.id, b);
        }
      }
      // State at the end of the block before activation = holdings the change applied to.
      const targets = [...effBlocks.values()].map((b) => b - 1n);
      const raws =
        probe.raw > 0n || targets.length
          ? await rawAtBlocks(chain, token, holder, targets, head.number, probe.raw, input.rawAt)
          : new Map();

      for (const e of evs) {
        const notes: string[] = [];
        const oldM = parseFixed(e.oldMultiplier);
        const newM = parseFixed(e.newMultiplier);
        let rawAtEvent: bigint | null = null;
        let source: LedgerRow['rawAtEventSource'] = 'unavailable';
        let effectiveBlock = e.effectiveBlock;

        if (e.status === 'effective') {
          const b = effBlocks.get(e.id);
          if (b !== undefined) {
            effectiveBlock = b.toString();
            const r = raws.get(b - 1n);
            if (r) {
              rawAtEvent = r.raw;
              source = r.source;
              if (r.note) notes.push(r.note);
            }
          } else notes.push('Could not locate the activation block.');
        } else if (e.status === 'pending') {
          rawAtEvent = probe.raw;
          source = 'assumed-current';
          notes.push('Pending: projected with the current wallet balance.');
        } else {
          notes.push('Scheduled, then overwritten before it took effect. No balance change.');
        }

        let delta: bigint | null = null;
        let estUsd: number | null = null;
        if (rawAtEvent !== null && e.status !== 'overwritten') {
          delta = (rawAtEvent * (newM - oldM)) / ONE;
          const price = prices.get(token);
          if (e.kind === 'split' || e.kind === 'reverse-split') {
            notes.push('Split: share count changes, value does not. No USD credit.');
          } else if (price?.shareUsd != null) {
            estUsd = fixedToNumber(delta, decimals) * price.shareUsd;
          }
        }

        if (e.eventLayout === 'ondo-svalue') {
          notes.push('Ondo sValue change on the oracle, read before and after; the token contract emitted nothing.');
        }
        if (e.kind === 'dividend-reinvest') notes.push(WITHHOLDING_NOTE);
        else if (estUsd !== null) notes.push('Estimate. Not tax advice.');
        if (e.status !== 'overwritten') notes.push(NO_TRANSFER_NOTE);
        if (estUsd !== null) notes.push('USD at the current mark, not the price on the day.');
        const exposure = input.protocolExposure.get(token);
        if (exposure?.length) {
          notes.push(`Also held via ${exposure.join(', ')}; that portion is not in raw_at_event.`);
        }
        if (source === 'assumed-current' && e.status === 'effective') {
          notes.push('raw_at_event is the current balance, not a historical read.');
        }

        rows.push({
          ...e,
          effectiveBlock,
          rawAtEvent: rawAtEvent === null ? null : decimalString(rawAtEvent, decimals),
          rawAtEventSource: source,
          deltaShareEq: delta === null ? null : decimalString(delta, decimals),
          estUsd,
          usdBasis: estUsd === null ? 'none' : 'current-mark',
          notes,
        });
      }
    }),
  );
  rows.sort((a, b) => b.effectiveAt - a.effectiveAt || a.token.symbol.localeCompare(b.token.symbol));
  return rows;
}
