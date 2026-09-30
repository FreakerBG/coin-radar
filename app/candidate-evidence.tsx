'use client';
import {CircleDot,CircleHelp,FileText,OctagonAlert,Search} from 'lucide-react';
import type {ReactNode} from 'react';
import {ManualChecks} from './candidate-review';
import {ageLabel,evidenceTier,FACTOR_GROUPS,FACTOR_META,factorValue,freshnessTier,MANUAL_CHECKS,safetyReportTier,STATUS_LABEL,summaryLine,TIER_LABEL,TIER_SENTENCE} from '@/lib/goldmine/evidence-view';
import type {FactorSource,FactorStatus,ReviewEvidence,ReviewFactor} from '@/lib/goldmine/review-evidence';

const SOURCE_LABEL: Record<FactorSource, string> = {dexscreener: 'DEX Screener snapshot', rugcheck: 'RugCheck report', x_cache: 'Cached X sample'};
const CHIP_ICON: Record<FactorStatus | 'manual', ReactNode> = {
  fails_check: <OctagonAlert size={12} aria-hidden="true"/>,
  within_check: <CircleDot size={12} aria-hidden="true"/>,
  recorded: <FileText size={12} aria-hidden="true"/>,
  not_measured: <CircleHelp size={12} aria-hidden="true"/>,
  manual: <Search size={12} aria-hidden="true"/>,
};

function Chip({status}: {status: FactorStatus | 'manual'}) {
  return <span className={`evidence-chip evidence-chip--${status}`}>{CHIP_ICON[status]}{STATUS_LABEL[status]}</span>;
}

const localTime = (ts: number) => new Date(ts).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'});
function when(asOf: number | null, now: number): string {
  if (asOf === null) return 'no time recorded';
  const tier = freshnessTier(asOf, now);
  return tier === 'recent' || tier === 'stale' ? `${localTime(asOf)} · ${ageLabel(asOf, now)}` : `${localTime(asOf)} · ${TIER_LABEL[tier]}`;
}

function ReasonList({title, items, empty, tone}: {title: string; items: string[]; empty: string; tone: 'fail' | 'unverified' | 'flag'}) {
  return <div className={`evidence-reasons evidence-reasons--${tone}`}>
    <h4>{title} <span className="mono">({items.length})</span></h4>
    {items.length ? <ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="muted">{empty}</p>}
  </div>;
}

function FactorRow({factor, now}: {factor: ReviewFactor; now: number}) {
  const meta = FACTOR_META[factor.id];
  return <div className="evidence-row" data-factor={factor.id}>
    <dt>{meta.label}</dt>
    <dd>
      <span className="evidence-value mono">{factorValue(factor)}</span>
      <Chip status={factor.status}/>
      <small className="evidence-meta">{SOURCE_LABEL[factor.source]} · {factor.status === 'not_measured' ? 'not measured' : when(factor.asOf, now)}</small>
      {meta.note && <small className="evidence-note">{meta.note}</small>}
    </dd>
  </div>;
}

// The recorded evidence behind one signal and what the stored assessment made of it. Classifications are
// the stored ones (lib/goldmine/review-evidence.ts); this component only lays them out.
export default function CandidateEvidence({evidence, mint, safetyStatus, now}: {evidence: ReviewEvidence | null | undefined; mint: string; safetyStatus: 'verified' | 'unsafe' | 'unavailable'; now: number}) {
  const tier = evidence?.readable ? evidenceTier(evidence, now) : null;
  const reportTier = evidence ? safetyReportTier(evidence, now) : null;
  return <details className="candidate-evidence">
    <summary>
      <span className="evidence-summary-title">Evidence &amp; unknowns</span>
      <span className="evidence-summary-line" data-testid="evidence-summary">{summaryLine(evidence, now)}</span>
    </summary>
    <div className="evidence-body">
      {evidence?.readable ? <>
        <dl className="evidence-times">
          <div><dt>DEX Screener snapshot</dt><dd data-testid="evidence-market-time">{evidence.marketObservedAt === null ? 'time unknown' : `${when(evidence.marketObservedAt, now)} (${TIER_LABEL[freshnessTier(evidence.marketObservedAt, now)]})`}</dd></div>
          <div><dt>RugCheck report</dt><dd data-testid="evidence-report-time">{reportTier === null ? 'none attached' : evidence.safety.reportAt === null ? 'time unknown' : `${when(evidence.safety.reportAt, now)} (${TIER_LABEL[reportTier]})`}</dd></div>
        </dl>
        {tier && <p className={`evidence-tier evidence-tier--${tier}`} role="note">{TIER_SENTENCE[tier]}</p>}
        <ReasonList title="Hard failures" tone="fail" items={evidence.hardFailures} empty="None recorded by the stored assessment. That is not a safety guarantee."/>
        <ReasonList title="Not verified" tone="unverified" items={evidence.notVerified} empty="Nothing recorded as unverified."/>
        <ReasonList title="Research flags" tone="flag" items={evidence.flags} empty="No research flags recorded."/>
        {FACTOR_GROUPS.map(group => {
          const rows = evidence.factors.filter(factor => FACTOR_META[factor.id].group === group);
          return rows.length ? <section className="evidence-group" key={group}>
            <h4>{group}</h4>
            <dl>{rows.map(factor => <FactorRow key={factor.id} factor={factor} now={now}/>)}</dl>
          </section> : null;
        })}
        <p className="muted evidence-model">Classified by the stored assessment{evidence.modelVersion ? ` (model ${evidence.modelVersion})` : ''} when the signal was recorded. Nothing here was rescored with today’s thresholds.</p>
      </> : <p className="evidence-tier evidence-tier--unknown" role="note">{summaryLine(evidence, now)}</p>}
      <section className="evidence-group evidence-manual">
        <h4>Not measured by Coin Radar · check in Axiom</h4>
        <ul className="evidence-manual-list">{MANUAL_CHECKS.map(item => <li key={item}><span>{item}</span><Chip status="manual"/></li>)}</ul>
        <ManualChecks mint={mint} safetyStatus={safetyStatus}/>
      </section>
    </div>
  </details>;
}
