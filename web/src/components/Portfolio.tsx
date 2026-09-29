import { useState } from 'react';
import type { ScanResult } from '../api';
import { amount, bscscan, countdown, dateTime, mult, price, shortAddr, usd } from '../format';
import type { PortfolioRow, UnitModel } from '../../../src/core/types';

function unitStatus(row: PortfolioRow, unit: UnitModel | undefined, severity?: string) {
  if (!unit) return null;
  if (severity && severity !== 'info') {
    return <span className={`chip ${severity}`}>{severity === 'alert' ? 'Alert' : 'Watch'} · see Collateral</span>;
  }
  if (unit.pending) {
    const big =
      unit.pending.kind === 'split' ||
      unit.pending.kind === 'reverse-split' ||
      unit.pending.kind === 'large-adjustment';
    return (
      <span className={`chip ${big ? 'alert' : 'watch'}`} title={dateTime(unit.pending.effectiveAt)}>
        → {mult(unit.pending.multiplier)} {countdown(unit.pending.effectiveAt)}
      </span>
    );
  }
  if (unit.ondo?.paused) return <span className="chip watch">Ondo oracle paused</span>;
  if (unit.kind === 'none') return <span className="chip quiet">No multiplier found</span>;
  if (row.oneToOneNow) return <span className="chip quiet">1 token ≈ 1 share right now</span>;
  return null;
}

const SOURCE_LABEL: Record<PortfolioRow['shareEqSource'], string> = {
  balanceOfUI: 'balanceOfUI()',
  computed: 'raw × uiMultiplier',
  sValue: 'raw × Ondo sValue',
  raw: '1:1, unverified',
};

export function Portfolio({ result }: { result: ScanResult }) {
  const [showDust, setShowDust] = useState(false);
  const visible = result.portfolio.rows.filter((r) => showDust || !r.dust);
  // Group by instrument (largest total first), wallet row before protocol rows.
  const groupUsd = new Map<string, number>();
  for (const r of visible) groupUsd.set(r.token.address, (groupUsd.get(r.token.address) ?? 0) + (r.positionUsd ?? 0));
  const rows = [...visible].sort(
    (a, b) =>
      (groupUsd.get(b.token.address) ?? 0) - (groupUsd.get(a.token.address) ?? 0) ||
      a.token.address.localeCompare(b.token.address) ||
      (a.location.kind === 'wallet' ? -1 : b.location.kind === 'wallet' ? 1 : 0) ||
      (b.positionUsd ?? 0) - (a.positionUsd ?? 0),
  );
  const severityOf = (r: PortfolioRow) =>
    r.location.kind === 'wallet'
      ? undefined
      : (result.collateral.positions.find(
          (p) => p.token.address === r.token.address && p.market.address === r.location.contract,
        )?.severity ??
        result.collateral.positions.find(
          (p) => p.token.address === r.token.address && r.location.label.includes(p.market.label),
        )?.severity);
  const dustCount = result.portfolio.rows.filter((r) => r.dust).length;
  const shownTotal = rows.reduce((s, r) => s + (r.positionUsd ?? 0), 0);

  return (
    <section className="section" aria-labelledby="pf-h">
      <div className="section-head">
        <div>
          <h2 id="pf-h">Share-equivalents on this address</h2>
          <p>
            Raw is what a wallet reads from <code>balanceOf()</code>. Share-equivalents apply the issuer’s multiplier.
            Both are shown, always.
          </p>
        </div>
        <div className="toolbar">
          {dustCount ? (
            <label>
              <input
                id="show-dust"
                type="checkbox"
                checked={showDust}
                onChange={(e) => setShowDust(e.target.checked)}
              />
              Show dust ({dustCount})
            </label>
          ) : null}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="empty">
          <strong>No tracked tokenized stocks on this address.</strong>
          <span>
            Shaddai reads {result.tokens.length} contracts (bStocks and Ondo on BSC). If you hold one of them here and
            it is missing, check the Collateral tab: it may be inside a protocol.
          </span>
        </div>
      ) : (
        <div className="table-scroll stack">
          <table className="stmt stack">
            <thead>
              <tr>
                <th>Instrument</th>
                <th className="num">
                  Raw balance<span className="sub">what the wallet shows</span>
                </th>
                <th className="num">Multiplier</th>
                <th className="num">
                  Share-equivalents<span className="sub">not voting shares</span>
                </th>
                <th className="num">
                  Mark<span className="sub">per share-eq</span>
                </th>
                <th className="num">Position</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const unit = result.units[r.token.address];
                const groupStart = i > 0 && rows[i - 1]!.token.address !== r.token.address;
                const drift = Number(r.drift);
                const notes = r.location.kind === 'wallet' ? (unit?.notes ?? []) : [];
                return (
                  <tr
                    key={`${r.token.address}-${r.location.label}`}
                    className={[r.dust ? 'dim' : '', groupStart ? 'group-start' : ''].join(' ').trim() || undefined}
                  >
                    <td className="span-2">
                      <div className="inst">
                        <span className="tk">
                          {r.token.ticker}
                          <span className="issuer">{r.token.issuer}</span>
                        </span>
                        <span className="meta">
                          <a href={bscscan('token', r.token.address)} target="_blank" rel="noreferrer">
                            {r.token.symbol}
                          </a>{' '}
                          · {r.token.name}
                        </span>
                        <span className={`loc ${r.location.kind === 'wallet' ? '' : 'protocol'}`}>
                          {r.location.url ? (
                            <a href={r.location.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>
                              {r.location.label}
                            </a>
                          ) : (
                            r.location.label
                          )}
                        </span>
                        {notes.length ? (
                          <ul className="notes">
                            {notes.map((n) => (
                              <li key={n}>{n}</li>
                            ))}
                          </ul>
                        ) : null}
                      </div>
                    </td>
                    <td className="num raw-v" data-label="Raw balance">
                      {amount(r.raw)}
                    </td>
                    <td className="num mult-v" data-label="Multiplier">
                      {mult(r.multiplier)}
                    </td>
                    <td className="num" data-label="Share-equivalents">
                      <span className="share-v">{amount(r.shareEq)}</span>
                      {drift !== 0 ? <span className="drift">+{amount(r.drift)}</span> : null}
                      <span className="drift" style={{ color: 'var(--faint)' }}>
                        {SOURCE_LABEL[r.shareEqSource]}
                      </span>
                    </td>
                    <td className="num" data-label="Mark per share-eq">
                      {price(r.price?.shareUsd)}
                      {r.price ? (
                        <span className="drift" style={{ color: 'var(--faint)' }}>
                          {price(r.price.rawUsd)} / raw
                          {r.price.thin ? ' · thin pool' : ''}
                        </span>
                      ) : (
                        <span className="drift" style={{ color: 'var(--faint)' }}>
                          no DEX mark
                        </span>
                      )}
                    </td>
                    <td className="num" data-label="Position">
                      {usd(r.positionUsd)}
                    </td>
                    <td className="span-2">{unitStatus(r, unit, severityOf(r))}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr>
                <td>Total marked value</td>
                <td colSpan={4} />
                <td className="num">{usd(shownTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <p className="unit-label">
        Share-equivalents, not voting shares. Marks come from the deepest DEX pool, which prices one raw token; the
        per-share mark is that price ÷ the multiplier, so the dividend is counted once.
        {result.mode === 'live' ? null : ' Demo marks are illustrative.'}
      </p>
      <PendingList result={result} />
    </section>
  );
}

function PendingList({ result }: { result: ScanResult }) {
  const pending = Object.values(result.units).filter((u) => u.pending);
  if (!pending.length) return null;
  const tokens = new Map(result.tokens.map((t) => [t.address, t]));
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <h3 className="eyebrow" style={{ fontFamily: 'var(--font-body)' }}>
        Scheduled multiplier changes across tracked tokens
      </h3>
      <ul className="notes" style={{ maxWidth: 'none', fontSize: 'var(--step--1)' }}>
        {pending.map((u) => (
          <li key={u.token}>
            <span className="mono">{tokens.get(u.token)?.symbol ?? shortAddr(u.token)}</span> {mult(u.multiplier)} →{' '}
            {mult(u.pending!.multiplier)} on {dateTime(u.pending!.effectiveAt)} ({countdown(u.pending!.effectiveAt)})
          </li>
        ))}
      </ul>
    </div>
  );
}
