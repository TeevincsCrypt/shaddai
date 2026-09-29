import type { Address } from 'viem';
import { backedAbi, erc20Abi, ondoOracleAbi, scaledUiAbi, SCALED_UI_INTERFACE_ID } from './abi.js';
import type { BlockTag, Chain, ReadCall, ReadResult } from './chain.js';
import type { TokenInfo } from './registry.js';
import type { OndoInfo, PendingMultiplier, UnitModel } from './types.js';
import { classifyChange, isPlausibleMultiplier, multiplierString, ONE, ratio, toUI } from './units.js';

export interface TokenProbe {
  token: TokenInfo;
  unit: UnitModel;
  /** Multiplier as bigint (1e18 fixed), or null. */
  mult: bigint | null;
  pendingMult: bigint | null;
  raw: bigint;
  /** Contract's own balanceOfUI(holder), if exposed. */
  balanceOfUI: bigint | null;
  shareEq: bigint;
  shareEqSource: 'balanceOfUI' | 'computed' | 'sValue' | 'raw';
  readable: boolean;
}

const val = <T>(r: ReadResult | undefined): T | undefined => (r && r.ok ? (r.value as T) : undefined);

/**
 * Reads every token's unit surface at one block. The issuer's documented model
 * is only a hint: a token is treated as BEP-677 because uiMultiplier() answers
 * with a plausible value, not because the registry says so.
 */
export async function probeTokens(
  chain: Chain,
  tokens: TokenInfo[],
  holder: Address | null,
  block: BlockTag,
  headTimestamp: number,
  opts: { ondoOracle?: Address | null } = {},
): Promise<Map<Address, TokenProbe>> {
  const FIELDS = [
    'symbol',
    'decimals',
    'balanceOf',
    'uiMultiplier',
    'newUIMultiplier',
    'effectiveAt',
    'balanceOfUI',
    'supportsInterface',
    'multiplier',
    'getSValue',
  ] as const;
  type Field = (typeof FIELDS)[number];

  const calls: ReadCall[] = [];
  const index: { token: number; field: Field }[] = [];
  const push = (ti: number, field: Field, c: ReadCall) => {
    calls.push(c);
    index.push({ token: ti, field });
  };

  tokens.forEach((tk, i) => {
    const a = tk.address;
    push(i, 'symbol', { to: a, abi: erc20Abi, functionName: 'symbol' });
    push(i, 'decimals', { to: a, abi: erc20Abi, functionName: 'decimals' });
    if (holder) {
      push(i, 'balanceOf', { to: a, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
      push(i, 'balanceOfUI', { to: a, abi: scaledUiAbi, functionName: 'balanceOfUI', args: [holder] });
    }
    push(i, 'uiMultiplier', { to: a, abi: scaledUiAbi, functionName: 'uiMultiplier' });
    push(i, 'newUIMultiplier', { to: a, abi: scaledUiAbi, functionName: 'newUIMultiplier' });
    push(i, 'effectiveAt', { to: a, abi: scaledUiAbi, functionName: 'effectiveAt' });
    push(i, 'supportsInterface', {
      to: a,
      abi: scaledUiAbi,
      functionName: 'supportsInterface',
      args: [SCALED_UI_INTERFACE_ID],
    });
    if (tk.model === 'xstocks') push(i, 'multiplier', { to: a, abi: backedAbi, functionName: 'multiplier' });
    if (tk.model === 'ondo' && opts.ondoOracle) {
      push(i, 'getSValue', { to: opts.ondoOracle, abi: ondoOracleAbi, functionName: 'getSValue', args: [a] });
    }
  });

  const results = await chain.readMany(calls, block);
  const byToken: Partial<Record<Field, ReadResult>>[] = tokens.map(() => ({}));
  results.forEach((r, k) => {
    const { token, field } = index[k]!;
    byToken[token]![field] = r;
  });

  const out = new Map<Address, TokenProbe>();
  tokens.forEach((tk, i) => {
    const r = byToken[i]!;
    const notes: string[] = [];
    const onChainSymbol = val<string>(r.symbol) ?? null;
    const decimalsRead = val<number>(r.decimals);
    const decimals = decimalsRead ?? 18;
    const readable = onChainSymbol !== null || decimalsRead !== undefined;
    if (!readable) notes.push('symbol() and decimals() both failed: no ERC-20 answered at this address.');
    else if (decimalsRead === undefined) notes.push('decimals() failed; assuming 18.');
    const symbolMismatch = onChainSymbol !== null && onChainSymbol !== tk.symbol;
    if (symbolMismatch) notes.push(`On-chain symbol() is "${onChainSymbol}", registry expects "${tk.symbol}".`);

    let raw = 0n;
    if (holder) {
      const b = val<bigint>(r.balanceOf);
      if (b === undefined) {
        if (readable) notes.push('balanceOf() failed.');
      } else raw = b;
    }

    const supports = r.supportsInterface?.ok ? (r.supportsInterface.value as boolean) : null;
    const uiMult = val<bigint>(r.uiMultiplier);
    let mult: bigint | null = null;
    let kind: UnitModel['kind'] = 'none';
    if (uiMult !== undefined) {
      if (isPlausibleMultiplier(uiMult)) {
        mult = uiMult;
        kind = 'bep677';
      } else {
        notes.push(`uiMultiplier() returned ${uiMult}, outside any plausible 1e18-scaled range; ignored.`);
      }
    } else if (tk.model === 'bep677' && readable) {
      notes.push('uiMultiplier() not available on this contract; the registry expected BEP-677.');
    }
    if (supports === false && kind === 'bep677') {
      notes.push('uiMultiplier() answers but supportsInterface(0xa60bf13d) is false.');
    }

    // Pending: EIP-8056 says effectiveAt() is 0 and newUIMultiplier() == uiMultiplier()
    // when nothing is scheduled, so "pending" is effectiveAt > now, not new != current.
    let pending: PendingMultiplier | null = null;
    let pendingMult: bigint | null = null;
    const eff = val<bigint>(r.effectiveAt);
    const next = val<bigint>(r.newUIMultiplier);
    if (kind === 'bep677' && eff !== undefined && next !== undefined && eff > BigInt(headTimestamp)) {
      if (isPlausibleMultiplier(next)) {
        const cls = classifyChange(mult!, next);
        pendingMult = next;
        pending = {
          multiplier: multiplierString(next),
          effectiveAt: Number(eff),
          kind: cls.kind,
          splitLabel: cls.splitLabel,
          ratio: cls.ratio,
        };
      }
    }

    // Ondo sValue (economic shares per token), read from the configured oracle.
    let ondo: OndoInfo | null = null;
    if (tk.model === 'ondo') {
      ondo = { status: 'not-configured', oracle: opts.ondoOracle ?? null, sValue: null, paused: null, driftVsUi: null };
      if (opts.ondoOracle) {
        const sv = val<readonly [bigint, boolean]>(r.getSValue);
        if (sv && isPlausibleMultiplier(sv[0])) {
          ondo.status = 'ok';
          ondo.sValue = multiplierString(sv[0]);
          ondo.paused = sv[1];
          if (mult !== null) {
            const drift = ratio(mult, sv[0]);
            ondo.driftVsUi = multiplierString(drift);
            const off = drift > ONE ? drift - ONE : ONE - drift;
            if (off * 1000n > ONE) {
              notes.push(
                `Wallet multiplier ${multiplierString(mult)} and Ondo sValue ${ondo.sValue} disagree by more than 0.1%.`,
              );
            }
          } else {
            mult = sv[0];
            kind = 'ondo-svalue';
          }
          if (sv[1]) notes.push('Ondo oracle is paused for this asset (corporate action in progress).');
        } else {
          ondo.status = 'unavailable';
          notes.push(
            sv
              ? `getSValue() returned ${sv[0]}, not a recognised 1e18-scaled value.`
              : 'getSValue() on the configured Ondo oracle failed for this asset.',
          );
        }
      }
    }

    const backed = val<bigint>(r.multiplier);
    if (backed !== undefined && kind === 'none') {
      notes.push(
        `multiplier() = ${multiplierString(backed)} exists, but how it relates to balanceOf on BSC is unverified; not applied.`,
      );
    }

    let shareEq = raw;
    let shareEqSource: TokenProbe['shareEqSource'] = 'raw';
    const bUI = val<bigint>(r.balanceOfUI) ?? null;
    if (kind === 'bep677' && mult !== null) {
      const computed = toUI(raw, mult);
      if (bUI !== null) {
        shareEq = bUI;
        shareEqSource = 'balanceOfUI';
        if (bUI !== computed) {
          notes.push(`balanceOfUI() = ${bUI} differs from raw × uiMultiplier / 1e18 = ${computed}.`);
        }
      } else {
        shareEq = computed;
        shareEqSource = 'computed';
      }
    } else if (kind === 'ondo-svalue' && mult !== null) {
      shareEq = toUI(raw, mult);
      shareEqSource = 'sValue';
    }
    if (kind === 'none' && readable) {
      notes.push(
        ondo?.status === 'not-configured'
          ? 'No wallet multiplier and no Ondo oracle configured (ONDO_SSO_ADDRESS): 1 token is shown as 1 share, unverified.'
          : 'No multiplier found: 1 token is treated as 1 share, unverified.',
      );
    }

    out.set(tk.address, {
      token: tk,
      mult,
      pendingMult,
      raw,
      balanceOfUI: bUI,
      shareEq,
      shareEqSource,
      readable,
      unit: {
        token: tk.address,
        kind,
        multiplier: mult === null ? null : multiplierString(mult),
        pending,
        ondo,
        onChainSymbol,
        symbolMismatch,
        decimals,
        supportsScaledUiInterface: supports,
        notes,
      },
    });
  });
  return out;
}
