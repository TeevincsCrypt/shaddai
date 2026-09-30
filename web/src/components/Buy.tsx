import { useEffect, useRef, useState } from 'react';
import {
  api,
  type BuyConfigResponse,
  type BuyQuote,
  type OrderStatus,
  type PayInSymbol,
  type PrepareResult,
  type WrapperQuote,
} from '../api';
import { amount, bscscan, mult, price, shortAddr } from '../format';
import { connect, hasWallet, sendTx, signTypedData, waitForReceipt } from '../wallet';

const TERMINAL = new Set(['FILLED', 'FAILED', 'EXPIRED', 'CANCELLED']);

type Exec =
  | { s: 'idle' }
  | { s: 'busy'; label: string; prepared?: PrepareResult }
  | { s: 'ready'; prepared: PrepareResult }
  | { s: 'order'; orderId: string; status: OrderStatus | { status: string; txHash?: null } }
  | { s: 'error'; message: string; prepared?: PrepareResult };

export function Buy({ demo: demoProp, demoAddress }: { demo: boolean; demoAddress?: string }) {
  const [demo, setDemo] = useState(demoProp);
  const [cfg, setCfg] = useState<BuyConfigResponse | null>(null);
  const [cfgError, setCfgError] = useState<string | null>(null);
  const [ticker, setTicker] = useState('NVDA');
  const [usdInput, setUsdInput] = useState('25');
  const [payIn, setPayIn] = useState<PayInSymbol>('USDT');
  const [wallet, setWallet] = useState<string | null>(null);
  const [quote, setQuote] = useState<BuyQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [exec, setExec] = useState<Exec>({ s: 'idle' });
  const alive = useRef(true);

  useEffect(() => setDemo(demoProp), [demoProp]);
  useEffect(() => {
    alive.current = true;
    setCfg(null);
    api
      .buyConfig(demo)
      .then((c) => {
        setCfg(c);
        if (c.limits && Number(usdInput) > c.limits.maxUsd) setUsdInput(String(c.limits.maxUsd));
      })
      .catch((e: Error) => setCfgError(e.message));
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo]);

  const who = demo ? (demoAddress ?? null) : wallet;
  const usd = Number(usdInput);

  const runQuote = async () => {
    setQuoting(true);
    setQuoteError(null);
    setExec({ s: 'idle' });
    try {
      const q = await api.buyQuote({ ticker, usd, payIn, wallet: who }, demo);
      setQuote(q);
      setChosen(q.best);
    } catch (e) {
      setQuote(null);
      setQuoteError((e as Error).message);
    } finally {
      setQuoting(false);
    }
  };

  const prepare = async (opts: { skipAllowance?: boolean } = {}) => {
    if (!quote || !chosen || !who) return;
    setExec({ s: 'busy', label: 'Re-quoting and building the next step…' });
    try {
      const prepared = await api.buyPrepare(
        {
          token: chosen,
          usd: quote.usd,
          payIn: quote.payIn.symbol,
          wallet: who,
          demoSkipAllowance: opts.skipAllowance,
        },
        demo,
      );
      setExec({ s: 'ready', prepared });
    } catch (e) {
      setExec({ s: 'error', message: (e as Error).message });
    }
  };

  const approve = async (p: Extract<PrepareResult, { step: 'approve' }>) => {
    setExec({ s: 'busy', label: 'Confirm the approve in your wallet…', prepared: p });
    try {
      const hash = await sendTx(p.approve.tx);
      setExec({ s: 'busy', label: `Approve sent (${shortAddr(hash)}). Waiting for BSC…`, prepared: p });
      if (!(await waitForReceipt(hash))) throw new Error('The approve transaction reverted.');
      await prepare();
    } catch (e) {
      setExec({ s: 'error', message: (e as Error).message, prepared: p });
    }
  };

  const sign = async (p: Extract<PrepareResult, { step: 'sign' }>) => {
    if (!wallet) return;
    setExec({ s: 'busy', label: 'Sign the order in your wallet…', prepared: p });
    try {
      const signature = await signTypedData(wallet, p.order.typedData);
      const sub = await api.buySubmit({
        requestId: crypto.randomUUID(),
        signature,
        vendor: p.order.vendor,
        quoteId: p.order.quoteId,
        signingScheme: p.order.signingScheme,
      });
      setExec({ s: 'order', orderId: sub.orderId, status: { status: sub.status } });
      const until = Date.now() + 5 * 60_000;
      while (alive.current && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 3000));
        const st = await api.buyOrder(sub.orderId).catch(() => null);
        if (!st) continue;
        setExec({ s: 'order', orderId: sub.orderId, status: st });
        if (TERMINAL.has(st.status)) break;
      }
    } catch (e) {
      setExec({ s: 'error', message: (e as Error).message, prepared: p });
    }
  };

  const sendSwap = async (p: Extract<PrepareResult, { step: 'send' }>) => {
    setExec({ s: 'busy', label: 'Confirm the swap in your wallet…', prepared: p });
    try {
      const hash = await sendTx(p.tx);
      const ok = await waitForReceipt(hash);
      setExec({
        s: 'order',
        orderId: hash,
        status: {
          orderId: hash,
          status: ok ? 'FILLED' : 'FAILED',
          txHash: hash as `0x${string}`,
          fromAmount: null,
          toAmount: null,
        },
      });
    } catch (e) {
      setExec({ s: 'error', message: (e as Error).message, prepared: p });
    }
  };

  if (!cfg) {
    return (
      <section className="section">
        <p className="muted">{cfgError ?? 'Loading…'}</p>
      </section>
    );
  }

  const tickers = cfg.tickers.filter((t) => t.wrappers.length > 0);
  const chosenQ = quote?.wrappers.find((w) => w.token.address === chosen) ?? null;
  const prepared = exec.s === 'ready' || exec.s === 'busy' || exec.s === 'error' ? exec.prepared : undefined;

  return (
    <section className="section" aria-labelledby="buy-h">
      <div className="section-head">
        <div>
          <h2 id="buy-h">Buy in shares, not tokens</h2>
          <p>
            Enter the dollars of stock you want. Shaddai quotes every wrapper of that ticker and ranks them by the
            share-equivalents you would own: raw tokens × the factor the contract (<code>uiMultiplier</code>) or Ondo’s
            oracle (<code>sValue</code>) reports. A wrapper whose factor is not read is not quoted. A book that moves
            more than {cfg.limits?.maxImpactPct ?? 1}% for your ticket is refused.
          </p>
        </div>
        <div className="toolbar small">
          {demo ? <span className="chip demo">Demo quotes</span> : null}
          {cfg.api ? <span className="chip quiet">{cfg.api}</span> : null}
        </div>
      </div>

      {!cfg.enabled ? (
        <div className="empty">
          <strong>Buy is not switched on for this deployment.</strong>
          <span>
            The server needs a Binance Web3 API key (BINANCE_WEB3_API_KEY and BINANCE_WEB3_API_SECRET). The other tabs
            work without it.
          </span>
          {!demo ? (
            <button type="button" className="btn" onClick={() => setDemo(true)} style={{ justifySelf: 'start' }}>
              Try it on the demo
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <form
            className="buy-form"
            onSubmit={(e) => {
              e.preventDefault();
              void runQuote();
            }}
          >
            <label>
              <span className="eyebrow">Stock</span>
              <select value={ticker} onChange={(e) => setTicker(e.target.value)}>
                {tickers.map((t) => (
                  <option key={t.ticker} value={t.ticker}>
                    {t.ticker} · {t.wrappers.map((w) => w.symbol).join(' / ')}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="eyebrow">Dollars of shares</span>
              <input
                inputMode="decimal"
                value={usdInput}
                onChange={(e) => setUsdInput(e.target.value.replace(/[^0-9.]/g, ''))}
                aria-describedby="buy-limit"
              />
              <span id="buy-limit" className="small muted">
                Up to ${cfg.limits?.maxUsd} per ticket
              </span>
            </label>
            <div>
              <span className="eyebrow">Pay with</span>
              <div className="seg" role="group" aria-label="Pay with">
                {cfg.payIn.map((p) => (
                  <button key={p} type="button" aria-pressed={payIn === p} onClick={() => setPayIn(p)}>
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <span className="eyebrow">Wallet</span>
              {demo ? (
                <span className="small mono muted">{who ? `${shortAddr(who)} (demo)` : 'demo'}</span>
              ) : wallet ? (
                <span className="small mono">{shortAddr(wallet)}</span>
              ) : (
                <button
                  type="button"
                  className="btn"
                  disabled={!hasWallet()}
                  title={hasWallet() ? undefined : 'No browser wallet found'}
                  onClick={() =>
                    connect()
                      .then(setWallet)
                      .catch((e: Error) => setQuoteError(e.message))
                  }
                >
                  {hasWallet() ? 'Connect wallet' : 'No wallet found'}
                </button>
              )}
            </div>
            <button type="submit" className="btn primary" disabled={quoting || !(usd > 0)}>
              {quoting ? 'Quoting…' : 'Quote'}
            </button>
          </form>

          {quoteError ? <p className="error">{quoteError}</p> : null}
          {quote ? <QuoteTable quote={quote} chosen={chosen} onChoose={setChosen} /> : null}
          {quote?.fallback ? (
            <div className="buy-exec">
              <h3>On-chain pools instead · comparison only</h3>
              <p className="small muted">
                The Binance Web3 API refused this server, so here is the same share-true comparison priced against
                PancakeSwap pools read on BSC. Nothing can be bought through this.
              </p>
              <QuoteTable quote={quote.fallback} chosen={null} onChoose={() => undefined} />
            </div>
          ) : null}

          {quote && !quote.quoteOnly && chosenQ?.status === 'ok' ? (
            <div className="buy-exec">
              <h3>
                Buy {amount(chosenQ.shareEqOut, 6)} share-eq of {quote.ticker} as {chosenQ.token.symbol}
              </h3>
              <p className="small muted">
                Step 1 approves exactly {quote.usd} {quote.payIn.symbol} to the vendor’s spender. Step 2 signs one
                order; the vendor settles it on BSC. Each step re-quotes first, because a quote lives about 30 seconds.
              </p>
              {!demo && !wallet ? <p className="small">Connect a wallet to continue.</p> : null}
              <div className="toolbar">
                <button
                  type="button"
                  className="btn"
                  disabled={exec.s === 'busy' || !who}
                  onClick={() => void prepare()}
                >
                  {demo ? 'Preview the approve' : 'Check allowance'}
                </button>
                {demo ? (
                  <button
                    type="button"
                    className="btn"
                    disabled={exec.s === 'busy'}
                    onClick={() => void prepare({ skipAllowance: true })}
                  >
                    Preview the order
                  </button>
                ) : null}
              </div>
              {exec.s === 'busy' ? <p className="small">{exec.label}</p> : null}
              {exec.s === 'error' ? <p className="error">{exec.message}</p> : null}
              {prepared ? (
                <Prepared
                  p={prepared}
                  demo={demo}
                  busy={exec.s === 'busy'}
                  onApprove={approve}
                  onSign={sign}
                  onSend={sendSwap}
                />
              ) : null}
              {exec.s === 'order' ? <OrderView orderId={exec.orderId} status={exec.status} /> : null}
            </div>
          ) : null}
        </>
      )}

      <p className="unit-label">
        Spot only, BNB Smart Chain only. Tokens are not the listed share and carry no voting rights. Your wallet signs;
        Shaddai never holds funds or keys. Not investment advice.
      </p>
    </section>
  );
}

function QuoteTable({
  quote,
  chosen,
  onChoose,
}: {
  quote: BuyQuote;
  chosen: string | null;
  onChoose: (a: string) => void;
}) {
  return (
    <>
      <div className="table-scroll stack">
        <table className="stmt stack">
          <thead>
            <tr>
              <th>Wrapper</th>
              <th className="num">
                Raw tokens<span className="sub">what the quote gives</span>
              </th>
              <th className="num">Factor</th>
              <th className="num">
                Share-equivalents<span className="sub">what you would own</span>
              </th>
              <th className="num">
                Per share-eq<span className="sub">vs reference</span>
              </th>
              <th className="num">Impact</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {quote.wrappers.map((w) => (
              <WrapperRow
                key={w.token.address}
                w={w}
                best={w.token.address === quote.best}
                chosen={w.token.address === chosen}
                onChoose={onChoose}
                quoteOnly={quote.quoteOnly}
              />
            ))}
          </tbody>
        </table>
      </div>
      {quote.notes.length ? (
        <ul className="notes" style={{ maxWidth: 'none' }}>
          {quote.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}
      <p className="small muted">
        Paying {quote.usd} {quote.payIn.symbol} ({shortAddr(quote.payIn.address)}, {quote.payIn.source}) · block{' '}
        {quote.block} · {quote.api}
        {quote.mode === 'demo' ? ' · demo figures are illustrative' : ''}
      </p>
    </>
  );
}

function WrapperRow({
  w,
  best,
  chosen,
  onChoose,
  quoteOnly,
}: {
  w: WrapperQuote;
  best: boolean;
  chosen: boolean;
  onChoose: (a: string) => void;
  quoteOnly: boolean;
}) {
  const refused = w.status === 'refused';
  return (
    <tr className={refused ? 'dim' : chosen ? 'chosen' : undefined}>
      <td className="span-2">
        <div className="inst">
          <span className="tk">
            {w.token.symbol}
            <span className="issuer">{w.token.issuer}</span>
          </span>
          <span className="meta">
            <a href={bscscan('token', w.token.address)} target="_blank" rel="noreferrer">
              {shortAddr(w.token.address)}
            </a>
            {w.route ? ` · ${w.route.vendor} ${w.route.executionMode}` : ''}
          </span>
          {refused ? (
            <ul className="notes">
              {w.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          ) : null}
          {w.notes.length ? (
            <ul className="notes">
              {w.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </td>
      <td className="num raw-v" data-label="Raw tokens">
        {amount(w.rawOut)}
      </td>
      <td className="num mult-v" data-label="Factor">
        {w.factor === null ? <span className="muted">not read</span> : mult(w.factor)}
        {w.factorSource ? (
          <span className="drift" style={{ color: 'var(--faint)' }}>
            {w.factorSource}
          </span>
        ) : null}
      </td>
      <td className="num" data-label="Share-equivalents">
        {w.shareEqOut === null ? (
          <span className="muted">—</span>
        ) : (
          <span className="share-v">{amount(w.shareEqOut)}</span>
        )}
        {w.fillOfTargetPct !== null ? (
          <span className="drift" style={{ color: 'var(--faint)' }}>
            {w.fillOfTargetPct.toFixed(2)}% of target
          </span>
        ) : null}
      </td>
      <td className="num" data-label="Per share-eq">
        {price(w.usdPerShare)}
        {w.referencePrice ? (
          <span className="drift" style={{ color: 'var(--faint)' }}>
            ref {price(w.referencePrice)} · {w.referenceSource === 'binance-rwa' ? 'Binance RWA' : 'DEX mark'}
          </span>
        ) : null}
      </td>
      <td className="num" data-label="Impact">
        {w.impactPct === null ? '—' : `${w.impactPct.toFixed(2)}%`}
        {w.impactSource ? (
          <span className="drift" style={{ color: 'var(--faint)' }}>
            {w.impactSource}
          </span>
        ) : null}
      </td>
      <td className="span-2">
        {refused ? (
          <span className="chip alert">Refused</span>
        ) : (
          <div style={{ display: 'grid', gap: 6, justifyItems: 'start' }}>
            {best ? <span className="chip">Most shares</span> : null}
            {quoteOnly ? (
              <span className="chip quiet">Quote only</span>
            ) : (
              <button type="button" className="btn" aria-pressed={chosen} onClick={() => onChoose(w.token.address)}>
                {chosen ? 'Selected' : 'Select'}
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

function Prepared({
  p,
  demo,
  busy,
  onApprove,
  onSign,
  onSend,
}: {
  p: PrepareResult;
  demo: boolean;
  busy: boolean;
  onApprove: (p: Extract<PrepareResult, { step: 'approve' }>) => void;
  onSign: (p: Extract<PrepareResult, { step: 'sign' }>) => void;
  onSend: (p: Extract<PrepareResult, { step: 'send' }>) => void;
}) {
  if (p.step === 'refused') {
    return (
      <div className="warn alert">
        <div className="warn-head">
          <span className="sev">Refused</span>
          <h3>Nothing to sign</h3>
        </div>
        <ul className="notes" style={{ maxWidth: 'none' }}>
          {p.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </div>
    );
  }
  if (p.step === 'approve') {
    const sim = p.approve.simulation;
    return (
      <div className="warn">
        <div className="warn-head">
          <span className="sev">Step 1</span>
          <h3>Approve {p.quote.payIn.symbol}</h3>
        </div>
        <div className="warn-grid">
          <Fact k="Amount" v={`${p.quote.usd} ${p.quote.payIn.symbol} (exact)`} />
          <Fact k="Spender" v={shortAddr(p.approve.spender)} href={bscscan('address', p.approve.spender)} />
          <Fact k="Current allowance" v={p.approve.allowanceRaw === '0' ? '0' : 'below ticket'} />
          <Fact
            k="Dry run (Transaction API)"
            v={sim ? sim.status : 'not run'}
            sub={sim?.failReason ?? p.approve.simulationError ?? undefined}
          />
        </div>
        {sim?.allowanceChanges.length ? (
          <p className="small muted">
            Allowance {sim.allowanceChanges[0]!.pre} → {sim.allowanceChanges[0]!.post} (base units), checked against the
            calldata before your wallet sees it.
          </p>
        ) : null}
        <button type="button" className="btn primary" disabled={demo || busy} onClick={() => onApprove(p)}>
          {demo ? 'Approve in wallet (live only)' : 'Approve in wallet'}
        </button>
      </div>
    );
  }
  if (p.step === 'sign') {
    return (
      <div className="warn">
        <div className="warn-head">
          <span className="sev">Step 2</span>
          <h3>Sign the {p.order.vendor} order</h3>
        </div>
        <p className="small muted">{p.note}</p>
        <ul className="checks" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {p.order.checks.map((c) => (
            <li key={c.name}>
              <span className={`chip ${c.ok ? '' : 'alert'}`}>{c.ok ? 'ok' : 'fail'}</span>
              <strong>{c.name}</strong>
              <span className="detail muted">{c.detail}</span>
            </li>
          ))}
        </ul>
        <p className="small mono muted">
          {p.order.primaryType} · {String(p.order.domain.name ?? '')}{' '}
          {p.order.domain.verifyingContract ? `· ${shortAddr(String(p.order.domain.verifyingContract))}` : ''}
        </p>
        <button type="button" className="btn primary" disabled={demo || busy} onClick={() => onSign(p)}>
          {demo ? 'Sign in wallet (live only)' : 'Sign order in wallet'}
        </button>
      </div>
    );
  }
  return (
    <div className="warn">
      <div className="warn-head">
        <span className="sev">Step 2</span>
        <h3>Send the swap</h3>
      </div>
      <p className="small muted">
        Dry run: {p.simulation?.status ?? 'not run'} {p.simulation?.failReason ?? p.simulationError ?? ''}
      </p>
      <button type="button" className="btn primary" disabled={demo || busy} onClick={() => onSend(p)}>
        Send in wallet
      </button>
    </div>
  );
}

function Fact({ k, v, sub, href }: { k: string; v: string; sub?: string; href?: string }) {
  return (
    <div>
      <div className="eyebrow">{k}</div>
      <div className="v">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {v}
          </a>
        ) : (
          v
        )}
      </div>
      {sub ? <div className="small muted">{sub}</div> : null}
    </div>
  );
}

function OrderView({ orderId, status }: { orderId: string; status: { status: string; txHash?: string | null } }) {
  const done = TERMINAL.has(status.status);
  return (
    <div className={`warn ${status.status === 'FILLED' ? '' : done ? 'alert' : 'watch'}`}>
      <div className="warn-head">
        <span className="sev">{status.status}</span>
        <h3>Order {shortAddr(orderId)}</h3>
      </div>
      {status.txHash ? (
        <p className="small">
          Settled in{' '}
          <a href={bscscan('tx', status.txHash)} target="_blank" rel="noreferrer">
            {shortAddr(status.txHash)}
          </a>
          . Scan your address to see the new share-equivalents.
        </p>
      ) : (
        <p className="small muted">{done ? 'The order did not settle.' : 'Waiting for the vendor to settle on BSC…'}</p>
      )}
    </div>
  );
}
