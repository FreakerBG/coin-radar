'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Gem,RefreshCw,ShieldCheck,ShieldAlert,ArrowUpRight,Radio} from 'lucide-react';
import {toast} from 'sonner';
import {isStale,opportunitiesOf,scanState,type PostedCandidate} from '@/lib/goldmine/dashboard-view';
import type {ContractSafety} from '@/lib/goldmine/snapshot';

type ScanResponse = {
  status: 'checked' | 'busy' | 'provider_unavailable';
  asOf?: string;
  candidates?: PostedCandidate[];
  opportunities?: number;
  warnings?: string[];
  coverage?: string;
  disclaimer?: string;
  message?: string;
  error?: string;
};
type TrackedSignal = {
  id: string; address: string; pair: string; symbol: string; state: string; score: number; opportunity: boolean;
  detectedAt: string; detectedPrice: number; contractSafety: ContractSafety;
  assessment: {summary: string};
  outcomes: {horizon: string; status: string; returnPct: number | null}[];
};
type Tracking = {signals: TrackedSignal[]; disclaimer?: string};

const money = (n: number | null) => n === null ? '—' : new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: n < 0.01 ? 9 : n < 1 ? 5 : 2}).format(n);
const smallAddress = (a: string) => a.slice(0, 5) + '…' + a.slice(-5);
const safetyEvidence = (candidate: PostedCandidate) => candidate.components.find(c => c.id === 'safety_risk')?.evidence[0] ?? '';

function SafetyBadge({contractSafety}: {contractSafety: ContractSafety}) {
  if (contractSafety.status === 'verified') return <span className="pill" style={{borderColor: '#3f5a3a', color: '#b7ee82'}}><ShieldCheck size={13} /> RugCheck verified</span>;
  if (contractSafety.status === 'unsafe') return <span className="pill" style={{borderColor: '#4a3727', color: '#edc59b'}}><ShieldAlert size={13} /> Failed safety check</span>;
  return <span className="pill"><ShieldAlert size={13} /> Safety unchecked</span>;
}

function OpportunityCard({candidate}: {candidate: PostedCandidate}) {
  return (
    <div className="feed-item" key={candidate.address}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10}}>
        <div>
          <strong>{candidate.symbol.slice(0, 14)}</strong>
          <small className="muted mono" style={{display: 'block', marginTop: 4}} title={candidate.address}>{smallAddress(candidate.address)}</small>
        </div>
        <div style={{textAlign: 'right'}}>
          <span className="mono">{money(candidate.priceUsd)}</span>
          <small className="muted" style={{display: 'block'}}>{candidate.state} · {candidate.score}/100</small>
        </div>
      </div>
      <p style={{fontSize: 13, color: '#b5c1cd', margin: '10px 0'}}>{candidate.summary}</p>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center'}}>
        <SafetyBadge contractSafety={candidate.snapshot.contractSafety} />
        {candidate.snapshot.promoted && <span className="tag" title="Paid DEX Screener promotion">AD</span>}
      </div>
      {safetyEvidence(candidate) && <p className="muted" style={{fontSize: 12, marginTop: 8}}>{safetyEvidence(candidate)}</p>}
      <a className="source-link" href={`https://dexscreener.com/solana/${candidate.pair}`} target="_blank" rel="noopener noreferrer">Pool data & chart <ArrowUpRight size={13} /></a>
    </div>
  );
}

// Fetches the recorded signal history. A plain function, not a hook: both the mount effect and the
// retry button call it and set state themselves, so state updates always happen in an event/callback,
// never synchronously in an effect body.
async function fetchTracking(): Promise<Tracking | {error: string}> {
  try {
    const r = await fetch('/api/goldmine');
    const d = await r.json() as Tracking & {error?: string};
    if (!r.ok || d.error) return {error: d.error || 'Signal history unavailable.'};
    return d;
  } catch {
    return {error: 'Cannot reach Goldmine. Check your connection and retry.'};
  }
}

export default function GoldminePanel() {
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const historyId = useRef(0);
  const scanId = useRef(0);
  const scanning = useRef(false);
  // Read only inside effects/handlers, never during render, so staleness can be shown without an
  // impure Date.now() call in the render body; ticks slowly since a minute of drift here is harmless.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);

  const applyTracking = useCallback((id: number, result: Tracking | {error: string}) => {
    if (id !== historyId.current) return;
    if ('error' in result) { setHistoryError(result.error); return; }
    setTracking(result);
    setHistoryError('');
  }, []);
  const retryHistory = useCallback(() => { const id = ++historyId.current; void fetchTracking().then(result => applyTracking(id, result)); }, [applyTracking]);
  useEffect(() => { const id = ++historyId.current; void fetchTracking().then(result => applyTracking(id, result)); }, [applyTracking]);

  const runScan = useCallback(async () => {
    if (scanning.current) return;
    scanning.current = true;
    const id = ++scanId.current;
    setLoading(true);
    setScanError(null);
    try {
      const r = await fetch('/api/goldmine', {method: 'POST'});
      const d = await r.json() as ScanResponse;
      if (id !== scanId.current) return;
      if (!r.ok) { setScanError(d.error || 'Goldmine scan failed.'); return; }
      setScan(d);
      if (d.status === 'checked') retryHistory();
      if (d.status === 'provider_unavailable') toast.error('Market provider unavailable. No candidates were scored.');
    } catch {
      if (id === scanId.current) setScanError('Cannot reach Goldmine. Check your connection and retry.');
    } finally {
      scanning.current = false;
      if (id === scanId.current) setLoading(false);
    }
  }, [retryHistory]);

  const opportunities = scan?.candidates ? opportunitiesOf(scan.candidates) : [];
  const status = scanState({loading, error: scanError, status: scan?.status ?? null, opportunityCount: opportunities.length});
  const stale = scan?.asOf ? isStale(scan.asOf, now) : false;
  const history = (tracking?.signals ?? []).filter(s => s.opportunity);

  const statusText: Record<typeof status, string> = {
    idle: 'No scan run yet this session.',
    loading: 'Scanning the market for verified opportunities…',
    busy: 'Another scan is already running. Try again shortly.',
    unavailable: 'Market data provider is unavailable right now. No candidates were scored.',
    error: scanError || 'Goldmine scan failed.',
    empty: `Scanned ${scan?.candidates?.length ?? 0} candidate${scan?.candidates?.length === 1 ? '' : 's'}. None currently pass every safety and momentum gate.`,
    opportunities: `${opportunities.length} verified opportunit${opportunities.length === 1 ? 'y' : 'ies'} found.`,
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h2 style={{margin: 0, display: 'flex', gap: 9, alignItems: 'center'}}><Gem size={17} />Goldmine</h2>
          <p className="muted" style={{fontSize: 13, margin: '7px 0 0', maxWidth: 520}}>Momentum candidates whose contract safety RugCheck has verified. A screening heuristic, not a probability of profit - always your own research before acting.</p>
        </div>
        <button className="btn btn-primary" onClick={() => void runScan()} disabled={loading}>
          <RefreshCw size={15} className={loading ? 'loading-icon' : ''} />
          <span>{loading ? 'Scanning…' : 'Scan now'}</span>
        </button>
      </div>
      <div className="status-line" role="status" aria-live="polite" aria-atomic="true" style={{padding: '15px 22px', borderBottom: '1px solid var(--border)'}}>
        <Radio size={12} />
        <span>{statusText[status]}</span>
        {scan?.asOf && status !== 'loading' && <span className="muted" style={{marginLeft: 8}}>· Last scan {new Date(scan.asOf).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}{stale ? ' · stale, scan again for current data' : ''}</span>}
      </div>
      {scan?.warnings?.map(w => <div className="banner" role="alert" key={w} style={{margin: '16px 22px 0'}}>{w}</div>)}
      {status === 'error' && (
        <div className="banner" role="alert" style={{margin: '16px 22px 0'}}>
          {statusText.error}
          <button className="btn" style={{marginLeft: 12}} onClick={() => void runScan()}>Retry</button>
        </div>
      )}
      <div className="feed">
        {status === 'opportunities' && opportunities.map(candidate => <OpportunityCard candidate={candidate} key={candidate.address} />)}
        {status === 'idle' && <div className="empty"><Gem size={30} /><h3>Scan for opportunities</h3><span>Run a scan to see verified candidates.</span></div>}
        {status === 'empty' && <div className="empty"><Gem size={30} /><h3>No opportunities right now</h3><span>Every scanned candidate is missing a hard gate or verified safety evidence. Try again after the market moves.</span></div>}
        {status === 'busy' && <div className="empty"><Gem size={30} /><h3>Scan already running</h3><span>Only one scan runs at a time. Try again in a moment.</span></div>}
        {status === 'unavailable' && <div className="empty"><Gem size={30} /><h3>Provider unavailable</h3><span>Try again shortly.</span></div>}
      </div>
      {scan?.coverage && <div className="table-footer">{scan.coverage}</div>}

      <div className="panel-head" style={{marginTop: 0}}>
        <h2 style={{margin: 0}}>Recent opportunities</h2>
        <span className="muted" style={{fontSize: 13}}>Recorded at detection · outcome tracked over 15m/1h/6h/24h</span>
      </div>
      {historyError && (
        <div className="banner" role="alert" style={{margin: '16px 22px 0'}}>
          {historyError}
          <button className="btn" style={{marginLeft: 12}} onClick={retryHistory}>Retry</button>
        </div>
      )}
      <div className="feed">
        {history.map(signal => (
          <div className="feed-item" key={signal.id}>
            <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10}}>
              <div>
                <strong>{signal.symbol.slice(0, 14)}</strong>
                <small className="muted" style={{display: 'block', marginTop: 4}}>{new Date(signal.detectedAt).toLocaleString()}</small>
              </div>
              <SafetyBadge contractSafety={signal.contractSafety} />
            </div>
            <p style={{fontSize: 13, color: '#b5c1cd', margin: '10px 0'}}>{signal.assessment.summary}</p>
            <div className="mono" style={{fontSize: 12, color: '#8fa0b0', display: 'flex', gap: 14, flexWrap: 'wrap'}}>
              {signal.outcomes.map(o => <span key={o.horizon}>{o.horizon}: {o.status === 'observed' ? (o.returnPct === null ? '—' : `${o.returnPct > 0 ? '+' : ''}${o.returnPct}%`) : o.status}</span>)}
            </div>
            <a className="source-link" href={`https://dexscreener.com/solana/${signal.pair}`} target="_blank" rel="noopener noreferrer">Pool data & chart <ArrowUpRight size={13} /></a>
          </div>
        ))}
        {!history.length && !historyError && <div className="empty"><Gem size={28} /><h3>No opportunities recorded yet</h3><span>Verified opportunities from past scans, with their tracked outcomes, will appear here.</span></div>}
      </div>
      <div className="table-footer">
        {(scan?.disclaimer || tracking?.disclaimer) ?? 'Research signal from provider snapshots, not an executable price, a prediction or financial advice. No outcome or profit is implied.'}
        {' '}Outcome tracking is retrospective model evaluation, not a live price feed.
      </div>
    </section>
  );
}
