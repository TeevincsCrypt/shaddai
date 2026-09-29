import type { AppConfigResponse } from '../api';
import { Lookup } from './Lookup';

const SURFACES: [string, string, string][] = [
  ['Binance, BscScan (BEP-8056 view)', 'raw × uiMultiplier', '“I have 10.006 Apple”'],
  ['Most wallets', 'balanceOf()', '“I have 10.000 tokens. Did I miss the dividend?”'],
  ['Venus, Lista', 'balanceOf + an oracle price', 'Collateral math may not match share-equivalents after a split'],
  ['Crypto tax software', 'Transfer events', 'Nothing happened. Basis never moves.'],
];

export function Landing(props: {
  config: AppConfigResponse | null;
  onScan: (a: string) => void;
  busy: boolean;
  error: string | null;
}) {
  return (
    <div className="wrap landing">
      <div style={{ display: 'grid', gap: 18 }}>
        <p className="eyebrow">Share-true accounting for tokenized stocks on BSC</p>
        <h1>Your wallet counts tokens. Shaddai counts shares.</h1>
        <p className="lede">
          When a tokenized stock pays a dividend or splits, the raw balance usually stays put and the issuer raises a
          multiplier. Paste a BSC address. We read raw balances, then the multiplier the wallet ignores.
        </p>
      </div>

      <div className="equation" aria-label="10 raw NVDAB times multiplier 1.0017 equals 10.017 share-equivalents">
        <span className="v raw">10.000000</span>
        <span className="op">×</span>
        <span className="v m">1.0017</span>
        <span className="op">=</span>
        <span className="v">10.017000</span>
        <span className="lbl">raw NVDAB · what MetaMask shows</span>
        <span />
        <span className="lbl">uiMultiplier()</span>
        <span />
        <span className="lbl">share-equivalents</span>
      </div>

      <div className="actions">
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

      <section style={{ display: 'grid', gap: 12 }} aria-labelledby="surfaces-h">
        <h2 id="surfaces-h" style={{ fontSize: 'var(--step-1)' }}>
          The same 10 AAPLB, four answers
        </h2>
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
