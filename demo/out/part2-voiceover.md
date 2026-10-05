# Part 2 · Walkthrough — voice-over

[0:01–0:05] Part 2: a live walkthrough of Shaddai, recorded on the demo fixture.
[0:07–0:13] Paste any BSC address. Shaddai reads the raw balances, then the multiplier your wallet ignores.
[0:14–0:21] The landing reads the live multiplier index: the latest changes, and what 100 tokens are in shares.
[0:25–0:34] The demo address: NVDAB in the wallet, in Venus and lent on Lista, plus AAPLB, MSFTB, NVDAon and more.
[0:39–0:44] Raw is what balanceOf() returns: 10.000000. The multiplier is 1.0017×.
[0:46–0:53] So the address owns 10.017 NVIDIA share-equivalents. Shaddai always shows both numbers.
[0:56–1:04] XMPLB, a fictional demo stock, split 2-for-1: 30 raw tokens on Lista are 60.24 shares.
[1:07–1:15] The ledger: every multiplier change, with no Transfer event behind any of them. Dividends, a split, one pending.
[1:18–1:24] “Did I get the dividend?” One plain answer: when, the raw it applied to, old → new, and shares gained.
[1:27–1:31] When nothing touched the holder, it says so. It never invents a dividend.
[1:33–1:41] Each row: raw held at the block before, old → new multiplier, Δ share-equivalents and an estimated USD value.
[1:46–1:57] Every NVIDIA wrapper, priced per share. NVDAB’s raw gap is +0.17%: that is the dividend factor. After the multiplier, 0.00%.
[1:59–2:11] NVDAon’s pool is thin, under $25k, so NVDAB is the tightest liquid wrapper. Outside US hours, rows say: quote, not a mispricing.
[2:16–2:20] Size the buy in dollars of stock: $50 of NVIDIA.
[2:24–2:33] The thin twin is refused before it is quoted: “NVDAon book is $14k, under the $25k floor.”
[2:35–2:40] NVDAB is quoted in share-equivalents and preselected: the most stock for the money.
[2:45–2:52] Step one is an exact-amount approve, decoded and dry-run before a wallet sees it. In the demo nothing is signed.
[2:58–3:05] Lista counts raw tokens, not shares. MSFTB is posted as collateral, with a multiplier change scheduled.
[3:08–3:16] Three numbers before the flip: the protocol holds 3 raw, 3.000000 shares today, 3.006060 after.
[3:18–3:24] Plus what a share-priced oracle would do to the collateral value. Confirm the oracle before you borrow.
[3:27–3:33] Nothing scheduled for NVDAB in Venus, so it says so, instead of showing a made-up preview.
[3:38–3:44] One click exports the ledger to CSV, the rows a tax tool reading only transfers would never see.
[3:45–3:52] Agents get the same answers as MCP tools. This is sharetrue.dividend, called on the running server.
[3:53–3:56] Your wallet counts tokens. Shaddai counts shares.
