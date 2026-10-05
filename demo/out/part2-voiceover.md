# Part 2 · Walkthrough — voice-over

[0:00–0:04] Part 2: a live walkthrough, recorded on the demo fixture.
[0:06–0:11] Paste any BSC address. Shaddai reads the raw balances, then the multiplier your wallet ignores.
[0:11–0:16] The landing reads the live multiplier index: the latest changes, and what 100 tokens are in shares.
[0:19–0:24] The demo address: NVDAB in the wallet, in Venus and lent on Lista, plus AAPLB, MSFTB, NVDAon and more.
[0:27–0:32] Raw is what balanceOf() returns: 10.000000. The multiplier is 1.0017×.
[0:33–0:37] So the address owns 10.017 NVIDIA share-equivalents. Shaddai always shows both numbers.
[0:39–0:44] XMPLB, a fictional demo stock, split 2-for-1: 30 raw tokens on Lista are 60.24 shares.
[0:47–0:52] The ledger: every multiplier change, with no Transfer event behind any of them. Dividends, a split, one pending.
[0:55–1:02] “Did I get the dividend?” One plain answer: when, the raw it applied to, old → new, and shares gained.
[1:03–1:08] When nothing touched the holder, it says so. It never invents a dividend.
[1:09–1:15] Each row: raw held at the block before, old → new multiplier, Δ share-equivalents and an estimated USD value.
[1:19–1:26] Every NVIDIA wrapper, priced per share. NVDAB’s raw gap is +0.17%: that is the dividend factor. After the multiplier, 0.00%.
[1:26–1:33] NVDAon’s pool is thin, under $25k, so NVDAB is the tightest liquid wrapper. Outside US hours, rows say: quote, not a mispricing.
[1:38–1:41] Size the buy in dollars of stock: $50 of NVIDIA.
[1:44–1:50] The thin twin is refused before it is quoted: “NVDAon book is $14k, under the $25k floor.”
[1:51–1:56] NVDAB is quoted in share-equivalents and preselected: the most stock for the money.
[2:01–2:07] Step one is an exact-amount approve, decoded and dry-run before a wallet sees it. In the demo nothing is signed.
[2:11–2:17] Lista counts raw tokens, not shares. MSFTB is posted as collateral, with a multiplier change scheduled.
[2:19–2:25] Three numbers before the flip: the protocol holds 3 raw, 3.000000 shares today, 3.006060 after.
[2:26–2:31] Plus what a share-priced oracle would do to the collateral value. Confirm the oracle before you borrow.
[2:33–2:38] Nothing scheduled for NVDAB in Venus, so it says so, instead of showing a made-up preview.
[2:42–2:48] One click exports the ledger to CSV, the rows a tax tool reading only transfers would never see.
[2:48–2:56] Agents get the same answers as MCP tools. This is sharetrue.dividend, called on the running server.
[2:56–3:01] Your wallet counts tokens. Shaddai counts shares.
