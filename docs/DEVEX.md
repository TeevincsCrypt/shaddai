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

What we had to build to find the oracle: an address-less `eth_getLogs` over recent blocks for any event whose first or
second indexed topic is an Ondo token address, newest blocks first, then `getSValue(asset)` on every contract seen for
two or more Ondo tokens. A contract is adopted only if it answers with a plausible 1e18-scaled value for most of the
nine assets. This runs once per deploy. Address-less log queries are the expensive kind on most providers, which is why
it is bounded to about ten days of blocks and a 90-second budget.

## 12. Lista's market list is long and loosely typed

Moolah is Morpho-Blue style: positions are keyed by a `bytes32` market id, so you cannot ask "does this address have
NVDAB collateral?" without first knowing every NVDAB market id. The public API (`/api/moolah/borrow/markets`) returns a
`collateral` field that is a display string, not a typed address. Shaddai uses the API only to propose candidate ids,
then confirms each with `idToMarketParams(id).collateralToken` before reading `position(id, user)`.

**Observed on mainnet:** NVDAB is not only collateral on Lista. BscScan's list of NVDAB transfers through Moolah shows
`Borrow` transactions paying NVDAB out and `Supply` transactions paying it in, so there are markets where NVDAB is the
loan asset. A reader that only checks `collateral` misses lenders and borrowers. Shaddai now matches markets on either
side and reads all three `position()` fields: `collateral`, and `supplyShares` / `borrowShares` converted to tokens
with Morpho's share math (virtual shares 1e6, virtual assets 1, rounding down for supply and up for debt). Borrowers
get their own warning: every multiplier increase raises the value of each raw token owed, so the borrower pays the
reinvested dividend.

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

## 16. Exposing the reads to agents (MCP)

- Tool names: the brief used `sharetrue.portfolio`. Some clients (the Claude API among them) reject dots in tool names,
  so the tools are `sharetrue_portfolio` etc., with the dotted name as the title.
- `@modelcontextprotocol/sdk` 1.31.0, stateless Streamable HTTP with JSON replies: a POST whose `Accept` header is
  missing or only `application/json` gets HTTP 406, "Client must accept both application/json and text/event-stream".
  A plain `curl` needs `-H 'accept: application/json, text/event-stream'`. Checked in this repo's test harness.
- Without a session, `tools/call` works with no `initialize` first, so each Vercel invocation can stand alone.

## 17. Binance Web3 API, read from the official connector (not yet from live traffic)

Source: `binance/binance-web3-connector-python` (commit `5f6256f`, 18 Sep 2026) and `@binance-web3/wallet` 12.3.1 on
npm. The API docs host (`web3.binance.com`) was not reachable from the build sandbox, so everything here comes from the
connectors' code and generated types. Nothing in this section has been checked against a live response yet.

- Signing: `X-OC-SIGN = base64(HMAC-SHA256(secret, isoTimestamp + METHOD + path?query + body))`. The path includes
  the `/build` base path. Headers: `X-OC-APIKEY`, `X-OC-TIMESTAMP`, `X-OC-SIGN`.
- Equity tokens always quote as RFQ: "Equity / RWA tokens always return `RFQ`" (bStocks and Ondo are named). The
  buyer signs `rfq.typedDataToSign` (EIP-712), submits it to `POST /order/submit`, and polls `GET /order/{orderId}`.
  `/quote` wants `userWalletAddress` for RFQ routes, so an anonymous comparison needs some address.
- The USDT approval for an RFQ buy goes to a vendor-specific spender (1inch router, Permit2 for PancakeSwap X, or
  CowSwap's VaultRelayer). `/approve-transaction` resolves it from `vendor`.
- `data()` in the npm connector returns only the envelope's `data` field. A business error arrives as HTTP 200 with a
  non-zero `code` (for example 40401 `QUOTE_EXPIRED`), and the connector turns it into `null` with the message lost.
  Checked in this repo's tests. Shaddai signs its own requests to keep `code` and `msg`, and a parity test checks it
  sends the same method, path, query and body as the connector.
- The npm connector's `simulateTransactions` throws "Required parameter solTx was null" for an EVM-only request. Its
  own docs say to send exactly one of `evmTx`, `solTx` or `tronTx`.
- The npm connector's `getRfqOrderStatus` sends a GET with a JSON body.
- Docs inconsistency: `POST /order/submit` describes `quoteId` as "`rfq.orderId` from the `/swap` response", but the
  `/swap` RFQ schema has no `orderId`. Shaddai sends `rfq.orderId` if it is present, otherwise the `/quote` quoteId.
- `typedDataToSign` is described as "serialized as a hex string (or JSON-encoded string)". Shaddai accepts either.
- The RWA token list has `tokenToShareRatio` ("1 token ≈ 1.003701 underlying shares") and a status with market hours
  and halt reasons (`ASSET_PAUSED` with `stock_split`, `cash_dividend`, …). Shaddai shows the ratio next to the on-chain
  factor and uses the chain.
- DeFi Data `POST /api/v1/defi/data/position/list` takes up to 3 addresses and, "this release", BSC only. It nests
  address → protocol → pool → position collection → position → supply/borrow tokens, with a lending health factor
  on the collection. `tokenAmount` is documented only as "human-readable (NOT the smallest unit)". Whether a bStock
  amount is raw or share-equivalent is not stated, so Shaddai compares it with both figures read on chain.
- USD1's BSC address does not appear in either connector, so Shaddai does not hard-code it. It resolves USD1 through
  token search and checks `symbol()` on chain.

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
- First live statement, the Venus vNVDAB market (`0xEb8C…D371`) as holder: 1,490.553133 NVDAB raw ×
  1.000778223752807865 = 1,491.713117 share-equivalents, matching the contract's own `balanceOfUI()`. DexScreener marked
  $229.61 per raw token, $229.43 per share.
- Its ledger row for NVDAB's 10 Sep dividend: 666.027858 NVDAB held at block 120,970,450 (the block before
  activation), read by historical `eth_call` on NodeReal (archive state served), giving +0.5183187 share-equivalents,
  about $118.92 at the current mark. No Transfer event exists for it.
- Venus: `getAllMarkets()` returned 55 Core Pool markets; `underlying()` matched three registry tokens, TSLAB, NVDAB and
  SPCXB. The brief listed two vTokens; the third came from discovery.
- Lista: for a real borrower, the Lista API proposed five markets; `idToMarketParams()` confirmed all five on Moolah and
  `position()` returned collateral of 50.00 and 199.9552 GOOGLB, 130.0605 MSFTB, and 659.8663 and 240.00 NVDAB, each
  with an open borrow. Share-equivalents follow from each token's multiplier (for example 199.9552 GOOGLB is 200.0508
  shares).
- Ondo: deploy-time discovery found the SyntheticSharesOracle at `0xF4Fd8a1B412633e10527454137A29Db7Aa35F15e` from its
  events, not from the four web-search hits (none of which answered `getSValue` for a majority of the Ondo tokens). `getSValue(address) → (uint128, bool)` returned a
  plausible 1e18-scaled value for all nine Ondo tokens, which also confirms the function name the audit only implied.
- The difference between those two figures is the point of the ledger: today's raw-to-share gap (1.16) is not the
  dividend this holder earned (0.518), because tokens deposited after the event already carried the multiplier.

## Verified against the reference contract

Mainnet has had no split, overwrite or cancellation yet, so `npm run verify:evm` runs those cases on the real code:
`ERC8056TokenUpgradeable` from bnb-chain/bep-677-contracts (commit `ff17399`, vendored with its MIT licence), compiled
with solc 0.8.24, deployed behind `UpgradeableBeacon` + `BeaconProxy` on an in-process Hardhat EVM. The script drives a
dividend using NVDAB's real multiplier and notice period, a schedule that is overwritten and brought forward, a
2-for-1 split and a change left pending, with transfers in between. All 18 checks pass:

- Timeline: initialisation, dividend, overwritten, dividend, split (2-for-1), pending, in that order.
- The contract emitted `UIMultiplierChangeOverwritten` exactly once, and the overwriting `UIMultiplierUpdated` carries
  the pre-overwrite multiplier as `oldMultiplier`.
- For every effective change, the contract's own `uiMultiplier()` returns the old value at Shaddai's activation block
  minus one and the new value at the activation block.
- Share-equivalents equal `balanceOfUI()`; the pending change matches `newUIMultiplier()` and `effectiveAt()`.
- Ledger balances before each activation are 100, 70 and 80 as scripted, with archive reads and again through Transfer
  replay on a simulated pruned node. The split row has no USD credit.

## Still to measure

- The actual `sValue` per Ondo asset over time, to compare with the matching bStock multipliers (both reinvest the same
  dividends, net of different withholding assumptions).
- Time to first `uiMultiplier()` from a cold start (`npm run probe` prints it).
- Which public endpoints serve `eth_getLogs`, their block-range limits and exact error text. This run used a private
  endpoint; `/api/status` records endpoint failures when public ones are in the list.
- Whether public (non-archive) endpoints push the ledger into Transfer replay, and how far replay gets on busy
  contracts before the `SHADDAI_MAX_REPLAY_LOGS` cap. NodeReal served the archive read. Each ledger row says which
  path it used.
- Pre-action preview, once a key is set: whether the DeFi API reports bStock amounts in raw or share units for Venus
  and Lista, and whether its health factor accounts for the multiplier.
- Buy, once a key is set: the first live `/quote` for an RFQ route (does it need the wallet, what is the minimum
  size), whether `priceImpactPercent` comes back for RFQ vendors, the real `typedDataToSign` shape per vendor, the
  `/order/submit` id question above, a Transaction API dry run of the approve, and then a small live buy end to end.
