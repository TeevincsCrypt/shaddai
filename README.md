# Shaddai

Share-true accounting for tokenized stocks on BSC. Wallets count tokens; issuers pay you in multipliers. Shaddai is the
statement in the middle.

Paste a BSC address and Shaddai returns three things:

1. **Share-true portfolio.** Every known bStock / Ondo token on the address, as raw tokens _and_ share-equivalents,
   including what sits inside Venus, Lista or a V2 pool.
2. **Corporate-action ledger.** Every multiplier change that touched those holdings: old → new multiplier, raw held at
   the block before activation, implied Δ share-equivalents, estimated USD. Exports to CSV.
3. **Collateral warning.** If the tokens are supplied to Venus, posted on Lista, or sitting in an LP, a severity-graded
   warning that the protocol counts raw ERC-20 units, not `balanceOfUI`.

It does not swap, trade or sign anything. It reads.

## Run it

```bash
npm install
npm run build        # builds the web app into dist/web
npm start            # API + web app on http://localhost:8787
```

- **Demo, no network:** click _Open the demo_ on the landing page, or open `http://localhost:8787/?a=demo`. The demo runs
  on an in-process fixture chain (see [Demo fixture](#demo-fixture)).
- **Demo-only server:** `npm run demo` serves every address from the fixture chain.
- **Development:** `npm run dev` runs the API (port 8787) and Vite (port 5173, proxies `/api`).
- **Live smoke test from the terminal:** `npm run probe` prints every registry token's unit model and the
  time-to-first-`uiMultiplier()`. `npm run probe -- 0xAddress` prints a full statement.

Node 20+ is required. `.npmrc` sets `legacy-peer-deps` because npm 10's peer resolver crashes on this dependency set.

## Configuration

Everything is optional. With no configuration Shaddai uses public BSC RPC endpoints, DexScreener for marks and the
public Lista API for market discovery. See [`.env.example`](.env.example).

| Variable                            | Default                          | What it does                                                                                                                     |
| ----------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `BSC_RPC_URLS`                      | publicnode, bnbchain dataseed, … | Comma-separated JSON-RPC endpoints, tried in order with failover. An archive node makes `raw_at_event` exact without log replay. |
| `BSC_LOGS_RPC_URLS`                 | same as above                    | Separate endpoints for `eth_getLogs`.                                                                                            |
| `SHADDAI_SCAN_FROM_BLOCK` / `_DATE` | `2026-05-01`                     | Where the multiplier-event index starts. The block wins over the date.                                                           |
| `SHADDAI_LOG_CHUNK`                 | `50000`                          | Starting `eth_getLogs` window; halves automatically when a node rejects the range.                                               |
| `ONDO_SSO_ADDRESS`                  | unset                            | Ondo SyntheticSharesOracle on BSC. Unset = Ondo rows use a wallet multiplier if the token has one, else 1:1 and say so.          |
| `LISTA_MARKET_IDS`                  | unset                            | Extra Moolah market ids (bytes32) to check.                                                                                      |
| `SHADDAI_EXTRA_TOKENS`              | unset                            | JSON file of extra tokens, e.g. confirmed xStocks addresses: `[{"symbol","ticker","issuer","address","name"?}]`.                 |
| `SHADDAI_MODE`                      | `live`                           | `demo` serves every address from the fixture chain.                                                                              |
| `SHADDAI_MAX_REPLAY_LOGS`           | `20000`                          | Refuse to replay more Transfer logs than this for one token (busy contracts).                                                    |
| `PORT`                              | `8787`                           |                                                                                                                                  |

## How it reads the chain

**Unit model, per token, probed at scan time.** One Multicall3 batch reads `symbol`, `decimals`, `balanceOf`,
`balanceOfUI`, `uiMultiplier`, `newUIMultiplier`, `effectiveAt` and `supportsInterface(0xa60bf13d)` for every registry
token. A token is treated as BEP-677 because `uiMultiplier()` answers with a plausible 1e18-scaled value, not because the
registry says so. `symbol()` is compared against the registry and a mismatch is surfaced as a warning.

- Share-equivalents come from the contract's own `balanceOfUI()`; if it disagrees with `raw × uiMultiplier / 1e18`, the
  row says so.
- A change is pending when `effectiveAt() > block.timestamp`. `newUIMultiplier()` returns the current multiplier when
  nothing is scheduled, so it cannot tell you on its own.
- Ondo: `getSValue(asset) → (uint128 sValue, bool paused)` on the configured oracle. When the token also has a wallet
  multiplier, both are shown and a >0.1% disagreement is flagged.
- xStocks: read through BEP-677 when exposed. A Backed-style `multiplier()` getter is reported but never applied.

**Prices.** DexScreener's deepest pool gives a price per _raw_ token (pools trade raw tokens). The per-share mark is
`rawPrice / multiplier`, so the dividend is counted once. Position value is `raw × rawPrice`.

**Ledger.** A persistent index of `UIMultiplierUpdated` logs across the registry (both the 3-word BEP-677 layout and the
4-word variant), plus `UIMultiplierChangeOverwritten` / `UIMultiplierUpdateCancelled`. Each event is placed on a
timeline: _effective_, _pending_, or _overwritten_ (a later schedule landed before it took effect). The activation block
is found by binary search over block headers. `raw_at_event` is the holder's balance at the end of the block before
activation, read with a historical `eth_call` when the node keeps state, else reconstructed by replaying Transfer logs
backwards from the current balance, else the current balance with a note. Kinds: under 1% is `dividend-reinvest` (or
`adjustment-down`), a clean ratio is `split` / `reverse-split` with an `N-for-M` label, anything else is
`large-adjustment`. Splits get no USD credit.

**Collateral.**

- Venus Core Pool: markets from `getAllMarkets()` + `underlying()` (the two vTokens in the brief are hardcoded as a
  fallback), `balanceOf × exchangeRateStored`, `checkMembership`, and the Venus oracle's `getUnderlyingPrice`, which is
  compared with the DEX mark to tell a per-raw-token oracle from a per-share one once the multiplier is more than 0.5%
  from 1.
- Lista Lending (Moolah `0x8F73…5D8C`): candidate markets from the Lista API, each verified on-chain with
  `idToMarketParams()`, then `position(id, user)`. If the API is unreachable, wallet holdings of Lista-listed tickers get
  an info note instead.
- V2 LP positions in the pools DexScreener reports. V3 positions are not scanned.
- Severity: **info** (multiplier within 1% of 1, nothing scheduled), **watch** (a change is scheduled, or the Ondo oracle
  is paused), **alert** (multiplier more than 1% from 1, or a split-sized change scheduled).

## What is verified and what is not

- bStocks and Ondo addresses come from the product brief. The **AMDB address failed its EIP-55 checksum** in the source;
  its hex digits are kept and it is flagged `needsVerification` until `symbol()` confirms it.
- The multiplier event layout, the pending-change semantics and the overwrite event are taken from
  [bnb-chain/bep-677-contracts](https://github.com/bnb-chain/bep-677-contracts) (`ERC8056BaseUpgradeable`), not from
  live logs.
- The Lista Moolah address and read path are from [lista-dao/lending-sdk](https://github.com/lista-dao/lending-sdk).
- The Ondo oracle's BSC address is not published next to the token list; it must be configured.
- No xStocks BSC address is confirmed, so none is bundled.
- This build was developed in a sandbox with no route to BSC RPC, DexScreener or the Lista API. The live path has unit
  and integration coverage against the fixture chain, not a mainnet run. Run `npm run probe` before a demo.

## Demo fixture

`src/fixtures/fake-chain.ts` is a JSON-RPC emulator that answers `eth_call` (including Multicall3), `eth_getLogs` and
block headers from a scripted scenario. Its multiplier state machine mirrors `ERC8056BaseUpgradeable._setUIMultiplier`
exactly. The demo scenario (`src/fixtures/demo.ts`) holds NVDAB (wallet + Venus), AAPLB (wallet + V2 LP), MSFTB with a
scheduled-then-overwritten dividend, TSLAB at 1.0, NVDAon via sValue, GOOGLB dust, and **XMPLB, a fictional "Example
Corp"** that did a 2-for-1 split and is posted on Lista, which fires the alert. Every figure is illustrative. The UI and
the CSV label it as demo data.

## API

| Route                          | Returns                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `GET /api/scan?address=0x…`    | Portfolio, ledger, collateral, checks. `address=demo` for the fixture.                                   |
| `GET /api/ledger.csv?address=` | `date, block, issuer, symbol, contract, raw_at_event, old_mult, new_mult, delta_share_eq, est_usd, note` |
| `GET /api/feed`                | Global multiplier-event feed for the registry (`?demo=1` for the fixture).                               |
| `GET /api/status`              | Index progress, RPC endpoint health, request counters.                                                   |
| `GET /api/config`              | Mode, demo address, live example addresses.                                                              |

## Project layout

```
src/core/       chain reads, unit math, probing, ledger, collateral, CSV (no framework code)
src/fixtures/   fixture chain + demo scenario
src/server/     Hono app, config, entrypoint
web/            React statement UI (Vite)
test/           vitest suites (units, events/timeline, replay, end-to-end demo scan, API)
docs/DEVEX.md   developer-experience report
```

`npm run check` runs the typecheck, Prettier and the test suite.

## Not advice

bStocks, Ondo and xStocks tokens are not the listed share and carry no voting rights. Estimates assume published
multipliers and typical withholding. Not tax, legal or investment advice. US persons are excluded from several of these
products; Shaddai does not check eligibility.
