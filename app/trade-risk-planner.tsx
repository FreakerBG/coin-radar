'use client';
import {useState} from 'react';
import {planTradeRisk,type TradeRiskInputs} from '@/lib/trade-risk-plan';

const money = (value: number) => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(value);
const fields: {key: keyof TradeRiskInputs; label: string; hint: string; placeholder?: string}[] = [
  {key:'bankrollUsd',label:'Speculative trading budget · USD',hint:'Money you can afford to lose; not your total savings.',placeholder:'e.g. 1,000'},
  {key:'livePoolLiquidityUsd',label:'Live exact-pool liquidity · USD',hint:'Enter the current pool figure you see in Axiom; a quote is still needed for price impact.',placeholder:'e.g. 50,000'},
  {key:'maxFullLossPct',label:'Maximum full loss of budget · %',hint:'Caps a zero-recovery loss, not only a planned stop.'},
  {key:'maxPositionPct',label:'Maximum position of budget · %',hint:'A separate exposure ceiling.'},
  {key:'maxPoolSharePct',label:'Maximum share of reported liquidity · %',hint:'A rough exposure guard, not an executable-depth estimate.'},
  {key:'plannedStopPct',label:'Illustrative stop distance · %',hint:'For comparison only; a stop can slip, fail or never execute.'},
  {key:'buySlippagePct',label:'Estimated buy slippage · %',hint:'Use a realistic worse-fill estimate, not a guarantee.'},
  {key:'sellSlippagePct',label:'Estimated sell slippage · %',hint:'Can be much worse in a falling, thin market.'},
  {key:'platformFeePctPerSide',label:'Axiom fee per side · %',hint:'0.95% is Axiom’s published Wood net fee; enter your actual tier.'},
  {key:'fixedCostsUsd',label:'Estimated round-trip network / priority costs · USD',hint:'Include buy and sell costs; check the live transaction preview.'},
];
const startingValues: Record<keyof TradeRiskInputs,string> = {
  bankrollUsd:'',livePoolLiquidityUsd:'',maxFullLossPct:'0.5',maxPositionPct:'5',maxPoolSharePct:'1',
  plannedStopPct:'20',buySlippagePct:'1',sellSlippagePct:'1',platformFeePctPerSide:'0.95',fixedCostsUsd:'0.50',
};

export default function TradeRiskPlanner() {
  const [values,setValues] = useState(startingValues);
  const result = planTradeRisk(Object.fromEntries(Object.entries(values).map(([key,value])=>[key,value.trim()===''?NaN:Number(value)])) as TradeRiskInputs);
  const suggested = result ? Math.floor(result.maximumSpendUsd * 100) / 100 : 0;
  return <section className="panel trade-planner" aria-labelledby="trade-planner-title">
    <div className="panel-head"><div><div className="eyebrow">Before an Axiom order</div><h2 id="trade-planner-title" style={{margin:'6px 0'}}>Full-loss trade planner</h2><p className="muted" style={{margin:0}}>Estimate a spend ceiling for a manual trade. Nothing here reads your wallet, saves a position or sends an order.</p></div></div>
    <div className="settings"><div className="note caution"><strong>Assume the token can go to zero.</strong> The binding cap uses your full-loss budget, including an estimated buy fee and fixed costs. A stop-based cap is shown only for comparison; it cannot protect you from a rug or a failed exit.</div>
      <div className="trade-planner-fields">{fields.map(field=><label key={field.key}>{field.label}<input type="number" inputMode="decimal" min="0" step="any" placeholder={field.placeholder} value={values[field.key]} onChange={event=>setValues(old=>({...old,[field.key]:event.target.value}))}/><small>{field.hint}</small></label>)}</div>
      {!result ? <p className="note" role="status">Enter a positive budget and current pool liquidity. Check that every percentage and cost is valid.</p>
        : <div className="trade-planner-results" aria-live="polite">
          <div><small>Illustrative maximum spend · rounded down</small><strong className="mono">{money(suggested)}</strong><span>{result.bindingCap==='full_loss'?'Full-loss budget is binding.':result.bindingCap==='pool'?'Pool-share cap is binding.':result.bindingCap==='bankroll'?'Position-size cap is binding.':'Estimated fixed costs use the entire loss budget; skip this setup.'}</span></div>
          <div><small>Your full-loss ceiling</small><strong className="mono">{money(result.fullLossBudgetUsd)}</strong><span>Zero recovery exposure at the calculated cap: {money(result.fullLossExposureUsd)}.</span></div>
          <div><small>If the planned stop filled as modeled</small><strong className="mono">{money(result.plannedStopLossUsd)}</strong><span>The stop-only spend cap would be {money(result.stopBasedSpendCapUsd)}; do not use it as a safe size.</span></div>
          <div><small>Gross price rise to break even</small><strong className="mono">{result.breakEvenRisePct===null?'—':result.breakEvenRisePct.toFixed(1)+'%'}</strong><span>Includes entered fees and slippage estimates; excludes market impact and taxes.</span></div>
        </div>}
      <p className="muted" style={{fontSize:13}}>This is scenario math, not a quote or a recommendation to buy. Reported liquidity does not show the depth for your size. Recheck contract, pool, route, token amount, fees, slippage and MEV mode in Axiom’s live order preview. Axiom’s <a href="https://docs.axiom.trade/getting-started/fees/axiom-fees" target="_blank" rel="noopener noreferrer">published fee tiers ↗</a> and <a href="https://docs.axiom.trade/getting-started/fees/solana-fees" target="_blank" rel="noopener noreferrer">network settings ↗</a> may differ from your current account.</p>
    </div>
  </section>;
}
