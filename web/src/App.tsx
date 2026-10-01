import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AppConfigResponse, type ScanResult } from './api';
import { Buy } from './components/Buy';
import { Collateral } from './components/Collateral';
import { Explainer } from './components/Explainer';
import { Footer } from './components/Footer';
import { Landing } from './components/Landing';
import { Ledger } from './components/Ledger';
import { LogoMark } from './components/Logo';
import { Lookup } from './components/Lookup';
import { Portfolio } from './components/Portfolio';
import { Spread } from './components/Spread';
import { StatementHead } from './components/StatementHead';
import { Units } from './components/Units';

export type Tab = 'portfolio' | 'ledger' | 'collateral' | 'spread' | 'buy' | 'units';
const TABS: { id: Tab; label: string }[] = [
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'ledger', label: 'Ledger' },
  { id: 'collateral', label: 'Collateral' },
  { id: 'spread', label: 'Spread' },
  { id: 'buy', label: 'Buy' },
  { id: 'units', label: 'How units work' },
];
/** Tabs that stand on their own, without a scanned address. */
const STANDALONE: Tab[] = ['spread', 'buy', 'units'];

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

  /** Feature cards: statement tabs open on the demo; Buy and units stand alone. */
  const openFeature = (t: Tab) => {
    go(t);
    if (!STANDALONE.includes(t) && !result) void scan('demo');
  };

  const alerts = result?.collateral.positions.filter((p) => p.severity === 'alert').length ?? 0;
  const standalone = STANDALONE.includes(tab);
  const showLanding = !result && !standalone;

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
            <LogoMark size={28} />
            Shaddai
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
          <div className="top-actions">
            {result?.mode === 'demo' || config?.mode === 'demo' ? (
              <span className="badge demo">Demo data</span>
            ) : config ? (
              <span className="badge live">BSC mainnet</span>
            ) : null}
            <ThemeToggle />
            {!result ? (
              <button
                type="button"
                className="btn primary hide-sm"
                onClick={() => openFeature('portfolio')}
                disabled={pendingAddress !== null}
              >
                Open the demo
              </button>
            ) : null}
          </div>
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

      {result && !standalone ? <Explainer /> : null}

      <main>
        {showLanding ? (
          <Landing config={config} onScan={scan} onFeature={openFeature} busy={pendingAddress !== null} error={error} />
        ) : null}

        {result && !standalone ? (
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

        {tab === 'spread' ? (
          <div className="wrap">
            <Spread demo={result?.mode === 'demo' || config?.mode === 'demo'} />
          </div>
        ) : null}

        {tab === 'buy' ? (
          <div className="wrap">
            <Buy demo={result?.mode === 'demo' || config?.mode === 'demo'} demoAddress={config?.demoAddress} />
          </div>
        ) : null}
      </main>

      <Footer links={config?.links} />
    </>
  );
}

/** Light by default; the choice is remembered per browser. */
function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? 'light');
  const flip = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem('shaddai.theme', next);
    } catch {
      /* storage unavailable: the choice lasts for this visit */
    }
    setTheme(next);
  };
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={flip}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {theme === 'dark' ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </>
        ) : (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        )}
      </svg>
    </button>
  );
}
