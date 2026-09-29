/**
 * JSON shapes returned by the API. bigint values travel as decimal strings;
 * fields ending in `Raw` are integer base units, the rest are human decimals.
 */
import type { Address, Hex } from 'viem';
import type { ChangeKind } from './units.js';
import type { Issuer } from './registry.js';

export type { ChangeKind };

export interface TokenRef {
  symbol: string;
  ticker: string;
  name: string;
  issuer: Issuer;
  address: Address;
  needsVerification?: boolean;
  note?: string;
  demoOnly?: boolean;
}

export type UnitKind = 'bep677' | 'ondo-svalue' | 'none';

export interface PendingMultiplier {
  multiplier: string;
  effectiveAt: number;
  kind: ChangeKind;
  splitLabel?: string;
  ratio: string;
}

export interface OndoInfo {
  status: 'ok' | 'not-configured' | 'unavailable';
  oracle: Address | null;
  sValue: string | null;
  paused: boolean | null;
  /** sValue / uiMultiplier when both exist. */
  driftVsUi: string | null;
}

export interface UnitModel {
  token: Address;
  kind: UnitKind;
  /** Shares per raw token, 18-decimal string ("1.0017"). Null when no multiplier was found. */
  multiplier: string | null;
  pending: PendingMultiplier | null;
  ondo: OndoInfo | null;
  onChainSymbol: string | null;
  symbolMismatch: boolean;
  decimals: number;
  supportsScaledUiInterface: boolean | null;
  notes: string[];
}

export interface Price {
  rawUsd: number;
  shareUsd: number | null;
  source: 'dexscreener' | 'fixture';
  dex?: string;
  pair?: Address;
  liquidityUsd?: number;
  url?: string;
  thin?: boolean;
}

export type LocationKind = 'wallet' | 'venus' | 'lista' | 'lp';

export interface PortfolioRow {
  token: TokenRef;
  location: { kind: LocationKind; label: string; contract?: Address; url?: string };
  raw: string;
  shareEq: string;
  shareEqSource: 'balanceOfUI' | 'computed' | 'sValue' | 'raw';
  /** shareEq - raw, in share-equivalents. */
  drift: string;
  multiplier: string | null;
  price: Price | null;
  positionUsd: number | null;
  dust: boolean;
  /** Multiplier is exactly 1.0 and nothing is pending: "1 token = 1 share right now". */
  oneToOneNow: boolean;
}

export type EventStatus = 'effective' | 'pending' | 'overwritten';

export interface MultiplierEvent {
  id: string;
  token: TokenRef;
  kind: ChangeKind;
  splitLabel?: string;
  status: EventStatus;
  oldMultiplier: string;
  newMultiplier: string;
  ratio: string;
  scheduledAt: number;
  scheduledBlock: string;
  txHash: Hex;
  logIndex: number;
  effectiveAt: number;
  /** First block with timestamp >= effectiveAt; null while pending or unresolved. */
  effectiveBlock: string | null;
  eventLayout: 'bep677-3' | 'variant-4';
}

export type RawAtEventSource = 'archive' | 'replay' | 'assumed-current' | 'unavailable';

export interface LedgerRow extends MultiplierEvent {
  rawAtEvent: string | null;
  rawAtEventSource: RawAtEventSource;
  deltaShareEq: string | null;
  estUsd: number | null;
  usdBasis: 'current-mark' | 'none';
  notes: string[];
}

export type Severity = 'info' | 'watch' | 'alert';

export interface OracleCheck {
  /** Protocol oracle's USD price for one raw token. */
  oracleRawUsd: number | null;
  dexRawUsd: number | null;
  basis: 'raw' | 'share' | 'indistinguishable' | 'unknown';
  note: string;
}

export interface CollateralPosition {
  token: TokenRef;
  protocol: 'Venus' | 'Lista' | 'PancakeSwap V2';
  /** collateral / lend: the address owns these tokens inside the protocol. borrow: it owes them. */
  side: 'collateral' | 'lend' | 'borrow' | 'lp';
  market: { label: string; address?: Address; id?: Hex; url?: string };
  raw: string;
  shareEq: string;
  multiplier: string | null;
  enteredAsCollateral: boolean | null;
  hasBorrow: boolean | null;
  severity: Severity;
  reasons: string[];
  lines: string[];
  oracle: OracleCheck | null;
}

export interface CollateralListing {
  token: TokenRef;
  protocol: 'Venus' | 'Lista';
  severity: 'info';
  lines: string[];
}

export interface CheckStatus {
  name: string;
  status: 'ok' | 'partial' | 'unavailable' | 'skipped';
  detail: string;
}

export interface LedgerSection {
  status: 'ready' | 'indexing' | 'unavailable';
  rows: LedgerRow[];
  progress?: number;
  error?: string;
  scannedFrom?: string;
  scannedTo?: string;
}

export interface ScanResult {
  mode: 'live' | 'demo';
  address: Address;
  block: string;
  blockTime: number;
  generatedAt: number;
  tokens: TokenRef[];
  units: Record<string, UnitModel>;
  portfolio: { rows: PortfolioRow[]; totalUsd: number; pricedRows: number };
  ledger: LedgerSection;
  collateral: { positions: CollateralPosition[]; listings: CollateralListing[] };
  checks: CheckStatus[];
  warnings: string[];
}

export interface FeedResult {
  mode: 'live' | 'demo';
  status: 'ready' | 'indexing' | 'unavailable';
  progress?: number;
  error?: string;
  events: MultiplierEvent[];
  scannedFrom?: string;
  scannedTo?: string;
  units: Record<string, UnitModel>;
}
