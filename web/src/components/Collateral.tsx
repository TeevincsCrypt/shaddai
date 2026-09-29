import { useEffect, useState } from 'react';
import { api, type PreviewResult, type ScanResult } from '../api';
import { amount, countdown, mult, price } from '../format';
import type { CollateralPosition } from '../../../src/core/types';

const SEV_LABEL = { info: 'Info', watch: 'Watch', alert: 'Alert' } as const;
const SIDE_LABEL: Record<CollateralPosition['side'], string> = {
  collateral: 'Collateral',
  lend: 'Lent out',
  borrow: 'Borrowed',
  lp: 'Liquidity',
};
const BASIS_LABEL: Record<string, string> = {
  raw: 'per raw token',
  share: 'per share (mismatch)',
  indistinguishable: 'cannot tell yet',
  unknown: 'unknown',
};

function Warning({ p }: { p: CollateralPosition }) {
  return (
    <article className={`warn ${p.severity}`}>
      <div className="warn-head">
        <span className="sev">{SEV_LABEL[p.severity]}</span>
        <h3>
          {p.token.symbol} · {p.protocol}
        </h3>
        {p.market.url ? (
          <a className="small mono" href={p.market.url} target="_blank" rel="noreferrer">
            {p.market.label}
          </a>
        ) : (
          <span className="small mono muted">{p.market.label}</span>
        )}
        <span className={`chip ${p.side === 'borrow' ? 'watch' : 'quiet'}`}>{SIDE_LABEL[p.side]}</span>
        {p.token.demoOnly ? <span className="chip demo">Fictional</span> : null}
      </div>
      <div className="warn-body">
        {p.lines.map((l) => (
          <p key={l} className={/^(Current raw|Your share|Supplied raw|Owed raw)/.test(l) ? 'figures' : undefined}>
            {l}
          </p>
        ))}
      </div>
      <div className="warn-grid">
        <div>
          <div className="eyebrow">{p.side === 'borrow' ? 'Protocol says you owe' : 'Protocol counts'}</div>
          <div className="v raw-v">{amount(p.raw, 4)} raw</div>
        </div>
        <div>
          <div className="eyebrow">{p.side === 'borrow' ? 'Owed in shares' : 'You own'}</div>
          <div className="v share-v">{p.shareEq === null ? 'not read' : `${amount(p.shareEq, 4)} share-eq`}</div>
        </div>
        <div>
          <div className="eyebrow">Multiplier</div>
          <div className="v mult-v">{mult(p.multiplier)}</div>
        </div>
        {p.enteredAsCollateral !== null && p.side !== 'lend' ? (
          <div>
            <div className="eyebrow">Collateral enabled</div>
            <div className="v">{p.enteredAsCollateral ? 'Yes' : 'No'}</div>
          </div>
        ) : null}
        {p.oracle ? (
          <div>
            <div className="eyebrow">Oracle basis</div>
            <div className="v">{BASIS_LABEL[p.oracle.basis]}</div>
            <div className="small muted">
              oracle {price(p.oracle.oracleRawUsd)} · DEX {price(p.oracle.dexRawUsd)} per raw
            </div>
          </div>
        ) : null}
      </div>
      {p.oracle ? <p className="small muted">{p.oracle.note}</p> : null}
      {p.reasons.length ? (
        <ul className="notes" style={{ maxWidth: 'none' }}>
          {p.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

export function Collateral({ result }: { result: ScanResult }) {
  const { positions, listings } = result.collateral;
  const checks = result.checks.filter((c) =>
    ['Venus', 'Lista', 'DEX LP (V2)', 'Ondo sValue', 'Prices'].includes(c.name),
  );
  return (
    <section className="section" aria-labelledby="co-h">
      <div className="section-head">
        <div>
          <h2 id="co-h">Protocols that still speak ERC-20</h2>
          <p>
            Venus, Lista and DEX pools count raw tokens. After a split the shares you own and the units the protocol
            counts move apart unless the protocol applies the multiplier itself.
          </p>
        </div>
        <div className="toolbar small">
          <span className="chip info">Info · multiplier near 1</span>
          <span className="chip watch">Watch · change scheduled</span>
          <span className="chip alert">Alert · over 1% or split-sized</span>
        </div>
      </div>

      <Preview result={result} />

      {positions.length === 0 ? (
        <div className="empty">
          <strong>No bStock, Ondo or xStock positions found inside Venus, Lista or a V2 pool.</strong>
          <span>Nothing on this address is being counted in raw units by a money market right now.</span>
        </div>
      ) : (
        <div className="warnings">
          {positions.map((p) => (
            <Warning key={`${p.protocol}-${p.market.label}-${p.token.address}`} p={p} />
          ))}
        </div>
      )}

      {listings.length ? (
        <div style={{ display: 'grid', gap: 4 }}>
          <h3 style={{ fontSize: 'var(--step-1)', marginTop: 12 }}>If you post what is in the wallet</h3>
          <div>
            {listings.map((l) => (
              <div className="listing" key={`${l.protocol}-${l.token.address}`}>
                <span className="chip info">{l.protocol}</span>
                <div>
                  {l.lines.map((x) => (
                    <p key={x}>{x}</p>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 8 }}>
        <h3 style={{ fontSize: 'var(--step-1)', marginTop: 12 }}>What this scan checked</h3>
        <ul className="checks" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {checks.map((c) => (
            <li key={c.name}>
              <span
                className={`chip ${c.status === 'ok' ? '' : c.status === 'partial' ? 'watch' : c.status === 'skipped' ? 'quiet' : 'alert'}`}
              >
                {c.status}
              </span>
              <strong>{c.name}</strong>
              <span className="detail muted">{c.detail}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

const MATCH_LABEL: Record<string, string> = {
  raw: 'matches the raw count',
  'share-eq': 'matches share-equivalents',
  indistinguishable: 'matches both (multiplier ≈ 1)',
  neither: 'matches neither figure',
  'not-found-on-chain': 'no such position found on chain',
};

/** Pre-action preview: what the next multiplier change does to each position, before anyone acts on it. */
function Preview({ result }: { result: ScanResult }) {
  const [p, setP] = useState<PreviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setP(null);
    setError(null);
    api
      .preview(result.address, result.mode === 'demo')
      .then((x) => live && setP(x))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [result.address, result.mode]);

  if (error) return <p className="small muted">Preview not available: {error}</p>;
  if (!p) return <p className="small muted">Building the pre-action preview…</p>;
  if (!p.items.length && !p.defi.checks.length && !p.defi.unscanned.length) return null;
  return (
    <div className="preview">
      <h3>Before you act</h3>
      <p className="small muted">
        What the next multiplier change does to each position, and the gap a share-priced oracle would leave where the
        protocol counts raw tokens. {p.notes[0]}
      </p>
      <div className="preview-list">
        {p.items.map((i) => (
          <div key={`${i.token.address}-${i.label}`} className={`preview-item ${i.severity}`}>
            <div className="preview-head">
              <span className={`chip ${i.severity === 'info' ? 'info' : i.severity}`}>{i.severity}</span>
              <strong>{i.token.symbol}</strong>
              <span className="small muted">{i.label}</span>
              {i.flip ? (
                <span className="small mono">
                  {mult(i.multiplier)} → {mult(i.flip.multiplier)} {countdown(i.flip.at)}
                </span>
              ) : null}
              {i.staleReference ? <span className="chip watch">Cash market shut</span> : null}
            </div>
            <div className="preview-figs small mono">
              <span>raw {amount(i.raw, 4)}</span>
              <span>share-eq {i.shareEqNow === null ? 'not read' : amount(i.shareEqNow, 4)}</span>
              {i.flip ? <span>after {amount(i.flip.shareEqAfter, 4)}</span> : null}
              {i.gap && i.side !== 'lp' && Number(i.gap.afterShares ?? i.gap.nowShares) !== 0 ? (
                <span>
                  gap if share-priced {amount(i.gap.afterShares ?? i.gap.nowShares, 6)}
                  {(i.gap.afterUsd ?? i.gap.nowUsd) !== null ? ` · ${price(i.gap.afterUsd ?? i.gap.nowUsd)}` : ''}
                </span>
              ) : null}
            </div>
            {i.lines.map((l) => (
              <p key={l} className="small">
                {l}
              </p>
            ))}
          </div>
        ))}
      </div>
      {p.defi.checks.length || p.defi.unscanned.length ? (
        <div>
          <div className="eyebrow">Binance DeFi API, same address</div>
          <ul className="notes" style={{ maxWidth: 'none' }}>
            {p.defi.checks.map((c) => (
              <li key={`${c.token.address}-${c.protocol}-${c.side}`}>
                {c.apiAmount} {c.token.symbol} {c.side === 'borrow' ? 'borrowed' : 'supplied'} on {c.protocol}:{' '}
                {MATCH_LABEL[c.matches]}
                {c.healthFactor ? ` · health factor ${c.healthFactor}` : ''}
              </li>
            ))}
            {p.defi.unscanned.map((u) => (
              <li key={`${u.token}-${u.protocolId}-${u.side}`}>
                {u.amount} {u.tokenRef.symbol} on {u.protocolName}: a protocol Shaddai does not scan (unit not known).
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="small muted">
        Market hours: {p.market.detail} DeFi positions: {p.defi.detail}
      </p>
    </div>
  );
}
