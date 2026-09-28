import {axiomTokenUrl} from '@/lib/axiom';

export default function TradingAppLinks({address}: {address: string}) {
  const axiomUrl = axiomTokenUrl(address);
  if (!axiomUrl) return null;

  return <div className="trading-app-links">
    <a href={axiomUrl} target="_blank" rel="noopener noreferrer">Axiom ↗</a>
    <a href={`https://phantom.com/tokens/solana/${address}`} target="_blank" rel="noopener noreferrer">Phantom ↗</a>
  </div>;
}
