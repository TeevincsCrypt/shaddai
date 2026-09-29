import type { ScanResult } from '../api';
import type { Tab } from '../App';
import { bscscan, dateTime, usd } from '../format';

export function StatementHead({ result, onTab }: { result: ScanResult; onTab: (t: Tab) => void }) {
  const wallet = result.portfolio.rows.filter((r) => r.location.kind === 'wallet' && !r.dust);
  const inProtocols = result.portfolio.rows.filter((r) => r.location.kind !== 'wallet');
  const ledgerRows = result.ledger.rows.filter((r) => r.status !== 'overwritten');
  const pending = ledgerRows.filter((r) => r.status === 'pending').length;
  const alerts = result.collateral.positions.filter((p) => p.severity === 'alert').length;
  const watch = result.collateral.positions.filter((p) => p.severity === 'watch').length;

  return (
    <section className="statement-head" aria-label="Statement summary">
      <div className="who">
        <h1>Statement</h1>
        <a className="addr" href={bscscan('address', result.address)} target="_blank" rel="noreferrer">
          {result.address}
        </a>
        <span className={`badge ${result.mode === 'demo' ? 'demo' : 'live'}`}>
          {result.mode === 'demo' ? 'Demo' : 'Live'}
        </span>
      </div>
      <p className="small muted">
        As of block{' '}
        {result.mode === 'demo' ? (
          <span className="mono">{result.block}</span>
        ) : (
          <a className="mono" href={bscscan('block', result.block)} target="_blank" rel="noreferrer">
            {result.block}
          </a>
        )}{' '}
        · {dateTime(result.blockTime)}
      </p>
      <div className="facts">
        <div className="fact">
          <span className="eyebrow">Marked value</span>
          <span className="v">{usd(result.portfolio.totalUsd)}</span>
          <span className="small muted">
            {result.portfolio.pricedRows} of {result.portfolio.rows.length} positions have a DEX mark
          </span>
        </div>
        <div className="fact">
          <span className="eyebrow">Instruments in wallet</span>
          <span className="v">{wallet.length}</span>
          <span className="small muted">{inProtocols.length} more positions inside protocols</span>
        </div>
        <div className="fact">
          <span className="eyebrow">Events with no transfer</span>
          <span className="v">{result.ledger.status === 'ready' ? ledgerRows.length : '…'}</span>
          <button type="button" className="linkish small" onClick={() => onTab('ledger')}>
            {pending ? `${pending} pending · open ledger` : 'Open ledger'}
          </button>
        </div>
        <div className="fact">
          <span className="eyebrow">Collateral warnings</span>
          <span className={`v ${alerts ? 'alert' : watch ? 'watch' : ''}`}>{result.collateral.positions.length}</span>
          <button type="button" className="linkish small" onClick={() => onTab('collateral')}>
            {alerts ? `${alerts} alert${alerts > 1 ? 's' : ''}` : watch ? `${watch} to watch` : 'Open collateral'}
          </button>
        </div>
      </div>
      {result.warnings.length ? (
        <ul className="notes" style={{ color: 'var(--watch)', maxWidth: 'none' }}>
          {result.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
