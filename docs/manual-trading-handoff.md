# Manual trading handoff

How a Goldmine opportunity reaches a trading app and the Advisor, and what each link format actually rests on.
Coin Radar holds no wallet, signs nothing and sends no order. Opening a trading app is a handoff. It does not
prove that an order was placed or filled. A position exists only after the owner types the actual fill into
the Advisor's "Record a completed trade" form.

## Flow

1. **Goldmine card** (scan result or recorded history). Shows the full mint and the detected pool, each with its
   own label and copy button. The primary action is **Review in Axiom**, and **Open in Phantom** is secondary.
   On a phone, **Swap in Phantom app** is added. The card says that its price and safety evidence are snapshots,
   and that the live token, contract, liquidity, fees, slippage and order details must be checked in the
   trading app.
2. **Plan in Advisor** passes `{mint, pool, symbol, detectedAt}` (lib/trade-handoff.ts) to the Advisor tab.
   The handoff lives in React memory only. It is not persisted and carries no price or amount. Choosing a coin
   in Discover, or pressing "Use my Discover selection instead", replaces it.
3. **Advisor** re-reads evidence with `GET /api/advisor?address=<mint>&pair=<pool>`. With `pair`, the route
   uses that exact pool or none. It never substitutes a deeper sibling pool, because the recorded position
   is monitored on the pool it names.
4. **Record a completed trade** posts the exact mint and pool with the fill price and amount that the owner
   entered (`manualPosition`). Nothing else creates a position.

The recorded-opportunity list re-reads `GET /api/goldmine` every 5 minutes while the tab is visible, and on
**Refresh list**. It never calls `POST /api/goldmine` or the scheduled scan. Newly recorded opportunities are
marked once on the page, with no toast and no desktop notification.

## Platform evidence (checked 2026-09-29)

| Link | Status | Evidence |
| --- | --- | --- |
| `https://phantom.com/tokens/solana/<mint>` | **Documented** | [Phantom token pages](https://docs.phantom.com/developer-powertools/token-pages): opens the app on mobile when Phantom is installed; on desktop, a web view with a QR code to the swap screen. |
| `https://phantom.app/ul/v1/swap/?buy=<CAIP-19>&sell=` | **Documented, mobile only** | [Phantom swap deeplink](https://docs.phantom.com/phantom-deeplinks/other-methods/swap): `buy`/`sell` are URL-encoded CAIP-19 ids, and an empty `sell` means SOL. There is **no amount parameter**. It only prefills the swapper and never submits. The docs say it is meant to be tapped in an app, not pasted into a mobile browser. The unit test pins our output byte-for-byte to Phantom's own WIF example. Not yet tried on a physical phone. |
| Axiom: paste the contract into search, Pulse at `https://axiom.trade/pulse` | **Documented** | [Axiom Market](https://docs.axiom.trade/axiom/swap/market): "search for your token using the ticker or a contract address", with a direct link to Pulse. This is the "Copy mint and search Axiom" fallback. |
| `https://axiom.trade/meme/<address>` | **Not documented. Partly observed.** | Not in Axiom's docs index (`docs.axiom.trade/llms.txt`). In a real headed Chromium, **signed out**, the route loads Axiom's app shell and appends `?chain=sol`, but for every address tried (fresh pump mints and pools, WIF's mint and Orca pool, and an all-`1` invalid address) it showed "Market data unavailable" or the marketing/login page. It never showed the token. Headless Chromium is stopped by Cloudflare's bot check. Whether the route resolves a token for a signed-in user, and whether it expects a mint or a pool, is **unverified**. |

Because of the last row, the Axiom primary button also copies the mint to the clipboard, and the documented
search fallback is shown next to it on every card. Nothing here uses an Axiom API, a prefilled order, or
automation of a trading account.
