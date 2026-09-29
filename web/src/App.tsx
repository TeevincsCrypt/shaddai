import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AppConfigResponse, type ScanResult } from './api';
import { Collateral } from './components/Collateral';
import { Explainer } from './components/Explainer';
import { Footer } from './components/Footer';
import { Landing } from './components/Landing';
import { Ledger } from './components/Ledger';
import { Lookup } from './components/Lookup';
import { Portfolio } from './components/Portfolio';
import { StatementHead } from './components/StatementHead';
import { Units } from './components/Units';

export type Tab = 'portfolio' | 'ledger' | 'collateral' | 'units';
const TABS: { id: Tab; label: string }[] = [
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'collateral', label: 'Collateral' },
  { id: 'units', label: 'How units work' },
];

const tabFromHash = (): Tab => {
  const h = window.location.hash.replace('#', '');
  return (TABS.find((t) => t.id === h)?.id ?? 'portfolio') as Tab;
};

export function App() {
  const [config, setConfig] = useState<AppConfigResponse | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [pendingAddress, setPendingAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    api
      .config()
      .then(setConfig)
      .catch(() => setConfig(null));
    const onHash = () => setTab(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (t: Tab) => {
    setTab(t);
    history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${t}`);
    window.scrollTo({ top: 0 });
  };

  const stopPolling = () => {
    if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    pollRef.current = null;
  };

  const scan = useCallback(async (raw: string) => {
    const address = raw.trim();
    if (!address) return;
    stopPolling();
    setError(null);
    setPendingAddress(address);
    try {
      let r = await api.scan(address);
      setResult(r);
      const url = new URL(window.location.href);
      url.searchParams.set('a', r.mode === 'demo' && address.toLowerCase() === 'demo' ? 'demo' : r.address);
      history.replaceState(null, '', url);
      const started = Date.now();
      const poll = async () => {
        if (r.ledger.status !== 'indexing' || Date.now() - started > 10 * 60_000) return;
        try {
          r = await api.scan(r.address, true);
          setResult(r);
        } catch {
          /* keep polling */
        }
        pollRef.current = window.setTimeout(poll, 4000);
      };
      if (r.ledger.status === 'indexing') pollRef.current = window.setTimeout(poll, 4000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPendingAddress(null);
    }
  }, []);

  useEffect(() => {
    const a = new URL(window.location.href).searchParams.get('a');
    if (a) void scan(a);
    return stopPolling;
  }, [scan]);

  const reset = () => {
    stopPolling();
    setResult(null);
    setError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('a');
    url.hash = '';
    history.replaceState(null, '', url);
    setTab('portfolio');
  };

  const alerts = result?.collateral.positions.filter((p) => p.severity === 'alert').length ?? 0;
  const showLanding = !result && tab !== 'units';

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <a
            className="wordmark"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              reset();
            }}
          >
            Shaddai <span className="x">×</span>
          </a>
          <nav className="nav" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id && !showLanding ? 'page' : undefined}
                onClick={() => go(t.id)}
              >
                {t.label}
                {t.id === 'collateral' && alerts > 0 ? <span className="count">{alerts}</span> : null}
              </button>
            ))}
          </nav>
          <span className="spacer" />
          {result?.mode === 'demo' || config?.mode === 'demo' ? (
            <span className="badge demo">Demo data</span>
          ) : config ? (
            <span className="badge live">BSC mainnet</span>
          ) : null}
        </div>
      </header>

      {result?.mode === 'demo' ? (
        <div className="demo-strip">
          <div className="wrap">
            Demo fixture. A simulated chain with illustrative numbers, not on-chain data. XMPLB (Example Corp) is
            fictional.
          </div>
        </div>
      ) : null}

      {result && tab !== 'units' ? <Explainer /> : null}

      <main>
        {showLanding ? <Landing config={config} onScan={scan} busy={pendingAddress !== null} error={error} /> : null}

        {result && tab !== 'units' ? (
          <>
            <div className="wrap">
              <StatementHead result={result} onTab={go} />
              <div style={{ paddingTop: 16 }}>
                <Lookup
                  compact
                  initial={result.mode === 'demo' ? '' : result.address}
                  onScan={scan}
                  busy={pendingAddress !== null}
                  demoAddress={config?.demoAddress}
                />
                {error ? (
                  <p className="error" style={{ marginTop: 8 }}>
                    {error}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="wrap">
              {tab === 'portfolio' ? <Portfolio result={result} /> : null}
              {tab === 'ledger' ? <Ledger result={result} /> : null}
              {tab === 'collateral' ? <Collateral result={result} /> : null}
            </div>
          </>
        ) : null}

        {tab === 'units' ? (
          <div className="wrap">
            <Units />
          </div>
        ) : null}
      </main>

      <Footer links={config?.links} />
    </>
  );
}
