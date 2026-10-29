import {SOLANA_ADDRESS} from '@/lib/goldmine/snapshot';

// These checks are deliberately read-only. The app has no verified follower count or wallet-cluster
// classification; a provider's holder count must not be described as independent people. Rendered inside
// the review-evidence panel (app/candidate-evidence.tsx) under "Not measured by Coin Radar".
export function ManualChecks({mint, safetyStatus}: {mint: string; safetyStatus: 'verified' | 'unsafe' | 'unavailable'}) {
  if (!SOLANA_ADDRESS.test(mint)) return null;
  const search = 'https://x.com/search?q=' + encodeURIComponent(mint) + '&f=live';
  return <div className="candidate-review">
    <p className="candidate-review-title">Research socials and wallets before trading</p>
    <p>Coin Radar has no verified follower count or independent-wallet count for this mint. A holder address can belong to the developer or the same group as other addresses. A social link or follower total alone cannot establish genuine demand.</p>
    <ul>
      <li><strong>Social audience:</strong> Check that the project’s profile links this exact mint. Compare account history, real replies and independent discussion with the follower count; look for repeated or bot-like posts. <a href={search} target="_blank" rel="noopener noreferrer">Search the exact mint on X ↗</a></li>
      <li><strong>Wallet distribution:</strong> Inspect holder count, top holders and token flows for shared funding or transfers. Look at Axiom’s Dev Holding, Insiders, Snipers and Bundle fields. These indicators can miss relationships. <a href={'https://solscan.io/token/' + mint} target="_blank" rel="noopener noreferrer">Open Solscan holders and flows ↗</a></li>
      <li><strong>Contract and pool:</strong> {safetyStatus === 'verified' ? 'The stored RugCheck facts met Coin Radar’s checks at scan time; refresh the evidence.' : safetyStatus === 'unsafe' ? 'A stored safety check failed. Treat this as a blocker.' : 'Contract safety was not verified. Treat this as a blocker.'} Check current authorities, concentration, LP status and the exact pool. <a href={'https://rugcheck.xyz/tokens/' + mint} target="_blank" rel="noopener noreferrer">Open RugCheck ↗</a></li>
      <li><strong>Execution:</strong> Confirm that sells occur, liquidity is still present, and your own order preview shows the correct mint, route, amount, fees and slippage. No historical price or social metric proves an executable exit.</li>
    </ul>
    <p className="muted">These are manual checks, not a score or proof of safety. Axiom and Solscan may use different holder and wallet definitions. Coin Radar does not place a trade when you open a link.</p>
  </div>;
}
