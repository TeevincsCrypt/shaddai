import { useState } from 'react';
import { api, type DividendAnswer, type ScanResult } from '../api';

/** "Did I get the dividend?" One ticker, one plain-English answer from the ledger. No orders. */
export function DividendCheck({ result }: { result: ScanResult }) {
  // Tickers this address holds or has ledger rows for, then every other wrapper ticker.
  const mine = [
    ...new Set([...result.ledger.rows.map((r) => r.token.ticker), ...result.portfolio.rows.map((r) => r.token.ticker)]),
  ];
  const rest = [...new Set(result.tokens.map((t) => t.ticker))].filter((t) => !mine.includes(t)).sort();
  const [ticker, setTicker] = useState(mine[0] ?? rest[0] ?? '');
  const [answer, setAnswer] = useState<DividendAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async () => {
    setBusy(true);
    setError(null);
    try {
      setAnswer(await api.dividend(result.address, ticker, result.mode === 'demo'));
    } catch (e) {
      setError((e as Error).message);
      setAnswer(null);
    } finally {
      setBusy(false);
    }
  };

  const tone = answer?.status === 'hit' ? 'info' : answer?.status === 'unread' ? 'watch' : 'quiet';
  return (
    <div className="dividend-check card">
      <div className="dividend-ask">
        <strong>Did I get the dividend?</strong>
        <select value={ticker} onChange={(e) => setTicker(e.target.value)} aria-label="Ticker">
          {mine.length ? (
            <optgroup label="On this address">
              {mine.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </optgroup>
          ) : null}
          <optgroup label="Other tickers">
            {rest.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </optgroup>
        </select>
        <button type="button" className="btn primary" onClick={ask} disabled={busy || !ticker}>
          {busy ? 'Reading…' : 'Ask'}
        </button>
      </div>
      {error ? <p className="error">{error}</p> : null}
      {answer && answer.ticker === ticker ? (
        <div className="dividend-answer">
          <span className={`chip ${tone}`}>
            {answer.status === 'hit'
              ? 'Yes'
              : answer.status === 'not-held' || answer.status === 'miss'
                ? 'No change for this holder'
                : answer.status === 'unread'
                  ? 'Balance at the event not read'
                  : answer.status}
          </span>
          <p>{answer.card}</p>
          {answer.notes.length ? (
            <ul className="notes">
              {answer.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
          <p className="muted small">Also available to agents as the MCP tool sharetrue.dividend(address, ticker).</p>
        </div>
      ) : null}
    </div>
  );
}
