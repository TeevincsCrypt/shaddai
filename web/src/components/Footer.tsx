import { LogoMark } from './Logo';

const DEFAULT_LINKS: Record<string, string> = {
  bep677: 'https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-677.md',
  erc8056: 'https://eips.ethereum.org/EIPS/eip-8056',
  bstocks: 'https://www.bstocks.finance/en',
  bstocksProof: 'https://www.binance.com/en/proof-of-collateral/bstocks',
  ondo: 'https://ondo.finance/ondo-stocks',
  xstocks: 'https://xstocks.fi',
  venus: 'https://app.venus.io',
  lista: 'https://lista.org/lending',
};

const LABELS: Record<string, string> = {
  bstocks: 'bStocks',
  bstocksProof: 'bStocks proof of collateral',
  ondo: 'Ondo Global Markets',
  xstocks: 'xStocks',
  bep677: 'BEP-677 spec',
  erc8056: 'ERC-8056',
  venus: 'Venus',
  lista: 'Lista Lending',
};

export function Footer({ links }: { links?: Record<string, string> }) {
  const l = { ...DEFAULT_LINKS, ...links };
  return (
    <footer className="footer">
      <div className="wrap">
        <div className="brand">
          <LogoMark size={24} />
          Shaddai
          <span className="muted small" style={{ fontWeight: 400 }}>
            Share-true accounting for tokenized stocks on BSC
          </span>
        </div>
        <p className="legal">
          bStocks, Ondo and xStocks tokens are not the listed share and carry no voting rights. Estimates assume
          published multipliers and typical withholding. Not tax, legal or investment advice. US persons are excluded
          from several of these products; Shaddai does not check eligibility. Everything except Buy only reads. Buy asks
          your wallet for one approve and then one swap or one order signature; Shaddai never holds funds or keys.
        </p>
        <div className="links">
          {Object.keys(LABELS).map((k) =>
            l[k] ? (
              <a key={k} href={l[k]} target="_blank" rel="noreferrer">
                {LABELS[k]}
              </a>
            ) : null,
          )}
          <span>Built for BNB Hack: Tokenized Stocks Edition · spot only · BSC mainnet</span>
        </div>
      </div>
    </footer>
  );
}
