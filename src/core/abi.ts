import { parseAbi, toEventSelector } from 'viem';

/** ERC-20 surface every wallet reads. */
export const erc20Abi = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function totalSupply() view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);

/** Only used to check approve calldata an API hands back before a wallet sees it. */
export const approveAbi = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);

/**
 * BEP-677 / ERC-8056 Scaled UI Amount, as implemented in
 * bnb-chain/bep-677-contracts (ERC8056BaseUpgradeable).
 */
export const scaledUiAbi = parseAbi([
  'function uiMultiplier() view returns (uint256)',
  'function newUIMultiplier() view returns (uint256)',
  'function effectiveAt() view returns (uint256)',
  'function balanceOfUI(address) view returns (uint256)',
  'function totalSupplyUI() view returns (uint256)',
  'function toUIAmount(uint256) view returns (uint256)',
  'function fromUIAmount(uint256) view returns (uint256)',
  // BSC-only extension (IERC8056Scheduled).
  'function hasPendingMultiplier() view returns (bool)',
  'function pendingMultiplier() view returns (uint256 multiplier, uint256 effectiveAt)',
  'function supportsInterface(bytes4) view returns (bool)',
]);

/**
 * The reference implementation emits three non-indexed words. Some write-ups
 * (including the product brief) describe a four-word variant with a separate
 * setAt timestamp; both are decoded so a variant deployment is not missed.
 */
export const multiplierEventsAbi = parseAbi([
  'event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)',
  'event UIMultiplierChangeOverwritten(uint256 overwrittenMultiplier, uint256 overwrittenEffectiveAt, uint256 newMultiplier, uint256 newEffectiveAt)',
  'event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt)',
]);

export const multiplierEvent4Abi = parseAbi([
  'event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 setAtTimestamp, uint256 effectiveAtTimestamp)',
]);

export const TOPICS = {
  transfer: toEventSelector('event Transfer(address indexed from, address indexed to, uint256 value)'),
  multiplierUpdated3: toEventSelector(
    'event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)',
  ),
  multiplierUpdated4: toEventSelector(
    'event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 setAtTimestamp, uint256 effectiveAtTimestamp)',
  ),
  multiplierOverwritten: toEventSelector(
    'event UIMultiplierChangeOverwritten(uint256 overwrittenMultiplier, uint256 overwrittenEffectiveAt, uint256 newMultiplier, uint256 newEffectiveAt)',
  ),
  multiplierCancelled: toEventSelector(
    'event UIMultiplierUpdateCancelled(uint256 cancelledMultiplier, uint256 cancelledEffectiveAt)',
  ),
} as const;

/** ERC-165 interface id of IScaledUIAmount. */
export const SCALED_UI_INTERFACE_ID = '0xa60bf13d' as const;

/**
 * Ondo SyntheticSharesOracle read path. The Cantina review describes the internal
 * `_getSValue(address asset) -> (uint128 sValue, bool paused)`; the public
 * `getSValue` name is assumed and must be confirmed against the deployed oracle.
 * Its BSC address has to be configured (ONDO_SSO_ADDRESS): it is not published
 * alongside the token list.
 */
export const ondoOracleAbi = parseAbi(['function getSValue(address asset) view returns (uint128 sValue, bool paused)']);

/** Backed / xStocks-style getter, only reported, never applied (semantics unverified on BSC). */
export const backedAbi = parseAbi(['function multiplier() view returns (uint256)']);

export const venusComptrollerAbi = parseAbi([
  'function getAllMarkets() view returns (address[])',
  'function checkMembership(address account, address vToken) view returns (bool)',
  'function oracle() view returns (address)',
]);

export const vTokenAbi = parseAbi([
  'function underlying() view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function exchangeRateStored() view returns (uint256)',
  'function symbol() view returns (string)',
]);

export const venusOracleAbi = parseAbi(['function getUnderlyingPrice(address vToken) view returns (uint256)']);

export const moolahAbi = parseAbi([
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
]);

export const v2PairAbi = parseAbi([
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

export const multicall3Abi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
]);
