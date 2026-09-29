# DevEx report: building a share-true reader for BSC tokenized stocks

What got in the way while building Shaddai, in the order we hit it. Each item says where the fact came from. The code was
written in a sandbox with no route to BSC, against the reference contracts; items marked **Measured on mainnet** come from
the first live run of the deployed app (Vercel + a NodeReal endpoint, 29 Sep 2026), summarised in
[Measured on mainnet](#measured-on-mainnet).

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

**Measured on mainnet:** all 15 multiplier events on the ten bStocks between 1 May and 29 Sep 2026 use the 3-word
layout (`0x2205df45…`). None used the 4-word signature.

## 3. The event fires when a change is scheduled, not when it happens

`_setUIMultiplier(new, effectiveAt)` emits immediately; `uiMultiplier()` switches only once
`block.timestamp >= effectiveAt`. A ledger that dates the change by the log's block is early by the whole notice period,
and computing "shares held at the event" at that block uses the wrong balance.

What we had to build: a binary search over block headers for the first block with `timestamp >= effectiveAt`, then a
balance read at the block before it. On BSC's sub-second blocks several blocks share one timestamp, so "first block at
or after" matters.

**Measured on mainnet:** bStocks schedule each change only **5 to 12 minutes** ahead (290 s for NVDAB's September
dividend, 709 s for MSFTB's and MUB's), and every change so far took effect at exactly **00:00 UTC**. The NVDAB change
was logged in block 120,969,809 and activated in block 120,970,451, 642 blocks later. A "pending" state is therefore
visible for minutes, not days: a UI or risk system that polls hourly will never see one.

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
returns false). A bad checksum usually means hand-editing, so we kept the hex digits
(`0x75Fd4cF6f8392E41E70391D60c90C0D5211603a1`) and flagged the entry until `symbol()` could confirm it.

**Measured on mainnet:** `symbol()` returns `AMDB` and the contract answers `uiMultiplier()`; only the casing was wrong.
All 19 registry addresses returned the expected `symbol()`.

## 11. Ondo keeps the economics off the token

For Ondo Global Markets the multiplier is `sValue` in the SyntheticSharesOracle. The Cantina review of the oracle
describes the internal read path `_getSValue(address asset) → (uint128 sValue, bool paused)`; Shaddai calls a public
`getSValue(address)` with that shape, which is an assumption to confirm against the deployed oracle. The oracle's BSC
address is not listed alongside the token addresses, so it has to be found and configured separately
(`ONDO_SSO_ADDRESS`). The `paused` flag is part of the answer: during a corporate action the value is frozen on purpose,
and a reader that ignores the flag reports a stale number as current.

**Measured on mainnet:** none of the nine Ondo tokens on BSC implements `uiMultiplier()` or reports the ERC-8056
interface (`supportsInterface(0xa60bf13d)` is false). So even a Scaled-UI-aware wallet has nothing to scale on an Ondo
BSC token: the share drift exists only in the oracle.

## 12. Lista's market list is long and loosely typed

Moolah is Morpho-Blue style: positions are keyed by a `bytes32` market id, so you cannot ask "does this address have
NVDAB collateral?" without first knowing every NVDAB market id. The public API (`/api/moolah/borrow/markets`) returns a
`collateral` field that is a display string, not a typed address. Shaddai uses the API only to propose candidate ids,
then confirms each with `idToMarketParams(id).collateralToken` before reading `position(id, user)`.

## 13. Money-market oracles cannot be checked until the multiplier moves

Venus's `getUnderlyingPrice(vToken)` returns USD × 1e(36 − underlying decimals) per raw unit. Whether that is a
per-raw-token or per-share price is invisible while the multiplier stays near 1: NVDAB's is 1.000778 after its September
dividend (measured on mainnet), so the two prices differ by 0.08%, well inside normal DEX/oracle spread. Shaddai reports
"cannot tell yet" under 0.5% and only calls a basis once the gap is readable.

## 14. DEX marks are per raw token

Pools trade raw tokens, so DexScreener's `priceUsd` is per raw token. Price pages that show that number next to
"shares" overstate the per-share price by the multiplier and then double-count the dividend if the share count is also
scaled. The fix is `per-share = rawPrice / multiplier`, applied once.

## 15. Tax exports see nothing

A multiplier change emits no `Transfer`. Any exporter built on transfer history records no income event and no basis
change. The ledger CSV (`date, block, issuer, symbol, contract, raw_at_event, old_mult, new_mult, delta_share_eq,
est_usd, note`) is meant to sit next to a wallet export.

## Measured on mainnet

First live run of the deployed app: Vercel, one NodeReal BSC endpoint, index built during the Vercel build from
block 95,646,252 (1 May 2026) to 124,755,901 (29 Sep 2026).

Deployments (`UIMultiplierUpdated(0, 1e18, …)`, the initialisation event):

| Date (UTC)  | Tokens                                 | Blocks                  |
| ----------- | -------------------------------------- | ----------------------- |
| 5 Jun 2026  | TSLAB, CRCLB, MUB, SNDKB, NVDAB, SPCXB | 102,441,229–102,441,286 |
| 16 Jun 2026 | AMDB                                   | 104,490,032             |
| 24 Jun 2026 | MSFTB                                  | 106,007,911             |
| 1 Jul 2026  | GOOGLB                                 | 107,364,673             |
| 22 Jul 2026 | AAPLB                                  | 111,389,642             |

Dividend reinvestments (all took effect at 00:00 UTC):

| Effective   | Token  | Activation block | Multiplier after     | Notice before activation |
| ----------- | ------ | ---------------- | -------------------- | ------------------------ |
| 6 Jul 2026  | MUB    | 108,304,816      | 1.000107512568805603 | 709 s                    |
| 10 Aug 2026 | AAPLB  | 115,021,055      | 1.000603906075632366 | 649 s                    |
| 20 Aug 2026 | MSFTB  | 116,940,447      | 1.001313964833366845 | 709 s                    |
| 4 Sep 2026  | GOOGLB | 119,818,926      | 1.000478058978107511 | 588 s                    |
| 10 Sep 2026 | NVDAB  | 120,970,451      | 1.000778223752807865 | 290 s                    |

- 15 events in total: 10 deployments and 5 dividends, all in the 3-word BEP-677 layout. No splits, overwrites or
  cancellations yet.
- AAPLB's August dividend is the ~1.000604× reported publicly.
- BSC averaged about 0.45 s per block over the period (25.3M blocks in 132 days).
- The first registry event is at block 102,441,229, so `SHADDAI_SCAN_FROM_BLOCK=102441000` skips about 6.8M empty
  blocks when only bStocks and Ondo tokens are tracked.
- The deploy-time snapshot built inside Vercel's build step and shipped with the function; the cold function answered
  `/api/status` from it with zero RPC calls.

## Still to measure

- Time to first `uiMultiplier()` from a cold start (`npm run probe` prints it).
- Which public endpoints serve `eth_getLogs`, their block-range limits and exact error text. This run used a private
  endpoint; `/api/status` records endpoint failures when public ones are in the list.
- Whether the ledger's historical `balanceOf` read is served (archive) or falls back to Transfer replay on a given
  endpoint. Each ledger row says which one it used.
