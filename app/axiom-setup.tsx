'use client';
import {ArrowUpRight,Copy,SlidersHorizontal} from 'lucide-react';
import {toast} from 'sonner';
import {AXIOM_MARKET_DOCS_URL,AXIOM_PULSE_DOCS_URL,AXIOM_PULSE_URL,PULSE_PHASES,PULSE_STUDY_FIELDS,pulseStudyText} from '@/lib/axiom-pulse-guide';
import TradeRiskPlanner from './trade-risk-planner';

export default function AxiomSetup() {
  const copy = async () => {
    try { await navigator.clipboard.writeText(pulseStudyText()); toast.success('Research settings copied. Enter them manually in Axiom Pulse.'); }
    catch { toast.error('Could not copy. Select the settings on this page instead.'); }
  };
  return <><section className="panel axiom-setup" aria-labelledby="axiom-setup-title">
    <div className="panel-head"><div><div className="eyebrow">Manual trading workspace</div><h2 id="axiom-setup-title" style={{margin:'6px 0'}}>Set up Axiom Pulse</h2><p className="muted" style={{margin:0}}>A research watchlist you can enter in your own Axiom account. Coin Radar cannot change your Axiom settings or place orders.</p></div><SlidersHorizontal size={20}/></div>
    <div className="settings">
      <div className="note caution"><strong>Study profile · not a proven strategy</strong>These numbers are starting groups for comparison, not Axiom defaults or a claim of profitable coins. Axiom documents the filter names; no provider publishes a winning configuration. Keep the exact contract and pool checks in the trade flow.</div>
      <ol className="axiom-steps">
        <li>Open <a href={AXIOM_PULSE_URL} target="_blank" rel="noopener noreferrer">Axiom Pulse <ArrowUpRight size={14}/></a> and sign in to your own account.</li>
        <li>Choose the <strong>Migrated</strong> table (or its current equivalent), then open its <strong>Filters</strong> control.</li>
        <li>Enter the study values below. Select the <strong>1h</strong> window for volume, transactions and sells if Axiom offers it. Leave any unavailable field unset; do not invent a zero.</li>
        <li>Review results in Axiom, then search the exact mint in Coin Radar. Check safety evidence and live liquidity before considering an order. Enter any real fill manually in Advisor.</li>
      </ol>
      <div className="axiom-actions"><a className="btn btn-primary" href={AXIOM_PULSE_URL} target="_blank" rel="noopener noreferrer">Open Axiom Pulse <ArrowUpRight size={15}/></a><button className="btn" type="button" onClick={()=>void copy()}><Copy size={15}/> Copy study settings</button></div>
      <h3>Which Pulse table?</h3><div className="axiom-phases">{PULSE_PHASES.map(phase=><div className="note" key={phase.name}><strong>{phase.name}</strong><span>{phase.note}</span></div>)}</div>
      <h3>Fields to enter · Migrated watchlist experiment</h3>
      <div className="axiom-table-wrap"><table className="axiom-table"><thead><tr><th scope="col">Axiom Pulse field</th><th scope="col">Study value</th><th scope="col">Why / data limit</th></tr></thead><tbody>{PULSE_STUDY_FIELDS.map(field=><tr key={field.name}><th scope="row">{field.name}</th><td className="mono">{field.studyValue}</td><td>{field.why}{field.caveat&&<small className="muted">{field.caveat}</small>}</td></tr>)}</tbody></table></div>
      <p className="muted" style={{fontSize:13}}>Leave Pro Traders and Num Buys unset for this first comparison. Axiom may change labels or available time windows; check its live interface. Filter values reduce a list, but they do not verify a token or guarantee an executable exit.</p>
      <h3>Before pressing Buy</h3><ul className="axiom-checks"><li>Compare the mint and the exact pool with Coin Radar; reject missing or failed contract safety evidence.</li><li>Confirm current liquidity, holder and developer distribution, mint/freeze permissions, and whether sells actually execute.</li><li>Review the current price, trade size, priority fee, slippage and order details inside Axiom. The recorded signal price is a past snapshot.</li></ul>
      <h3>How I would shortlist candidates</h3><p className="muted" style={{fontSize:13}}>Start with the recorded opportunity and its safety evidence. For each exact mint, inspect the project’s linked social account and independent discussion; a follower count can be bought. Compare holder count with top-wallet concentration and transfer/funding patterns, then inspect Axiom’s insider, sniper, bundle and dev indicators. Require live liquidity and observed sells. Coin Radar does not currently verify follower quality or independent wallets, so those checks remain manual and cannot raise its score.</p>
      <p className="muted" style={{fontSize:13}}>Sources: <a href={AXIOM_PULSE_DOCS_URL} target="_blank" rel="noopener noreferrer">Axiom Pulse filters ↗</a> · <a href={AXIOM_MARKET_DOCS_URL} target="_blank" rel="noopener noreferrer">Axiom order flow ↗</a>. Research context: <a href="https://arxiv.org/abs/2608.20271" target="_blank" rel="noopener noreferrer">Solana rug-pull study ↗</a> and <a href="https://arxiv.org/abs/2507.01963" target="_blank" rel="noopener noreferrer">memecoin manipulation study ↗</a>. These do not validate this preset.</p>
    </div>
  </section><TradeRiskPlanner/></>;
}
