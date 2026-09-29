import { Fragment, useEffect, useState } from 'react';
import { api, type FeedResult, type ScanResult } from '../api';
import { amount, amountTrim, bscscan, countdown, date, dateTime, KIND_LABEL, mult, pct, usd } from '../format';
import type { LedgerRow, MultiplierEvent } from '../../../src/core/types';

/** Notes that apply to every row are printed once under the table (the CSV keeps them per row). */
const UNIVERSAL = new Set([
  'No Transfer event. Tax exporters will miss this.',
  'USD at the current mark, not the price on the day.',
]);

const SOURCE_LABEL: Record<LedgerRow['rawAtEventSource'], string> = {
  archive: 'archive read',
  replay: 'Transfer replay',
  'assumed-current': 'current balance',
  unavailable: 'unavailable',
};

function EventCell({ e }: { e: MultiplierEvent }) {
  const big = e.kind === 'split' || e.kind === 'reverse-split' || e.kind === 'large-adjustment';
  return (
    <div style={{ display: 'grid', gap: 4, justifyItems: 'start' }}>
      <span className={`chip ${big ? 'alert' : e.kind === 'dividend-reinvest' ? '' : 'info'}`}>
        {KIND_LABEL[e.kind] ?? e.kind}
        {e.splitLabel ? ` ${e.splitLabel}` : ''}
      </span>
      {e.status === 'pending' ? <span className="chip watch">Pending · {countdown(e.effectiveAt)}</span> : null}
      {e.status === 'overwritten' ? <span className="chip quiet">Overwritten</span> : null}
      {e.token.demoOnly ? <span className="chip demo">Fictional</span> : null}
    </div>
  );
}

function When({ e, demo }: { e: MultiplierEvent; demo: boolean }) {
  return (
    <div style={{ display: 'grid', gap: 2 }}>
      <span className="mono">{date(e.effectiveAt)}</span>
      <span className="small muted mono">{dateTime(e.effectiveAt).slice(12)}</span>
      {e.effectiveBlock ? (
        demo ? (
          <span className="small muted mono">#{e.effectiveBlock}</span>
        ) : (
          <a className="small mono" href={bscscan('block', e.effectiveBlock)} target="_blank" rel="noreferrer">
            #{e.effectiveBlock}
          </a>
        )
      ) : null}
    </div>
  );
}

function Inst({ e }: { e: MultiplierEvent }) {
  return (
    <div className="inst" style={{ minWidth: 120 }}>
      <span className="tk">
        {e.token.ticker}
        <span className="issuer">{e.token.issuer}</span>
      </span>
      <span className="meta">{e.token.symbol}</span>
    </div>
  );
}

function Mults({ e }: { e: MultiplierEvent }) {
  return (
    <div className="num" style={{ display: 'grid', gap: 2 }}>
      <span>
        <span className="raw-v">{mult(e.oldMultiplier)}</span> → <span className="mult-v">{mult(e.newMultiplier)}</span>
      </span>
      <span className="small muted">{pct(e.ratio)}</span>
    </div>
  );
}

export function Ledger({ result }: { result: ScanResult }) {
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [showHidden, setShowHidden] = useState(false);
  const [feed, setFeed] = useState<FeedResult | null>(null);
  const [feedError, setFeedError] = useState<string | null>(null);
  const demo = result.mode === 'demo';

  useEffect(() => {
    if (scope !== 'all' || feed) return;
    api
      .feed(demo)
      .then(setFeed)
      .catch((e: Error) => setFeedError(e.message));
  }, [scope, feed, demo]);

  const ledger = result.ledger;
  const rows = ledger.rows.filter(
    (r) => showHidden || (r.status !== 'overwritten' && !(r.status === 'effective' && r.rawAtEvent === '0')),
  );
  const hidden =
    ledger.rows.length -
    ledger.rows.filter((r) => r.status !== 'overwritten' && !(r.status === 'effective' && r.rawAtEvent === '0')).length;
  const credited = rows.filter((r) => r.status === 'effective').reduce((s, r) => s + (r.estUsd ?? 0), 0);

  return (
    <section className="section" aria-labelledby="lg-h">
      <div className="section-head">
        <div>
          <h2 id="lg-h">Events with no transfer</h2>
          <p>
            Each row is a multiplier change the issuer made on-chain. The raw balance did not move, so wallets and tax
            exporters show nothing. The multiplier did.
          </p>
        </div>
        <div className="toolbar">
          <div className="seg" role="group" aria-label="Scope">
            <button type="button" aria-pressed={scope === 'mine'} onClick={() => setScope('mine')}>
              This address
            </button>
            <button type="button" aria-pressed={scope === 'all'} onClick={() => setScope('all')}>
              All tracked tokens
            </button>
          </div>
          {scope === 'mine' ? (
            <a
              className={`btn primary`}
              href={api.csvUrl(result.mode === 'demo' ? 'demo' : result.address)}
              aria-disabled={ledger.status !== 'ready'}
              onClick={(e) => {
                if (ledger.status !== 'ready') e.preventDefault();
              }}
              style={{ textDecoration: 'none' }}
            >
              Download CSV
            </a>
          ) : null}
        </div>
      </div>

      {scope === 'mine' ? (
        <>
          {ledger.status === 'indexing' ? (
            <div className="empty">
              <strong>Indexing UIMultiplierUpdated logs across the registry…</strong>
              <div className="progress">
                <span style={{ width: `${Math.round((ledger.progress ?? 0) * 100)}%` }} />
              </div>
              <span>
                First run scans every block since the start date through public RPC. Later scans only read new blocks.
                This page refreshes on its own.
              </span>
            </div>
          ) : null}
          {ledger.status === 'unavailable' ? (
            <div className="empty">
              <strong>The ledger could not be built.</strong>
              <span>{ledger.error}</span>
            </div>
          ) : null}
          {ledger.status === 'ready' && ledger.error ? <p className="error">{ledger.error}</p> : null}
          {ledger.status === 'ready' && rows.length === 0 ? (
            <div className="empty">
              <strong>No multiplier events touched the tokens on this address.</strong>
              <span>
                Scanned blocks {ledger.scannedFrom}–{ledger.scannedTo}. The ledger covers tokens this address holds now,
                in the wallet or inside Venus, Lista or a V2 pool.
              </span>
            </div>
          ) : null}
          {ledger.status === 'ready' && rows.length > 0 ? (
            <div className="table-scroll stack">
              <table className="stmt stack">
                <thead>
                  <tr>
                    <th>Effective</th>
                    <th>Instrument</th>
                    <th>Event</th>
                    <th className="num">Multiplier</th>
                    <th className="num">
                      Raw held<span className="sub">at the block before</span>
                    </th>
                    <th className="num">
                      Δ share-eq<span className="sub">raw × (new − old)</span>
                    </th>
                    <th className="num">
                      Est. USD<span className="sub">at current mark</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const notes = r.notes.filter((n) => !UNIVERSAL.has(n));
                    const dim = r.status === 'overwritten' || r.rawAtEvent === '0';
                    return (
                      <Fragment key={r.id}>
                        <tr className={['has-notes', dim ? 'dim' : ''].join(' ')}>
                          <td data-label="Effective">
                            <When e={r} demo={demo} />
                          </td>
                          <td data-label="Instrument">
                            <Inst e={r} />
                          </td>
                          <td data-label="Event">
                            <EventCell e={r} />
                          </td>
                          <td data-label="Multiplier">
                            <Mults e={r} />
                          </td>
                          <td className="num" data-label="Raw held">
                            <span className="raw-v">{amount(r.rawAtEvent)}</span>
                            <span className="drift" style={{ color: 'var(--faint)' }}>
                              {SOURCE_LABEL[r.rawAtEventSource]}
                            </span>
                          </td>
                          <td className="num share-v" data-label="Δ share-eq">
                            {r.deltaShareEq === null
                              ? '—'
                              : `${r.deltaShareEq.startsWith('-') ? '' : '+'}${amountTrim(r.deltaShareEq, 8, 6)}`}
                          </td>
                          <td className="num" data-label="Est. USD">
                            {usd(r.estUsd)}
                            {r.estUsd !== null ? (
                              <span className="drift" style={{ color: 'var(--faint)' }}>
                                estimate
                              </span>
                            ) : null}
                          </td>
                          <td className="span-2 only-sm" data-label="Notes">
                            <ul className="notes" style={{ marginTop: 0 }}>
                              {notes.map((n) => (
                                <li key={n}>{n}</li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                        <tr className={['note-row only-lg', dim ? 'dim' : ''].join(' ')}>
                          <td colSpan={7}>{notes.join(' · ')}</td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={6}>Estimated reinvested value, effective rows</td>
                    <td className="num">{usd(credited)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : null}
          {ledger.status === 'ready' && rows.length > 0 ? (
            <div className="legend">
              <span>Every row: no Transfer event was emitted, so tax exporters will miss it.</span>
              <span>
                USD estimates use today’s per-share mark, not the price on the day. Dividends are net of typical 30% US
                withholding. Not tax, legal or investment advice.
              </span>
            </div>
          ) : null}
          <div className="toolbar">
            {hidden ? (
              <label>
                <input
                  id="show-hidden"
                  type="checkbox"
                  checked={showHidden}
                  onChange={(e) => setShowHidden(e.target.checked)}
                />
                Show {hidden} overwritten or not-held row{hidden > 1 ? 's' : ''}
              </label>
            ) : null}
            {ledger.status === 'ready' ? (
              <span className="muted">
                Indexed blocks {ledger.scannedFrom}–{ledger.scannedTo}. CSV columns: date, block, issuer, symbol,
                contract, raw_at_event, old_mult, new_mult, delta_share_eq, est_usd, note.
              </span>
            ) : null}
          </div>
        </>
      ) : (
        <FeedTable feed={feed} error={feedError} demo={demo} showHidden={showHidden} setShowHidden={setShowHidden} />
      )}
    </section>
  );
}

function FeedTable(props: {
  feed: FeedResult | null;
  error: string | null;
  demo: boolean;
  showHidden: boolean;
  setShowHidden: (v: boolean) => void;
}) {
  if (props.error) return <p className="error">{props.error}</p>;
  if (!props.feed) return <p className="muted">Loading the global feed…</p>;
  const { feed } = props;
  if (feed.status !== 'ready') {
    return (
      <div className="empty">
        <strong>{feed.status === 'indexing' ? 'Indexing multiplier events…' : 'Feed unavailable.'}</strong>
        {feed.status === 'indexing' ? (
          <div className="progress">
            <span style={{ width: `${Math.round((feed.progress ?? 0) * 100)}%` }} />
          </div>
        ) : null}
        {feed.error ? <span>{feed.error}</span> : null}
      </div>
    );
  }
  const events = feed.events.filter((e) => props.showHidden || (e.kind !== 'init' && e.status !== 'overwritten'));
  const hidden = feed.events.length - feed.events.filter((e) => e.kind !== 'init' && e.status !== 'overwritten').length;
  return (
    <>
      {events.length === 0 ? (
        <div className="empty">
          <strong>No multiplier changes in the indexed range.</strong>
          <span>
            Blocks {feed.scannedFrom}–{feed.scannedTo}.
          </span>
        </div>
      ) : (
        <div className="table-scroll stack">
          <table className="stmt stack">
            <thead>
              <tr>
                <th>Effective</th>
                <th>Instrument</th>
                <th>Event</th>
                <th className="num">Multiplier</th>
                <th>Scheduled</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className={e.status === 'overwritten' || e.kind === 'init' ? 'dim' : undefined}>
                  <td data-label="Effective">
                    <When e={e} demo={props.demo} />
                  </td>
                  <td data-label="Instrument">
                    <Inst e={e} />
                  </td>
                  <td data-label="Event">
                    <EventCell e={e} />
                  </td>
                  <td data-label="Multiplier">
                    <Mults e={e} />
                  </td>
                  <td className="small span-2" data-label="Scheduled">
                    <span className="mono">{dateTime(e.scheduledAt)}</span>
                    <br />
                    {props.demo ? (
                      <span className="muted mono">block {e.scheduledBlock}</span>
                    ) : (
                      <a className="mono" href={bscscan('tx', e.txHash)} target="_blank" rel="noreferrer">
                        tx {e.txHash.slice(0, 10)}…
                      </a>
                    )}
                    {e.eventLayout === 'variant-4' ? <span className="muted"> · 4-field event</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="toolbar">
        {hidden ? (
          <label>
            <input
              id="feed-hidden"
              type="checkbox"
              checked={props.showHidden}
              onChange={(e) => props.setShowHidden(e.target.checked)}
            />
            Show {hidden} initialisation or overwritten event{hidden > 1 ? 's' : ''}
          </label>
        ) : null}
        <span className="muted">
          UIMultiplierUpdated across {Object.keys(feed.units).length} tracked contracts, blocks {feed.scannedFrom}–
          {feed.scannedTo}.
        </span>
      </div>
    </>
  );
}
