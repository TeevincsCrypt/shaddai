import { useEffect, useState, type ReactNode } from 'react';
import { api, type AppConfigResponse, type FeedResult } from '../api';
import type { Tab } from '../App';
import { amountTrim, date, KIND_LABEL, mult } from '../format';
import { LogoMark } from './Logo';
import { Lookup } from './Lookup';

const SURFACES: [string, string, string][] = [
  ['Binance, BscScan (BEP-8056 view)', 'raw × uiMultiplier', '“I have 10.006 Apple”'],
  ['Most wallets', 'balanceOf()', '“I have 10.000 tokens. Did I miss the dividend?”'],
  ['Venus, Lista', 'balanceOf + an oracle price', 'Collateral math may not match share-equivalents after a split'],
  ['Crypto tax software', 'Transfer events', 'Nothing happened. Basis never moves.'],
];

const FEATURES: { tab: Tab; title: string; body: string; go: string; icon: ReactNode }[] = [
  {
    tab: 'portfolio',
    title: 'Portfolio',
    body: 'Raw units next to share-equivalents, per issuer, with the multiplier that joins them.',
    go: 'Open on the demo',
    icon: <path d="M12 3v9h9M21 12a9 9 0 1 1-9-9" />,
  },
  {
    tab: 'ledger',
    title: 'Ledger',
    body: 'Every multiplier change since the index start: dividends, splits, overwrites. Exports to CSV.',
    go: 'Open on the demo',
    icon: <path d="M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  },
  {
    tab: 'collateral',
    title: 'Collateral',
    body: 'Where Venus, Lista or a pool counts raw tokens, and what a split would do to the numbers.',
    go: 'Open on the demo',
    icon: <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" />,
  },
  {
    tab: 'buy',
    title: 'Buy',
    body: 'Compare wrappers by the shares you end up with, not the tokens. Your wallet signs.',
    go: 'Compare wrappers',
    icon: <path d="M12 3v12M7 10l5 5 5-5M4 21h16" />,
  },
  {
    tab: 'units',
    title: 'How units work',
    body: 'One page on raw balances, uiMultiplier and Ondo sValue, with the formula.',
    go: 'Read it',
    icon: <path d="M18 5H6l6 7-6 7h12" />,
  },
];

/** "1.0017" → "100.17": the share-equivalent of 100 raw tokens, without float rounding. */
function times100(m: string): string {
  const [w = '0', f = ''] = m.split('.');
  const f2 = f.padEnd(2, '0');
  const whole = (w + f2.slice(0, 2)).replace(/^0+(?=\d)/, '');
  return f2.length > 2 ? `${whole}.${f2.slice(2)}` : whole;
}

function useFeed() {
  const [feed, setFeed] = useState<FeedResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .feed(false)
      .then((f) => live && setFeed(f))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, []);
  return { feed, error };
}

function FeedCard({ feed, error }: { feed: FeedResult | null; error: string | null }) {
  const events = (feed?.events ?? [])
    .filter((e) => e.kind !== 'init' && e.kind !== 'no-change')
    .sort((a, b) => b.effectiveAt - a.effectiveAt)
    .slice(0, 3);
  return (
    <div className="float f-feed">
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
        <h4>Multiplier changes</h4>
        {feed ? <span className="pill">{feed.mode === 'demo' ? 'Demo' : 'BSC'}</span> : null}
      </div>
      {error ? (
        <p className="sub">Index not reachable: {error}</p>
      ) : !feed ? (
        <p className="sub">Reading the multiplier index…</p>
      ) : feed.status === 'indexing' && !events.length ? (
        <p className="sub">
          Indexing ({Math.round((feed.progress ?? 0) * 100)}%). Changes appear here when it finishes.
        </p>
      ) : !events.length ? (
        <p className="sub">{feed.error ? `Index unavailable: ${feed.error}` : 'No changes indexed yet.'}</p>
      ) : (
        events.map((e) => (
          <div className="feed-row" key={e.id}>
            <div className="top">
              <strong>{e.token.symbol}</strong>
              <span className="when">
                {e.status === 'pending' ? 'from ' : ''}
                {date(e.effectiveAt)}
              </span>
            </div>
            <span className="kind">{KIND_LABEL[e.kind] ?? e.kind}</span>
            <span className="chg">
              {mult(e.oldMultiplier)} → {mult(e.newMultiplier)}
            </span>
          </div>
        ))
      )}
    </div>
  );
}

function FactorsCard({ feed, error }: { feed: FeedResult | null; error: string | null }) {
  const bySymbol = new Map((feed?.tokens ?? []).map((t) => [t.address.toLowerCase(), t]));
  const read = Object.values(feed?.units ?? {})
    .filter((u) => u.multiplier !== null && bySymbol.has(u.token.toLowerCase()))
    .map((u) => ({ token: bySymbol.get(u.token.toLowerCase())!, m: u.multiplier as string }))
    .sort((a, b) => Number(b.m) - Number(a.m));
  const top = read.slice(0, 3);
  const unread = Object.values(feed?.units ?? {}).filter((u) => u.kind !== 'none' && u.multiplier === null).length;
  const maxExtra = Math.max(...top.map((r) => Number(r.m) - 1), 0);
  return (
    <div className="float f-factors">
      <div>
        <h4>100 tokens, in shares</h4>
        <p className="sub">Read from each contract just now.</p>
      </div>
      {error ? (
        <p className="sub">Not read: {error}</p>
      ) : !feed ? (
        <p className="sub">Reading multipliers…</p>
      ) : !top.length ? (
        <p className="sub">No multiplier could be read.</p>
      ) : (
        top.map((r) => {
          const extra = Number(r.m) - 1;
          return (
            <div className="fac-row" key={r.token.address}>
              <div className="top">
                <strong>{r.token.symbol}</strong>
                <span className="mono">{amountTrim(times100(r.m), 4, 2)} shares</span>
              </div>
              <div className="bar" role="img" aria-label={`${(extra * 100).toFixed(2)}% more shares than raw tokens`}>
                <span style={{ width: `${maxExtra > 0 ? Math.max(4, (extra / maxExtra) * 100) : 0}%` }} />
              </div>
            </div>
          );
        })
      )}
      {unread ? (
        <p className="sub">
          {unread} token{unread === 1 ? '' : 's'} not read; the statement says why.
        </p>
      ) : null}
    </div>
  );
}

function IssuersCard({ feed }: { feed: FeedResult | null }) {
  const count = (issuer: string) => feed?.tokens.filter((t) => t.issuer === issuer).length;
  const tiles: [string, string, string][] = [
    ['b', 'B', 'bStocks'],
    ['o', 'O', 'Ondo'],
    ['x', 'X', 'xStocks'],
  ];
  return (
    <div className="float f-issuers">
      <div>
        <h4>Three issuers, one statement</h4>
        <p className="sub">Each publishes its share factor its own way.</p>
      </div>
      <div className="issuer-tiles">
        {tiles.map(([cls, letter, name]) => (
          <div key={cls}>
            <span className={`issuer-tile ${cls}`} aria-hidden="true">
              {letter}
            </span>
            <span className="sub" style={{ color: 'var(--ink)', fontWeight: 600 }}>
              {name}
            </span>
            {feed ? (
              <span className="sub">
                {count(name) ?? 0} token{count(name) === 1 ? '' : 's'}
              </span>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Landing(props: {
  config: AppConfigResponse | null;
  onScan: (a: string) => void;
  onFeature: (t: Tab) => void;
  busy: boolean;
  error: string | null;
}) {
  const { feed, error } = useFeed();
  return (
    <div className="wrap landing">
      <section className="stage" aria-labelledby="hero-h">
        <div className="hero">
          <span className="app-tile">
            <LogoMark size={44} />
          </span>
          <h1 id="hero-h" className="hero-title">
            <span>Your wallet counts tokens.</span>
            <span className="l2">Shaddai counts shares.</span>
          </h1>
          <p className="hero-sub">
            When a tokenized stock pays a dividend or splits, the raw balance usually stays put and the issuer raises a
            multiplier. Paste a BSC address. We read both.
          </p>
          <Lookup onScan={props.onScan} busy={props.busy} demoAddress={props.config?.demoAddress} />
          {props.error ? <p className="error">{props.error}</p> : null}
          {props.config?.examples.length ? (
            <div className="examples">
              <span>Known holders, no funds needed:</span>
              {props.config.examples.map((e) => (
                <button key={e.address} type="button" className="linkish" onClick={() => props.onScan(e.address)}>
                  {e.label}
                </button>
              ))}
            </div>
          ) : null}
          {props.busy ? (
            <div className="progress" aria-hidden="true">
              <span style={{ width: '60%' }} />
            </div>
          ) : null}
        </div>

        <div className="floaters">
          <div className="float note f-note">Dividend paid? The raw balance stays put. The multiplier moves.</div>
          <span className="icon-tile f-check" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 32 32">
              <rect x="2" y="2" width="28" height="28" rx="8" fill="var(--accent)" />
              <path
                d="M10 16.5l4 4 8-9"
                fill="none"
                stroke="#fff"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <FeedCard feed={feed} error={error} />
          <span className="icon-tile f-clock" aria-hidden="true">
            <svg width="32" height="32" viewBox="0 0 32 32" fill="none" strokeLinecap="round" strokeWidth="2.4">
              <circle cx="16" cy="18" r="10" stroke="var(--ink-2)" />
              <path d="M13 4h6M16 4v4M24 9l2-2" stroke="var(--ink-2)" />
              <path d="M16 18l4-5" stroke="var(--accent)" />
            </svg>
          </span>
          <FactorsCard feed={feed} error={error} />
          <IssuersCard feed={feed} />
        </div>
      </section>

      <section className="band" aria-labelledby="features-h">
        <h2 id="features-h" className="band-title">
          <span>Everything a wallet leaves out.</span>
          <span className="l2">Read-only, until you choose to buy.</span>
        </h2>
        <div className="features">
          {FEATURES.map((f) => (
            <button key={f.tab} type="button" className="feature" onClick={() => props.onFeature(f.tab)}>
              <span className="ico" aria-hidden="true">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {f.icon}
                </svg>
              </span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
              <span className="go">{f.go} →</span>
            </button>
          ))}
        </div>
      </section>

      <section className="band" aria-labelledby="surfaces-h">
        <h2 id="surfaces-h" className="band-title">
          <span>The same 10 AAPLB,</span>
          <span className="l2">four different answers.</span>
        </h2>
        <div className="card" style={{ padding: '18px clamp(16px, 3vw, 24px)', display: 'grid', gap: 10 }}>
          <p className="eyebrow">Illustration</p>
          <div className="equation" aria-label="10 raw tokens times multiplier 1.0017 equals 10.017 share-equivalents">
            <span className="v raw">10.000000</span>
            <span className="op">×</span>
            <span className="v m">1.0017</span>
            <span className="op">=</span>
            <span className="v">10.017000</span>
            <span className="lbl">raw balance · what most wallets show</span>
            <span />
            <span className="lbl">uiMultiplier()</span>
            <span />
            <span className="lbl">share-equivalents</span>
          </div>
        </div>
        <div className="surfaces" role="table">
          <div role="row">
            <span className="head" role="columnheader">
              Surface
            </span>
            <span className="head" role="columnheader">
              What it reads
            </span>
            <span className="head" role="columnheader">
              What the holder concludes
            </span>
          </div>
          {SURFACES.map(([s, r, t]) => (
            <div role="row" key={s}>
              <span role="cell" style={{ fontWeight: 600 }}>
                {s}
              </span>
              <code role="cell">{r}</code>
              <span role="cell" className="muted">
                {t}
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
