# DevEx report: building a share-true reader for BSC tokenized stocks

What got in the way while building Shaddai, in the order we hit it. Each item says where the fact came from. Nothing here
is a live mainnet measurement unless it says so. This build was written in a sandbox with no route to BSC RPC,
DexScreener or the Lista API, so the numbers in [Still to measure](#still-to-measure) are open.

## 1. `balanceOf()` is correct and still misleading

BEP-677 keeps ERC-20 semantics: `balanceOf` is the raw amount, transfers move raw amounts, and the UI amount is
`raw × uiMultiplier / 1e18`. Every surface that stops at `balanceOf` (wallet token lists, DeFi UIs, tax exporters) shows
a holding that did not change after a dividend. This is working as designed, which is why nobody files a bug for it.

**Cost to an integrator:** every read path needs a second call (`uiMultiplier()` or `balanceOfUI()`) and every price
needs a unit (per raw token or per share).

## 2. The event layout people describe is not the one the reference contract emits

- The product brief and several write-ups describe
  `UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 setAtTimestamp, uint256 effectiveAtTimestamp)`.
- `bnb-chain/bep-677-contracts` (`IScaledUIAmount.sol`) emits
  `UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)`: three words, none
  indexed.

The two signatures hash to different topic0 values, so a decoder built from the four-field description sees no events at
all, with no error:

| Signature                                                        | topic0                                                               |
| ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `UIMultiplierUpdated(uint256,uint256,uint256)`                   | `0x2205df4534432b2f60654a3fdb48737ffdaf3e9edb1a498bd985bc026b15b055` |
| `UIMultiplierUpdated(uint256,uint256,uint256,uint256)`           | `0x69cf817424dab3ffd3ee33ea83c0597f81c3f5a1e71a9007b18a99c8eee952d6` |
| `UIMultiplierChangeOverwritten(uint256,uint256,uint256,uint256)` | `0x62204eb4daab41a604e7262a5dca11bd936210002ddfaa885fad182b677ff92c` |
| `UIMultiplierUpdateCancelled(uint256,uint256)` (ERC-8056 only)   | `0x883856335ba5f60c18b9817c4505d3c7d3f6223dcf39516b30c508c46a5e1cad` |

Shaddai subscribes to all four. Because nothing is indexed, you cannot filter by multiplier or time in `eth_getLogs`;
you filter by contract address and topic0 and decode everything.

## 3. The event fires when a change is scheduled, not when it happens

`_setUIMultiplier(new, effectiveAt)` emits immediately; `uiMultiplier()` switches only once
`block.timestamp >= effectiveAt`. A ledger that dates the change by the log's block is early by the whole notice period,
and computing "shares held at the event" at that block uses the wrong balance.

What we had to build: a binary search over block headers for the first block with `timestamp >= effectiveAt`, then a
balance read at the block before it. On BSC's sub-second blocks several blocks share one timestamp, so "first block at
or after" matters.

## 4. "Is something pending?" has a trap

`newUIMultiplier()` returns the _current_ multiplier when nothing is scheduled, and `effectiveAt()` returns `0`. So
`newUIMultiplier() != uiMultiplier()` misses a scheduled change to the same value and, more importantly, is not the
documented test. The documented test is `effectiveAt() > block.timestamp`. The BSC-only `hasPendingMultiplier()` /
`pendingMultiplier()` make this explicit but are not part of ERC-8056, so a cross-chain reader cannot rely on them.

## 5. Schedules can be overwritten, and shortened

The reference contract lets the owner overwrite a pending change, including with an earlier `effectiveAt` ("MAY shorten
the previously announced window to as little as the next block"). It emits `UIMultiplierChangeOverwritten` and then a
fresh `UIMultiplierUpdated` whose `oldMultiplier` is the value _before_ the overwritten schedule. ERC-8056 also defines
`UIMultiplierUpdateCancelled`, which the BEP-677 reference does not emit.

A ledger that treats every `UIMultiplierUpdated` as a corporate action double-counts. Shaddai marks a schedule
overwritten when a later update for the same token lands before its `effectiveAt`, or an overwrite or cancel event names
it. The demo includes this case (MSFTB).

## 6. The initialisation event looks like an infinite dividend

`__erc8056Base_init_unchained` emits `UIMultiplierUpdated(0, 1e18, block.timestamp)`. `new / old` divides by zero. Any
"percent change" column needs an `old == 0 → init` rule before it does arithmetic.

## 7. Interface id equals the function selector

`IScaledUIAmount` has one function, so its ERC-165 id `0xa60bf13d` is also the selector of `uiMultiplier()`. Harmless,
but it confuses anyone grepping calldata for the interface id. We probe `uiMultiplier()` directly and treat
`supportsInterface` as a second opinion.

## 8. Overflow handling is asymmetric

`balanceOfUI()` and `totalSupplyUI()` revert when `raw × multiplier` overflows; `TransferWithUIAmount` emits
`uiAmount = 0` for the same case, and also for a real zero and for truncation. An indexer that trusts
`TransferWithUIAmount.uiAmount` can record zero-value transfers that were not zero. We read `Transfer` for balance
history and never use `uiAmount` for accounting.

## 9. BeaconProxy: call the token, not the implementation

bStocks are `BeaconProxy` instances. Verified source on an explorer can point you at the implementation, whose storage
is empty. Every read must go to the token address. Shaddai's registry holds token addresses only and checks `symbol()`
on each scan.

## 10. One address in the source list failed its checksum

The brief's AMDB address, `0x75Fd4cF6f8392e41E70391d60C90c0d5211603a1`, is not valid EIP-55 (viem `isAddress(…, {strict:true})`
returns false). The hex digits are kept (checksummed form `0x75Fd4cF6f8392E41E70391D60c90C0D5211603a1`) and the entry
is flagged until `symbol()` returns `AMDB`. A bad checksum usually means hand-editing, so the digits deserve a second
look too.

## 11. Ondo keeps the economics off the token

For Ondo Global Markets the multiplier is `sValue` in the SyntheticSharesOracle. The Cantina review of the oracle
describes the internal read path `_getSValue(address asset) → (uint128 sValue, bool paused)`; Shaddai calls a public
`getSValue(address)` with that shape, which is an assumption to confirm against the deployed oracle. The oracle's BSC
address is not listed alongside the token addresses, so it has to be found and configured separately
(`ONDO_SSO_ADDRESS`). The `paused` flag is part of the answer: during a corporate action the value is frozen on purpose,
and a reader that ignores the flag reports a stale number as current.

## 12. Lista's market list is long and loosely typed

Moolah is Morpho-Blue style: positions are keyed by a `bytes32` market id, so you cannot ask "does this address have
NVDAB collateral?" without first knowing every NVDAB market id. The public API (`/api/moolah/borrow/markets`) returns a
`collateral` field that is a display string, not a typed address. Shaddai uses the API only to propose candidate ids,
then confirms each with `idToMarketParams(id).collateralToken` before reading `position(id, user)`.

## 13. Money-market oracles cannot be checked until the multiplier moves

Venus's `getUnderlyingPrice(vToken)` returns USD × 1e(36 − underlying decimals) per raw unit. Whether that is a
per-raw-token or per-share price is invisible while the multiplier is 1.0017: the two differ by 0.17%, inside normal
DEX/oracle spread. Shaddai reports "cannot tell yet" under 0.5% and only calls a basis once the gap is readable.

## 14. DEX marks are per raw token

Pools trade raw tokens, so DexScreener's `priceUsd` is per raw token. Price pages that show that number next to
"shares" overstate the per-share price by the multiplier and then double-count the dividend if the share count is also
scaled. The fix is `per-share = rawPrice / multiplier`, applied once.

## 15. Tax exports see nothing

A multiplier change emits no `Transfer`. Any exporter built on transfer history records no income event and no basis
change. The ledger CSV (`date, block, issuer, symbol, contract, raw_at_event, old_mult, new_mult, delta_share_eq,
est_usd, note`) is meant to sit next to a wallet export.

## Still to measure

These need a mainnet run (`npm run probe`, then `npm run probe -- <holder>`), which this build environment could not do:

- Time to first `uiMultiplier()` from a cold start on public RPC.
- Which public endpoints serve `eth_getLogs`, their block-range limits and the exact error text (the adaptive scanner
  halves the window on any range-style error; `/api/status` records endpoint failures).
- Whether public endpoints keep enough state for the historical `balanceOf` read, or whether the ledger falls back to
  Transfer replay.
- Whether deployed bStocks emit the 3-word or 4-word `UIMultiplierUpdated` (the feed shows the layout per event).
