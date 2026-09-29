export function Units() {
  return (
    <section className="section" aria-labelledby="un-h">
      <div className="section-head">
        <div>
          <h2 id="un-h">How units work</h2>
          <p>Three issuers, three ways the number in the wallet stops being the number of shares.</p>
        </div>
      </div>

      <div className="prose">
        <p>
          A tokenized stock contract stores a raw balance per holder. When the company pays a dividend or splits, most
          issuers do not mint or send you anything. They change a factor that says how many shares one raw token stands
          for. Any screen that reads only <code>balanceOf()</code> misses it.
        </p>
        <div className="formula">
          {`UI        = raw × uiMultiplier / 1e18
raw       = UI × 1e18 / uiMultiplier     (lossy: never invert for accounting)
UI price  = rawPrice × 1e18 / uiMultiplier`}
        </div>
        <p>
          Shaddai stores and compares raw amounts and only converts at the display edge. A DEX pool trades raw tokens,
          so its price is per raw token. Dividing that price by the multiplier gives a per-share mark, so the dividend
          shows up once: in the share count, not again in the price.
        </p>
      </div>

      <div className="issuers">
        <div>
          <h3>bStocks</h3>
          <p className="small muted">BEP-677 / ERC-8056 Scaled UI Amount</p>
          <p>
            <code>shareEq = raw × uiMultiplier() / 1e18</code>. Dividends are reinvested net of about 30% US
            withholding. Splits change the same multiplier.
          </p>
          <p>
            The issuer schedules a change with <code>UIMultiplierUpdated(old, new, effectiveAt)</code>; views switch
            once the block time reaches <code>effectiveAt</code>. A schedule can be overwritten before it lands.
          </p>
        </div>
        <div>
          <h3>Ondo</h3>
          <p className="small muted">Total-return tracker</p>
          <p>
            The economics live in <code>sValue</code> on Ondo’s SyntheticSharesOracle, not in a wallet transfer. Small
            updates (up to 1% a day) apply straight away; larger ones pause the oracle first.
          </p>
          <p>A wallet balance can sit still while the shares one token represents drift.</p>
        </div>
        <div>
          <h3>xStocks</h3>
          <p className="small muted">Tracker certificate with its own multiplier</p>
          <p>
            Same raw-versus-scaled trap. Shaddai reads an xStock through the BEP-677 interface when the contract exposes
            it and reports any other multiplier getter without applying it, until its meaning on BSC is confirmed.
          </p>
        </div>
      </div>

      <div className="prose">
        <h3>Rules this statement follows</h3>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 6 }}>
          <li>Never show only raw. Never show only share-equivalents.</li>
          <li>Share-equivalents are not voting shares.</li>
          <li>
            “1 token ≈ 1 share right now” appears only when the multiplier is exactly 1.0 and nothing is scheduled.
          </li>
          <li>
            A pending change is <code>effectiveAt() &gt; now</code>. <code>newUIMultiplier()</code> equals the current
            multiplier when nothing is scheduled, so it cannot tell you on its own.
          </li>
          <li>Every USD estimate is an estimate at today’s mark, not tax, legal or investment advice.</li>
        </ul>
      </div>
    </section>
  );
}
