import { useEffect, useState } from 'react';
import { api, type SpreadResult, type SpreadRow } from '../api';
import { bscscan, dateTime, mult, price, signedPct, usdCompact } from '../format';

/** Share-normalized wrapper spread: one ticker, every verified wrapper, priced per share-equivalent. */
export function Spread({ demo }: { demo: boolean }) {
  const [tickers, setTickers] = useState<string[]>([]);
  const [ticker, setTicker] = useState('NVDA');
  const [data, setData] = useState<SpreadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .spreadTickers(demo)
      .then((r) => setTickers(r.tickers))
      .catch(() => setTickers([]));
  }, [demo]);

  useEffect(() => {
    let live = true;
    setBusy(true);
    setError(null);
    api
      .spread(ticker, demo)
      .then((r) => live && setData(r))
      .catch((e: Error) => live && (setError(e.message), setData(null)))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [ticker, demo]);

  const s = data?.ticker === ticker ? data : null;
  const cheapest = s?.rows.find((r) => r.token.address === s.cheapestRaw);
  const tightest = s?.rows.find((r) => r.token.address === s.tightest);

  return (
    <section className="section" aria-labelledby="sp-h">
      <div className="section-head">
        <div>
          <h2 id="sp-h">Wrapper spread, per share</h2>
          <p>
            <strong>A raw gap can be a dividend. Shaddai subtracts the multiplier first.</strong> Each wrapper is priced
            from its deepest USDT pool on BSC, divided by the factor its contract or oracle reports, then compared.
          </p>
        </div>
        {s ? <Session s={s} /> : null}
      </div>

      <div className="seg ticker-seg" role="group" aria-label="Ticker">
        {(tickers.length ? tickers : [ticker]).map((t) => (
          <button key={t} type="button" aria-pressed={t === ticker} onClick={() => setTicker(t)}>
            {t}
          </button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}
      {busy && !s ? <p className="muted">Reading pools and factors for {ticker}…</p> : null}

      {s ? (
        <>
          <div className="table-scroll stack">
            <table className="stmt stack">
              <thead>
                <tr>
                  <th>Wrapper</th>
                  <th className="num">
                    Raw price<span className="sub">per token</span>
                  </th>
                  <th className="num">
                    Multiplier<span className="sub">on chain</span>
                  </th>
                  <th className="num">
                    Share-eq price<span className="sub">raw ÷ factor</span>
                  </th>
                  <th className="num">
                    Reference<span className="sub">Binance RWA</span>
                  </th>
                  <th className="num">
                    Gap<span className="sub">after multiplier</span>
                  </th>
                  <th className="num">
                    Pool liquidity<span className="sub">deepest USDT pool</span>
                  </th>
                  <th className="num">
                    1% depth<span className="sub">USDT in</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.rows.map((r) => (
                  <Row key={r.token.address} r={r} s={s} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="legend">
            {tightest ? (
              <span>
                Tightest liquid wrapper: <strong>{tightest.token.symbol}</strong> (gap {signedPct(tightest.gapPct)}
                ).
                {cheapest && cheapest.token.address !== tightest.token.address
                  ? ` The cheapest raw token is ${cheapest.token.symbol}; that is not the same thing.`
                  : ''}
              </span>
            ) : null}
            <span>{s.referenceNote}</span>
            <span>
              Liquid means the deepest USDT pool holds at least {usdCompact(s.minLiquidityUsd)}. 1% depth: the USDT a
              buy can spend before its average price is 1% worse than a tiny buy&apos;s.
            </span>
            {s.missing.map((m) => (
              <span key={m}>{m}</span>
            ))}
            <span>
              {s.mode === 'demo' ? 'Demo fixture chain' : 'BSC mainnet'}, block {s.block}. Spot only. Quotes, not
              trades.
            </span>
          </div>
        </>
      ) : null}
    </section>
  );
}

function Session({ s }: { s: SpreadResult }) {
  const closed = !s.session.open;
  const why = { weekend: 'weekend', 'before-open': 'before the open', 'after-close': 'after the close', open: '' }[
    s.session.reason
  ];
  return (
    <div className="toolbar small">
      <span className={`chip ${closed ? 'watch' : 'info'}`}>US cash market {closed ? `closed (${why})` : 'open'}</span>
      {closed ? (
        <span className="muted">Next open {dateTime(s.session.nextOpenMs / 1000)} (clock; holidays not checked)</span>
      ) : null}
    </div>
  );
}

function Row({ r, s }: { r: SpreadRow; s: SpreadResult }) {
  const isTight = r.token.address === s.tightest;
  const notes = [
    r.rwa && r.rwa.tokenPrice !== null
      ? `Binance RWA token price ${price(r.rwa.tokenPrice)} → ${r.rwa.shareEqPrice !== null ? `${price(r.rwa.shareEqPrice)} per share` : 'share-eq unread'}${r.rwa.gapPct !== null ? ` (gap ${signedPct(r.rwa.gapPct)})` : ''}.`
      : null,
    r.book.pool ? `Pool: ${r.book.pool.label}${r.book.source === 'dexscreener' ? ' (DexScreener price)' : ''}.` : null,
    ...r.notes,
    r.market.detail,
    r.market.closed && r.market.nextOpenMs
      ? `Next open ${dateTime(r.market.nextOpenMs / 1000)} (${r.market.nextOpenSource === 'binance-rwa' ? 'Binance' : 'clock'}).`
      : null,
  ].filter(Boolean) as string[];
  return (
    <>
      <tr className={`has-notes ${isTight ? 'chosen' : ''}`}>
        <td className="span-2">
          <div className="inst">
            <span className="tk">
              {r.token.symbol} <span className="issuer">{r.token.issuer}</span>
              {isTight ? <span className="chip">Tightest liquid</span> : null}
              {r.liquid === false ? (
                <span className="chip watch">Thin: under {usdCompact(s.minLiquidityUsd)}</span>
              ) : null}
              {r.market.badge ? <span className="chip quiet">{r.market.badge}</span> : null}
            </span>
            <span className="meta">
              <a href={bscscan('token', r.token.address)} target="_blank" rel="noreferrer">
                {r.token.address.slice(0, 6)}…{r.token.address.slice(-4)}
              </a>
            </span>
          </div>
        </td>
        <td className="num raw-v" data-label="Raw price">
          {price(r.book.rawPrice)}
        </td>
        <td className="num" data-label="Multiplier">
          {r.factor !== null ? (
            <span className="mult-v">
              {mult(r.factor)}
              <span className="drift">{r.factorSource}</span>
            </span>
          ) : (
            <span className="chip watch">{r.factorUnread === 'display factor unread' ? r.factorUnread : 'unread'}</span>
          )}
        </td>
        <td className="num share-v" data-label="Share-eq price">
          {r.shareEqPrice !== null ? price(r.shareEqPrice) : 'unread'}
        </td>
        <td className="num" data-label="Reference">
          {price(r.reference)}
        </td>
        <td className="num" data-label="Gap after multiplier">
          <strong>{signedPct(r.gapPct)}</strong>
          {r.rawGapPct !== null ? <span className="drift muted">raw {signedPct(r.rawGapPct)}</span> : null}
        </td>
        <td className="num" data-label="Pool liquidity">
          {usdCompact(r.book.liquidityUsd)}
        </td>
        <td className="num" data-label="1% depth">
          {r.book.depth1pctUsd === null
            ? 'not measured'
            : `${r.book.depthAtLeast ? '≥ ' : ''}${usdCompact(r.book.depth1pctUsd)}`}
        </td>
      </tr>
      <tr className="note-row only-lg">
        <td colSpan={8}>{notes.join(' · ')}</td>
      </tr>
      <tr className="only-sm">
        <td className="span-2 muted small">{notes.join(' · ')}</td>
      </tr>
    </>
  );
}
