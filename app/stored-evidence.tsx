'use client';
import {useEffect,useState} from 'react';
import {evidenceAge,type ReviewEvidence} from '@/lib/goldmine/review-evidence';

const value = (n: number | boolean | null, unit = '') => n === null ? 'Unknown' : typeof n === 'boolean' ? n ? 'Yes' : 'No' : `${n.toLocaleString()}${unit}`;
export default function StoredEvidence({evidence}: {evidence?: ReviewEvidence}) {
  const [now,setNow] = useState<number | null>(null);
  useEffect(() => {const initial = setTimeout(() => setNow(Date.now()), 0); const timer = setInterval(() => setNow(Date.now()), 60000); return () => {clearTimeout(initial); clearInterval(timer);};}, []);
  if (!evidence) return <p className="muted">Stored evidence unavailable for this record. Unknown does not mean zero or safe.</p>;
  const {market:m,contract:c} = evidence;
  const provenance = (source: string | null, at: number | null) => `${source ?? 'Source unknown'} · ${at === null ? 'Observation time unknown' : new Date(at).toLocaleString()} · ${now === null ? 'Age pending' : evidenceAge(at, now)}`;
  return <details className="stored-evidence">
    <summary>Inspect stored contract and pool evidence</summary>
    <p className="muted">Snapshots, not live checks. Unknown does not mean zero or safe. Recheck the exact mint and pool before a manual trade.</p>
    <h4>Detected pool · DEX Screener</h4><p className="evidence-source">{provenance(m.source, m.checkedAt)}</p>
    <dl className="evidence-grid">
      {([['Pool liquidity',m.liquidityUsd,' USD'],['Market cap',m.marketCapUsd,' USD'],['1h volume',m.volume1hUsd,' USD'],['1h buy transactions',m.buys1h,''],['1h sell transactions',m.sells1h,''],['Paid promotion',m.promoted,'']] as const).map(([label,n,unit]) => <div key={label}><dt>{label}</dt><dd>{value(n,unit)}</dd></div>)}
    </dl>
    <h4>Contract · RugCheck observations</h4><p className="evidence-source">{provenance(c.source, c.checkedAt)}</p>
    <dl className="evidence-grid">
      {([['Mint authority renounced',c.mintAuthorityRenounced,''],['Freeze authority renounced',c.freezeAuthorityRenounced,''],['LP locked across reported markets',c.lpLockedPct,'%'],['Largest reported holder',c.topHolderPct,'%'],['Reported top holders combined',c.topHoldersPct,'%'],['Reported creator holdings',c.creatorHoldingsPct,'%'],['Detected insider networks',c.insiderNetworksDetected,''],['Provider reports rugged',c.rugged,'']] as const).map(([label,n,unit]) => <div key={label}><dt>{label}</dt><dd>{value(n,unit)}</dd></div>)}
    </dl>
    <p className="muted">LP aggregation can cover several markets; it does not verify this pool’s exit route. Transactions are not unique traders. Zero detected networks does not prove independent holders. Sniper share, bundle share, verified followers and sellability remain unknown here.</p>
  </details>;
}
