// Axiom's token-page route is a convenience link. Its documented contract search
// remains the fallback when a token page does not resolve in a user's session.
export function axiomTokenUrl(address: string): string | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return null;
  return `https://axiom.trade/meme/${address}`;
}
