import { getAddress, type Address } from 'viem';

/**
 * Registry of tokenized-stock contracts Shaddai knows how to read on BSC mainnet.
 *
 * Every address here is re-verified at scan time: Shaddai reads `symbol()` and
 * flags a mismatch instead of trusting this table. `needsVerification` marks
 * entries whose provenance is weaker than the rest (see `note`).
 */

export type Issuer = 'bStocks' | 'Ondo' | 'xStocks' | 'Demo';

/** The unit model the issuer documents. The scanner still probes the contract. */
export type ExpectedModel = 'bep677' | 'ondo' | 'xstocks';

export interface TokenInfo {
  /** Expected on-chain `symbol()`. */
  symbol: string;
  /** Underlying listed ticker. */
  ticker: string;
  /** Underlying company / fund. */
  name: string;
  issuer: Issuer;
  address: Address;
  model: ExpectedModel;
  needsVerification?: boolean;
  note?: string;
  /** Only exists on the demo fixture chain. */
  demoOnly?: boolean;
}

const t = (
  symbol: string,
  ticker: string,
  name: string,
  issuer: Issuer,
  address: string,
  model: ExpectedModel,
  extra: Partial<TokenInfo> = {},
): TokenInfo => ({
  symbol,
  ticker,
  name,
  issuer,
  // getAddress(lowercase) normalises to EIP-55 without rejecting a mis-cased
  // source string. Mis-cased sources are called out via needsVerification.
  address: getAddress(address.toLowerCase()),
  model,
  ...extra,
});

export const BSTOCKS: TokenInfo[] = [
  t('NVDAB', 'NVDA', 'NVIDIA', 'bStocks', '0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436', 'bep677'),
  t('TSLAB', 'TSLA', 'Tesla', 'bStocks', '0x5b1910eAaD6450E50f816082Aa078C41F10C292f', 'bep677'),
  t('SPCXB', 'SPCX', 'SpaceX-linked', 'bStocks', '0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1', 'bep677'),
  t('AAPLB', 'AAPL', 'Apple', 'bStocks', '0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A', 'bep677'),
  t('GOOGLB', 'GOOGL', 'Alphabet', 'bStocks', '0x3F53De71c126BdaBAe20f9cD64848d317f6C3238', 'bep677'),
  t('MSFTB', 'MSFT', 'Microsoft', 'bStocks', '0x80106cb3ead06659a5ad19df39d9b4733863b9b0', 'bep677'),
  t('CRCLB', 'CRCL', 'Circle', 'bStocks', '0x80f3D493EBCe97e343c53D29a137942416B4ffC0', 'bep677'),
  // The brief's casing failed EIP-55; the hex was right. symbol() returned AMDB on mainnet (29 Sep 2026).
  t('AMDB', 'AMD', 'AMD', 'bStocks', '0x75Fd4cF6f8392e41E70391d60C90c0d5211603a1', 'bep677'),
  t('MUB', 'MU', 'Micron', 'bStocks', '0xcdf2f3e0fa43C47A6662a91C9E4a7C5f69762699', 'bep677'),
  t('SNDKB', 'SNDK', 'Sandisk', 'bStocks', '0x3eE4dF61bd4F867E349BEaE8bFE07bc31b4850fb', 'bep677'),
];

export const ONDO: TokenInfo[] = [
  t('NVDAon', 'NVDA', 'NVIDIA', 'Ondo', '0xA9eE28C80f960B889dFbd1902055218cBa016F75', 'ondo'),
  t('TSLAon', 'TSLA', 'Tesla', 'Ondo', '0x2494b603319d4D9F9715c9f4496d9E0364B59d93', 'ondo'),
  t('AAPLon', 'AAPL', 'Apple', 'Ondo', '0x390a684EF9cADE28A7AD0DFa61AB1Eb3842618c4', 'ondo'),
  t('GOOGLon', 'GOOGL', 'Alphabet', 'Ondo', '0x091fc7778e6932d4009b087b191d1ee3bac5729a', 'ondo'),
  t('AMDon', 'AMD', 'AMD', 'Ondo', '0x9f16E46c73b43BDB70861247d537bEE4eA18F639', 'ondo'),
  t('CRCLon', 'CRCL', 'Circle', 'Ondo', '0x992879cd8ce0c312d98648875b5a8d6d042cbf34', 'ondo'),
  t('QQQon', 'QQQ', 'Invesco QQQ', 'Ondo', '0x0cde6936d305d5b34667fc46425e852efd73559a', 'ondo'),
  t('SPYon', 'SPY', 'SPDR S&P 500', 'Ondo', '0x6a708EAD771238919D85930b5a0f10454E1C331a', 'ondo'),
  t('SPCXon', 'SPCX', 'SpaceX-linked', 'Ondo', '0xd0a58BC9D88D3FF48C0294Cb7e45937d0E41A928', 'ondo'),
];

/**
 * xStocks on BSC: no address has been confirmed for this build. Add confirmed
 * ones through SHADDAI_EXTRA_TOKENS rather than guessing here.
 */
export const XSTOCKS: TokenInfo[] = [];

export const MAINNET_TOKENS: TokenInfo[] = [...BSTOCKS, ...ONDO, ...XSTOCKS];

/** Venus Core Pool (Unitroller). vTokens are also discovered from getAllMarkets(). */
export const VENUS_COMPTROLLER: Address = getAddress('0xfD36E2c2a6789Db23113685031d7F16329158384');

/** Hardcoded vTokens from the brief; used even if market discovery fails. */
export const VENUS_KNOWN_VTOKENS: { underlying: Address; vToken: Address; symbol: string }[] = [
  {
    symbol: 'vTSLAB',
    underlying: getAddress('0x5b1910eAaD6450E50f816082Aa078C41F10C292f'),
    vToken: getAddress('0x97421799419eb782628e73e7220d8e0a207469a3'),
  },
  {
    symbol: 'vNVDAB',
    underlying: getAddress('0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436'),
    vToken: getAddress('0xeb8ca841cbe1bc4832a10b15c7dab1081edad371'),
  },
];

/** Lista Lending core (Moolah, Morpho-Blue style). Address from lista-dao/lending-sdk. */
export const LISTA_MOOLAH: Address = getAddress('0x8F73b65B4caAf64FBA2aF91cC5D4a2A1318E5D8C');
export const LISTA_API_BASE = 'https://api.lista.org';

/** Tickers announced as Lista Lending collateral. Used when market discovery is unavailable. */
export const LISTA_LISTED_SYMBOLS = new Set(['NVDAB', 'TSLAB', 'CRCLB', 'MUB', 'GOOGLB', 'AAPLB', 'MSFTB', 'QQQB']);

export const MULTICALL3: Address = getAddress('0xcA11bde05977b3631167028862bE2a173976CA11');

export const BSC_CHAIN_ID = 56;

export const DEFAULT_RPC_URLS = [
  'https://bsc-rpc.publicnode.com',
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.defibit.io',
  'https://1rpc.io/bnb',
];

export const LINKS = {
  bep677: 'https://github.com/bnb-chain/BEPs/blob/master/BEPs/BEP-677.md',
  erc8056: 'https://eips.ethereum.org/EIPS/eip-8056',
  bstocks: 'https://x.com/bstocksfinance',
  ondo: 'https://ondo.finance/ondo-stocks',
  xstocks: 'https://xstocks.fi',
  venus: 'https://app.venus.io',
  lista: 'https://lista.org/lending',
  bscscanToken: (a: string) => `https://bscscan.com/token/${a}`,
  bscscanAddress: (a: string) => `https://bscscan.com/address/${a}`,
  bscscanTx: (h: string) => `https://bscscan.com/tx/${h}`,
  bscscanBlock: (b: string | number | bigint) => `https://bscscan.com/block/${b}`,
};

export function parseExtraTokens(json: unknown): TokenInfo[] {
  if (!Array.isArray(json)) throw new Error('extra tokens file must be a JSON array');
  return json.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    for (const k of ['symbol', 'ticker', 'issuer', 'address'] as const) {
      if (typeof r[k] !== 'string') throw new Error(`extra token #${i}: missing string field "${k}"`);
    }
    const issuer = r.issuer as Issuer;
    if (!['bStocks', 'Ondo', 'xStocks'].includes(issuer)) {
      throw new Error(`extra token #${i}: issuer must be bStocks, Ondo or xStocks`);
    }
    const model: ExpectedModel = issuer === 'Ondo' ? 'ondo' : issuer === 'xStocks' ? 'xstocks' : 'bep677';
    return t(
      r.symbol as string,
      r.ticker as string,
      typeof r.name === 'string' ? r.name : (r.ticker as string),
      issuer,
      r.address as string,
      model,
      { needsVerification: true, note: 'Added via SHADDAI_EXTRA_TOKENS.' },
    );
  });
}
