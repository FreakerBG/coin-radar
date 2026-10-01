'use client';
import {useEffect,useState} from 'react';
import {emptyReview,REVIEW_CHECKS,reviewStatus,type ReviewChoice} from '@/lib/manual-review';
import {evidenceFor,type TradeTarget} from '@/lib/trade-handoff';
import type {Coin} from '@/lib/market';

// The parent keys this by mint+pool, so changing either discards every observation.
export default function LiveTradeReview({target,coin,fetchedAt}: {target: TradeTarget; coin: Coin | null; fetchedAt: number}) {
  const [review,setReview] = useState(emptyReview);
  const [now,setNow] = useState(0);
  useEffect(() => {const initial = setTimeout(() => setNow(Date.now()), 0); const timer = setInterval(() => setNow(Date.now()), 15000); return () => {clearTimeout(initial); clearInterval(timer);};}, []);
  const status = reviewStatus(review);
  const current = now > 0 && fetchedAt > 0 && fetchedAt <= now ? evidenceFor(target,coin,fetchedAt,now) : null;
  return <section className="live-review" aria-label="Live manual review before recording a fill">
    <h3>Live review before a manual trade</h3>
    <p className="muted">These notes stay in this page session and reset when the mint or pool changes. “Reviewed” means you inspected the item; Coin Radar has not verified it. Missing facts remain unknown.</p>
    <p role="status">{status.label} · {status.unknown} unknown · {status.blocked} blocked</p>
    <p className="muted">{current ? `DEX Screener response received ${new Date(fetchedAt).toLocaleTimeString()} for this exact pool. Provider data may be cached; this is not an executable quote or a live contract check.` : 'Current exact-pool evidence is missing or older than 90 seconds. Use Check evidence and verify directly in your trading app.'}</p>
    {current && <p className="mono">Reported liquidity: {current.liquidity === null ? 'Unknown' : current.liquidity.toLocaleString() + ' USD'} · Reported sell transactions: {current.sells === null ? 'Unknown' : current.sells}</p>}
    <div className="review-checks">{REVIEW_CHECKS.map(check => <fieldset key={check.id}>
      <legend>{check.label}</legend><p className="muted">{check.hint}</p>
      <div className="review-choices">{(['unknown','reviewed','blocked'] as const).map(choice => <label key={choice}>
        <input type="radio" name={`review-${check.id}`} value={choice} checked={review[check.id] === choice} onChange={() => setReview(r => ({...r,[check.id]:choice as ReviewChoice}))}/>
        {choice === 'unknown' ? 'Unknown' : choice === 'reviewed' ? 'Manually reviewed' : 'Blocker found'}
      </label>)}</div>
    </fieldset>)}</div>
    <button type="button" className="btn" onClick={() => setReview(emptyReview())}>Reset review notes</button>
    <p className="muted">If a check is blocked or unknown, resolve it before deciding on a new trade. You can still record an already completed fill below so existing exposure is tracked. Neither these notes nor recording a fill places an order.</p>
  </section>;
}
