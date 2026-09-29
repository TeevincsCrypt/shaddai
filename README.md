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

## Deploy on Vercel

The repo deploys as-is: `vercel.json` builds the web app as static files, runs the API as one Node function
(`api/index.ts`, the same Hono app as `npm start`), and routes `/api/*` to it.

1. On [vercel.com/new](https://vercel.com/new), import the GitHub repo. Leave the framework preset alone; `vercel.json`
   sets the build command and output directory.
2. Add environment variables ([next section](#environment-variables)) under **Settings → Environment Variables**, for
   Production and Preview.
3. Deploy. Vercel deploys Production from the default branch, so merge to `main` first; other branches get Preview URLs.
4. Check `https://<your-app>/api/status` (mode, RPC health, index progress), then `https://<your-app>/?a=demo`.

Environment variables apply only to new deployments. After adding or changing one, redeploy (Deployments → ⋯ → Redeploy).

**What is different on Vercel.** Functions are short-lived and their disk is read-only except `/tmp`, so:

- The build runs `npm run index:snapshot`, which indexes every multiplier event up to the build's block and ships it with
  the function. A cold function reads that snapshot and fetches only newer blocks. If RPC is unreachable during the build,
  the step logs why and the function indexes at runtime instead; the build does not fail.
- Runtime cache goes to `/tmp/shaddai-cache` (per instance, not shared).
- When a ledger takes longer than the request budget, the page shows "indexing" and polls; the unfinished work keeps
  running through Vercel's `waitUntil`, up to the function's 60 s limit (`maxDuration` in `vercel.json`).

## Environment variables

None are required. With nothing set, Shaddai uses public BSC RPC, DexScreener and the public Lista API. On Vercel, set at
least `BSC_RPC_URLS`: public endpoints rate-limit shared cloud IPs.

**Where to enter them.** Vercel: your project → **Settings → Environment Variables**
([guide](https://vercel.com/docs/environment-variables/managing-environment-variables)), or from a terminal with
[`vercel env add`](https://vercel.com/docs/cli/env). Locally: copy [`.env.example`](.env.example) to `.env`.

### `BSC_RPC_URLS` (recommended)

A private BNB Smart Chain mainnet endpoint. Pick one provider, sign up, create a **BSC mainnet** endpoint or API key, and
copy the HTTPS URL:

- NodeReal MegaNode (free tier, sign in with GitHub or Discord): [nodereal.io/meganode](https://nodereal.io/meganode)
  · [getting started](https://docs.nodereal.io/docs/getting-started)
- QuickNode (free account, archive on BSC): [quicknode.com/chains/bsc](https://www.quicknode.com/chains/bsc)
- Ankr (free account; keyless public access was retired, so you need a key): [ankr.com/rpc/bsc](https://www.ankr.com/rpc/bsc/)
- BNB Chain's list of public and provider endpoints:
  [docs.bnbchain.org JSON-RPC endpoints](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/)

Put yours first and a public one after it as fallback:
`https://<your-endpoint>,https://bsc-rpc.publicnode.com`. A plan with archive data makes the ledger's `raw_at_event` an
exact historical read instead of a log replay.

### `SHADDAI_SCAN_FROM_BLOCK` (optional)

The block just before the first bStock was deployed. Open a token's BscScan page, find **Contract Creator** in the
overview, click its transaction, and copy the **Block** number. Use the smallest one:

[NVDAB](https://bscscan.com/address/0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436) · [TSLAB](https://bscscan.com/address/0x5b1910eAaD6450E50f816082Aa078C41F10C292f) · [SPCXB](https://bscscan.com/address/0xbe9D156892E55e7154BcD3cB0FEA677F9D3103E1) · [AAPLB](https://bscscan.com/address/0x431a3BEE82E2ca41e49895CbECE5bB0F76A89b7A) · [GOOGLB](https://bscscan.com/address/0x3F53De71c126BdaBAe20f9cD64848d317f6C3238) · [MSFTB](https://bscscan.com/address/0x80106cb3EAD06659A5ad19DF39D9b4733863B9b0) · [CRCLB](https://bscscan.com/address/0x80f3D493EBCe97e343c53D29a137942416B4ffC0) · [AMDB](https://bscscan.com/address/0x75Fd4cF6f8392E41E70391D60c90C0D5211603a1) · [MUB](https://bscscan.com/address/0xcdf2f3e0fa43C47A6662a91C9E4a7C5f69762699) · [SNDKB](https://bscscan.com/address/0x3eE4dF61bd4F867E349BEaE8bFE07bc31b4850fb)

Unset, the index starts at `SHADDAI_SCAN_FROM_DATE` (default `2026-05-01`), which only makes the first scan longer.

### `ONDO_SSO_ADDRESS` (optional, not published yet)

The BSC address of Ondo's SyntheticSharesOracle, which holds `sValue`. It is not listed next to the token addresses.
Look in [Ondo's contract address page](https://docs.ondo.finance/addresses); background on `sValue` is in
[Chainlink's Ondo feed docs](https://docs.chain.link/data-feeds/tokenized-equity-feeds/ondo). Unset, Ondo rows show 1 token
= 1 share and say so. After setting it, `npm run probe` should list Ondo tokens as `ondo-svalue`.

### `SHADDAI_EXTRA_TOKENS` (optional)

Tokens missing from the built-in registry, such as xStocks. BSC contract addresses come from the xStocks Assets API:
[developer docs](https://docs.xstocks.fi/developers) · [API reference](https://docs.xstocks.fi/apis/openapi). Confirm each
on [BscScan](https://bscscan.com) before adding it. Inline JSON works in the Vercel dashboard:

```json
[{ "symbol": "NVDAx", "ticker": "NVDA", "issuer": "xStocks", "address": "0x…" }]
```

Locally it can also be a path to a JSON file.

### `LISTA_MARKET_IDS` (optional, usually unnecessary)

Markets are found through the Lista API. To pin one, open it on [lista.org/lending](https://lista.org/lending); the URL
ends in its 66-character `0x…` id (for example `lista.org/lending/market/bsc/0x2bb6…c5ec`). Comma-separate several.

### Tuning and local-only variables

| Variable                     | Default            | Notes                                                                                            |
| ---------------------------- | ------------------ | ------------------------------------------------------------------------------------------------ |
| `BSC_LOGS_RPC_URLS`          | `BSC_RPC_URLS`     | Only if your main endpoint refuses `eth_getLogs` (the scan's "Multiplier events" check says so). |
| `SHADDAI_SCAN_FROM_DATE`     | `2026-05-01`       | Used when no start block is set.                                                                 |
| `SHADDAI_LOG_CHUNK`          | `50000`            | Starting `eth_getLogs` window; halves on range errors.                                           |
| `SHADDAI_MAX_REPLAY_LOGS`    | `20000`            | Above it, the ledger uses the current balance and says so.                                       |
| `SHADDAI_SNAPSHOT_BUDGET_MS` | `240000`           | Time the deploy-time index snapshot may take.                                                    |
| `SHADDAI_MODE`               | `live`             | `demo` serves every address from the fixture chain.                                              |
| `PORT`                       | `8787`             | Local only.                                                                                      |
| `SHADDAI_CACHE_DIR`          | `.cache`           | `/tmp/shaddai-cache` on Vercel, set automatically.                                               |
| `SHADDAI_SEED_DIR`           | `dist/index-cache` | Where the deploy-time snapshot is written and read.                                              |

Locally, load `.env` before starting, for example `set -a; source .env; set +a; npm start`.

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
src/server/     Hono app, config, local entrypoint, deploy-time index snapshot
api/index.ts    Vercel function wrapping the same Hono app
web/            React statement UI (Vite)
test/           vitest suites (units, events/timeline, replay, end-to-end demo scan, API)
docs/DEVEX.md   developer-experience report
```

`npm run check` runs the typecheck, Prettier and the test suite.

## Not advice

bStocks, Ondo and xStocks tokens are not the listed share and carry no voting rights. Estimates assume published
multipliers and typical withholding. Not tax, legal or investment advice. US persons are excluded from several of these
products; Shaddai does not check eligibility.
