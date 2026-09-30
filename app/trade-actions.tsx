'use client';
import {useSyncExternalStore} from 'react';
import {ArrowUpRight,ClipboardList,Copy} from 'lucide-react';
import {toast} from 'sonner';
import {isMobileUserAgent,isSolanaAddress,tradeLinks} from '@/lib/trade-links';

// The user agent never changes during a page's life, so there is nothing to subscribe to. The server
// snapshot is "not mobile", so server markup never offers the app-only swap link.
const noSubscription = () => () => {};
const mobileSnapshot = () => isMobileUserAgent(navigator.userAgent, navigator.maxTouchPoints || 0);
const desktopSnapshot = () => false;

function copy(text: string, success: string) {
  if (!navigator.clipboard) { toast.error('Could not copy. Select the address manually.'); return; }
  navigator.clipboard.writeText(text).then(() => toast.success(success)).catch(() => toast.error('Could not copy. Select the address manually.'));
}

// The handoff from a recorded signal to a trading app. Every action here opens a page or copies an
// address; none of them places, records or confirms a trade. A position is created only from the
// Advisor's manual form, with the fill the owner typed in.
export default function TradeActions({mint, pool, symbol, evidenceAt, onPlan}: {mint: string; pool: string; symbol: string; evidenceAt: string | number; onPlan?: () => void}) {
  const mobile = useSyncExternalStore(noSubscription, mobileSnapshot, desktopSnapshot);
  const links = tradeLinks(mint, pool, mobile);
  const name = symbol.slice(0, 14);
  const evidenceTime = new Date(evidenceAt);
  const evidenceLabel = Number.isFinite(evidenceTime.getTime()) ? evidenceTime.toLocaleString() : 'an unknown time';

  if (!links) {
    return <p className="banner" role="note" style={{margin: '10px 0 0'}}>This signal&apos;s contract address failed validation, so no trading links are shown.</p>;
  }

  return (
    <div className="trade-handoff" role="group" aria-label={`Manual trade options for ${name}`}>
      <dl className="trade-addresses">
        <div>
          <dt>Mint (token contract)</dt>
          <dd><code className="mono" data-testid="trade-mint">{mint}</code>
            <button type="button" className="icon-btn" aria-label={`Copy ${name} mint address`} onClick={() => copy(mint, 'Mint address copied')}><Copy size={14} /></button></dd>
        </div>
        <div>
          <dt>Detected pool</dt>
          {isSolanaAddress(pool)
            ? <dd><code className="mono" data-testid="trade-pool">{pool}</code>
              <button type="button" className="icon-btn" aria-label={`Copy ${name} pool address`} onClick={() => copy(pool, 'Pool address copied')}><Copy size={14} /></button></dd>
            : <dd className="muted">Pool address failed validation.</dd>}
        </div>
      </dl>
      <div className="trade-buttons">
        {/* The same click also copies the mint: if Axiom's token page does not resolve (it is not a
            documented route), the address is already on the clipboard for Axiom's search. */}
        <a className="btn btn-primary" href={links.axiom} target="_blank" rel="noopener noreferrer" aria-label={`Review in Axiom: ${name} (opens in a new tab)`}
          onClick={() => copy(mint, 'Mint copied. If Axiom does not show this token, paste it into Axiom search.')}>
          Review in Axiom <ArrowUpRight size={15} />
        </a>
        <a className="btn" href={links.phantomToken} target="_blank" rel="noopener noreferrer" aria-label={`Open in Phantom: ${name} (opens in a new tab)`}>
          Open in Phantom <ArrowUpRight size={15} />
        </a>
        {links.phantomSwap && (
          <a className="btn" href={links.phantomSwap} target="_blank" rel="noopener noreferrer" aria-label={`Swap in Phantom app: ${name}, token prefilled, you choose the amount`}>
            Swap in Phantom app <ArrowUpRight size={15} />
          </a>
        )}
        {onPlan && (
          <button type="button" className="btn" onClick={onPlan} aria-label={`Plan in Advisor: ${name}, this exact mint and pool`}>
            <ClipboardList size={15} /> Plan in Advisor
          </button>
        )}
      </div>
      <p className="trade-note">
        Axiom page blank, asking you to log in, or showing a different token?{' '}
        <a className="textlink" href={links.axiomSearch} target="_blank" rel="noopener noreferrer"
          onClick={() => copy(mint, 'Mint copied. Paste it into Axiom search.')}>Copy mint and search Axiom ↗</a>
        {links.pool && <>{' · '}<a className="textlink" href={links.pool} target="_blank" rel="noopener noreferrer">Pool data &amp; chart ↗</a></>}
        {links.phantomSwap && <> · The Phantom swap link prefills this token only; you enter the amount and confirm in Phantom.</>}
      </p>
      <p className="trade-note muted">
        Price and safety evidence are snapshots from {evidenceLabel}. In the trading app, check the live token, contract,
        liquidity, fees, slippage and order details before you confirm anything. Opening Axiom or Phantom does not place,
        record or confirm a trade.
      </p>
    </div>
  );
}
