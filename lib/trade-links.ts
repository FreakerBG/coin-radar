// Outbound links from a research signal to a trading app. Every builder validates its input and returns
// null for anything that is not a base58 Solana address, so a malformed stored value can never become a
// path segment or query parameter on a third-party site. None of these links carries an amount, a slippage
// setting, a wallet, or anything that could submit an order: opening one is a handoff, never a trade.
//
// What each format rests on (checked 2026-09-29, see docs/manual-trading-handoff.md):
// - Phantom token page: documented at https://docs.phantom.com/developer-powertools/token-pages
//   (https://phantom.com/tokens/<chain>/<token_address>). Opens the app on mobile, a web view on desktop.
// - Phantom swap: documented at https://docs.phantom.com/phantom-deeplinks/other-methods/swap. `buy` and
//   `sell` are URL-encoded CAIP-19 ids; the method has no amount parameter and only prefills the swapper.
//   Documented for mobile only, and meant to be tapped, so it is offered on mobile user agents only.
// - Axiom search: Axiom's docs say to paste the contract address into the search box, with Pulse as the
//   documented direct link (https://docs.axiom.trade/axiom/swap/market). That is the supported path.
// - Axiom token page (/meme/<address>): NOT documented by Axiom. In a real browser, signed out, the route
//   loads Axiom's app shell (it appends ?chain=sol) but did not show the token, for mints and pools alike.
//   It is kept as a convenience only; the copy-and-search fallback must always stay next to it.

export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export const isSolanaAddress = (value: unknown): value is string => typeof value === 'string' && SOLANA_ADDRESS.test(value);

// Solana mainnet's CAIP-2 reference as Phantom's own swap example writes it (`solana:101`).
const SOLANA_CAIP2 = 'solana:101';

export const AXIOM_SEARCH_URL = 'https://axiom.trade/pulse';

export function axiomTokenUrl(mint: string): string | null {
  return isSolanaAddress(mint) ? `https://axiom.trade/meme/${mint}` : null;
}

export function phantomTokenUrl(mint: string): string | null {
  return isSolanaAddress(mint) ? `https://phantom.com/tokens/solana/${mint}` : null;
}

// Prefills only the token to buy. `sell` is left empty exactly as Phantom's example does, which the docs
// define as SOL. No amount exists in this method, so the user always chooses it inside Phantom.
export function phantomSwapUrl(mint: string): string | null {
  if (!isSolanaAddress(mint)) return null;
  return `https://phantom.app/ul/v1/swap/?buy=${encodeURIComponent(`${SOLANA_CAIP2}/address:${mint}`)}&sell=`;
}

export function dexscreenerPoolUrl(pool: string): string | null {
  return isSolanaAddress(pool) ? `https://dexscreener.com/solana/${pool}` : null;
}

// Phantom's swap link is documented for the iOS and Android apps only. A desktop browser has no app to hand
// it to, so the token page is the desktop path. iPadOS reports a Mac user agent; its touch points tell it apart.
export function isMobileUserAgent(userAgent: string, maxTouchPoints = 0): boolean {
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

export type TradeLinks = {
  axiom: string;
  axiomSearch: string;
  phantomToken: string;
  phantomSwap: string | null;
  pool: string | null;
};

// All links for one signal, or null when the mint itself is invalid (nothing can be safely linked then).
// An invalid pool only drops the pool link: the mint links stay usable, and the pool is never guessed.
export function tradeLinks(mint: string, pool: string, mobile: boolean): TradeLinks | null {
  const axiom = axiomTokenUrl(mint);
  const phantomToken = phantomTokenUrl(mint);
  if (!axiom || !phantomToken) return null;
  return {axiom, axiomSearch: AXIOM_SEARCH_URL, phantomToken, phantomSwap: mobile ? phantomSwapUrl(mint) : null, pool: dexscreenerPoolUrl(pool)};
}
