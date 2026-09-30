'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {Gem,RefreshCw,ShieldCheck,ShieldAlert,Radio,History} from 'lucide-react';
import {toast} from 'sonner';
import {goldmineTarget,type TradeTarget} from '@/lib/trade-handoff';
import {fetchTracking,newOpportunitiesAnnouncement,refreshDue,trackNewOpportunities,TRACKING_REFRESH_MS} from '@/lib/goldmine/live-refresh';
import TradeActions from './trade-actions';
import {isStale,latestBatchCountsLabel,latestBatchStalenessNote,latestBatchStatesLabel,opportunitiesOf,scanState,type LatestBatch,type PostedCandidate} from '@/lib/goldmine/dashboard-view';
import {allHistoryOpportunityLabel,cadenceSummary,coverageWindowLabel,cellStatusLabel,coverageLabel,dataQualityWarning,denominatorNote,hasDataQualityWarning,hasEnoughData,horizonLabel,horizonScheduleNote,legacyHorizonWarning,observedAfterLabel,performanceRowsWithData,signalsSummaryLabel,type BacktestReport} from '@/lib/goldmine/backtest-view';
import type {ContractSafetySummary} from '@/lib/goldmine/snapshot';

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
  detectedAt: string; detectedPrice: number; contractSafety: ContractSafetySummary;
  assessment: {summary: string};
  // `state` is the derived outcome state as of the read (lib/goldmine/cadence.ts), which is what separates a
  // live pending outcome from one whose window has already closed. `observedAfterHours` is how long after
  // detection the price was actually read - never assumed to be the horizon's target age.
  outcomes: {
    horizon: string; horizonLabel?: string; status: string; state?: string;
    returnPct: number | null; observedAfterHours?: number | null; targetHours?: number | null;
  }[];
};
type Tracking = {signals: TrackedSignal[]; latest?: LatestBatch | null; disclaimer?: string};

const money = (n: number | null) => n === null ? '—' : new Intl.NumberFormat('en-US', {style: 'currency', currency: 'USD', maximumFractionDigits: n < 0.01 ? 9 : n < 1 ? 5 : 2}).format(n);
const safetyEvidence = (candidate: PostedCandidate) => candidate.components.find(c => c.id === 'safety_risk')?.evidence[0] ?? '';

// Accepts either the full POST-response ContractSafety or the reduced GET-tracking ContractSafetySummary:
// both carry `status`, which is all this badge ever reads.
function SafetyBadge({contractSafety}: {contractSafety: {status: 'unavailable' | 'unsafe' | 'verified'}}) {
  if (contractSafety.status === 'verified') return <span className="pill" style={{borderColor: '#3f5a3a', color: '#b7ee82'}}><ShieldCheck size={13} /> RugCheck verified</span>;
  if (contractSafety.status === 'unsafe') return <span className="pill" style={{borderColor: '#4a3727', color: '#edc59b'}}><ShieldAlert size={13} /> Failed safety check</span>;
  return <span className="pill"><ShieldAlert size={13} /> Safety unchecked</span>;
}

// Only a signal whose mint and pool both validate can be handed to the Advisor: the position it may lead
// to is monitored on exactly that pool.
const planHandler = (signal: {address: string; pair: string; symbol: string; detectedAt: string | number}, onPlanTrade?: (target: TradeTarget) => void) => {
  const target = goldmineTarget(signal);
  return target && onPlanTrade ? () => onPlanTrade(target) : undefined;
};

function OpportunityCard({candidate, onPlanTrade}: {candidate: PostedCandidate; onPlanTrade?: (target: TradeTarget) => void}) {
  return (
    <div className="feed-item" key={candidate.address}>
      <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10}}>
        <div>
          <strong>{candidate.symbol.slice(0, 14)}</strong>
          <small className="muted" style={{display: 'block', marginTop: 4}}>Opportunity signal · not a trade instruction</small>
        </div>
        <div style={{textAlign: 'right'}}>
          <span className="mono" title="Provider price when scanned, not an executable quote">{money(candidate.priceUsd)}</span>
          <small className="muted" style={{display: 'block'}}>{candidate.state} · {candidate.score}/100</small>
        </div>
      </div>
      <p style={{fontSize: 13, color: '#b5c1cd', margin: '10px 0'}}>{candidate.summary}</p>
      <div style={{display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center'}}>
        <SafetyBadge contractSafety={candidate.snapshot.contractSafety} />
        {candidate.snapshot.promoted && <span className="tag" title="Paid DEX Screener promotion">AD</span>}
      </div>
      {safetyEvidence(candidate) && <p className="muted" style={{fontSize: 12, marginTop: 8}}>{safetyEvidence(candidate)}</p>}
      <TradeActions mint={candidate.address} pool={candidate.pair} symbol={candidate.symbol} evidenceAt={candidate.observedAt}
        onPlan={planHandler({...candidate, detectedAt: candidate.observedAt}, onPlanTrade)} />
    </div>
  );
}

// Fetches the read-only backtesting/calibration report. Same plain-function pattern as fetchTracking:
// state updates happen in the caller's effect/callback, never synchronously during render.
async function fetchBacktest(): Promise<BacktestReport | {error: string}> {
  try {
    const r = await fetch('/api/goldmine/backtest');
    const d = await r.json() as BacktestReport & {error?: string};
    if (!r.ok || d.error) return {error: d.error || 'Backtest report unavailable.'};
    return d;
  } catch {
    return {error: 'Cannot reach Goldmine. Check your connection and retry.'};
  }
}

const pct = (value: number | null) => value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

function BacktestingSection({report, error, onRetry}: {report: BacktestReport | null; error: string; onRetry: () => void}) {
  return (
    <>
      <div className="panel-head" style={{marginTop: 0}}>
        <h2 style={{margin: 0}}>Backtesting &amp; calibration</h2>
        <span className="muted" style={{fontSize: 13}}>Read-only replay and outcome analysis of stored signals - a research diagnostic, not a forecast.</span>
      </div>
      {error && (
        <div className="banner" role="alert" style={{margin: '16px 22px 0'}}>
          {error}
          <button className="btn" style={{marginLeft: 12}} onClick={onRetry}>Retry</button>
        </div>
      )}
      {/* Shown whenever it applies - truncation, skipped malformed rows/outcomes, or both - independent of
          hasEnoughData below. This is exactly the case (few or zero valid signals survive validation, or a
          corrupted history) where visibility matters most, so it must never hide behind the "not enough
          data" branch. Rendered once, here; the populated-report branch below never renders it again. */}
      {!error && hasDataQualityWarning(report) && (
        <div className="banner" role="status" style={{margin: '16px 22px 0'}}>{dataQualityWarning(report)}</div>
      )}
      {/* The cadence facts and the legacy-horizon explanation are rendered whenever this section renders -
          deliberately outside the hasEnoughData branch below. With little or no history the question "why is
          everything missed?" is at its most pressing, and answering it only once a report is populated would
          leave exactly the wrong impression in exactly the case where it matters most. */}
      {!error && report && (
        <>
          {coverageWindowLabel(report.coverage) && (
            <p className="muted" data-testid="backtest-coverage" style={{fontSize: 12, margin: '16px 22px 0'}}>{coverageWindowLabel(report.coverage)}</p>
          )}
          <p className="muted" style={{fontSize: 12, margin: '16px 22px 0'}}>{cadenceSummary(report.cadence)}</p>
          {legacyHorizonWarning(report.cadence) && (
            <div className="banner" role="status" style={{margin: '10px 22px 0'}}>{legacyHorizonWarning(report.cadence)}</div>
          )}
          <p className="muted" style={{fontSize: 12, margin: '10px 22px 0'}}>
            {allHistoryOpportunityLabel(report.totals)} {denominatorNote(report.totals, report.denominators)}
          </p>
          <p className="muted" style={{fontSize: 11, margin: '6px 22px 0'}}>
            Evaluation schedule {report.evaluationScheduleVersion} (scoring model {report.modelVersion} - the two are versioned separately; this stage changed only when outcomes are observed).
          </p>
        </>
      )}
      {!error && !hasEnoughData(report) && (
        <div className="empty"><h3>Not enough recorded signals yet</h3><span>Backtesting needs a history of tracked signals to report on. Run scans over time and check back here.</span></div>
      )}
      {!error && hasEnoughData(report) && report && (
        <div style={{padding: '0 22px 22px'}}>
          <p className="muted" style={{fontSize: 13}}>
            {signalsSummaryLabel(report)} Replay (model {report.modelVersion}): {report.replay.matched}/{report.replay.currentVersionSignals} current-version signals reproduce their stored assessment exactly
            {report.replay.mismatchedCount > 0 ? `, ${report.replay.mismatchedCount} mismatched${report.replay.mismatchedSampleTruncated ? ` (showing ${report.replay.mismatchedSample.length})` : ''}` : ''}.
            {report.replay.unsupportedCount > 0 && ` ${report.replay.unsupportedCount} signals from other model versions (${report.replay.unsupportedModelVersions.join(', ')}) have no supported replay.`}
            {report.replay.invalidCount > 0 && ` ${report.replay.invalidCount} signal${report.replay.invalidCount === 1 ? '' : 's'} could not be replayed and ${report.replay.invalidCount === 1 ? 'was' : 'were'} skipped.`}
          </p>

          <h3 style={{fontSize: 14, margin: '14px 0 6px'}}>Outcome performance by model version, state and horizon</h3>
          <div style={{overflowX: 'auto'}}>
            <table className="mono" style={{fontSize: 12, borderCollapse: 'collapse', width: '100%'}}>
              <thead><tr><th style={{textAlign: 'left'}}>Model</th><th style={{textAlign: 'left'}}>State</th><th style={{textAlign: 'left'}}>Horizon</th><th style={{textAlign: 'left'}}>Schedule</th><th style={{textAlign: 'left'}}>Coverage</th><th style={{textAlign: 'left'}}>Observed</th><th style={{textAlign: 'right'}}>Mean</th><th style={{textAlign: 'right'}}>Median</th><th style={{textAlign: 'right'}}>Stdev</th></tr></thead>
              <tbody>
                {performanceRowsWithData(report.performance).map(bucket => (
                  <tr key={`${bucket.modelVersion}:${bucket.state}:${bucket.horizon}`}>
                    <td className="muted" style={{whiteSpace: 'nowrap'}}>{bucket.modelVersion}</td>
                    <td>{bucket.state}</td>
                    <td title={bucket.targetHours === null ? undefined : `${bucket.targetHours}h target`}>{horizonLabel(bucket)}</td>
                    {/* Says on the row itself whether this horizon belongs to the active daily schedule and
                        whether the current cadence can observe it, so a legacy row's coverage is never read
                        as a result about the tokens. */}
                    <td className="muted" style={{whiteSpace: 'nowrap'}}>{horizonScheduleNote(bucket)}</td>
                    <td className="muted" style={{whiteSpace: 'nowrap'}}>{coverageLabel(bucket.coverage)}</td>
                    {/* The actual elapsed time between detection and observation - not the horizon's target
                        age, which a daily snapshot is only ever approximately at. */}
                    <td className="muted" style={{whiteSpace: 'nowrap'}}>{observedAfterLabel(bucket.observedAfterHours)}</td>
                    <td style={{textAlign: 'right'}}>{bucket.returnsPct.count ? `${pct(bucket.returnsPct.mean)} (n=${bucket.returnsPct.count})${bucket.returnsPct.count === 1 ? ' single sample' : ''}` : '—'}</td>
                    <td style={{textAlign: 'right'}}>{pct(bucket.returnsPct.median)}</td>
                    <td style={{textAlign: 'right'}}>{bucket.returnsPct.stdev === null ? '—' : `${bucket.returnsPct.stdev.toFixed(1)}pp`}</td>
                  </tr>
                ))}
                {!performanceRowsWithData(report.performance).length && <tr><td colSpan={9} className="muted">No outcomes recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="muted" style={{fontSize: 11, margin: '6px 0 0'}}>
            REJECTED rows are the control group. They are shown so the actionable states have something to be
            compared against, and are never evidence that the strategy works.
          </p>

          {report.calibration && (
            <>
              <h3 style={{fontSize: 14, margin: '18px 0 6px'}}>Score threshold sweep (descriptive only) - model {report.calibration.modelVersion}</h3>
              <p className="muted" style={{fontSize: 12, margin: '0 0 8px'}}>
                Reference (earlier) signals: {report.calibration.referenceCount}. Evaluation (later) signals: {report.calibration.evaluationCount}, reported below only.
                {report.calibration.excludedOtherVersionSignals > 0 && ` ${report.calibration.excludedOtherVersionSignals} signals from other model versions were excluded from this calibration.`}
                {' '}{report.calibration.sufficientCellCount}/{report.calibration.totalCellCount} threshold/horizon cells have sufficient observed evidence ({report.calibration.insufficientCellCount} insufficient, {report.calibration.notEvaluableCellCount} not evaluable).
                {report.calibration.descriptiveOnly && ' Descriptive only: at least one evaluable cell (or the evaluation half itself) does not yet meet the evidence requirement - a cell shown as sufficient does not make the rest of this table a validated result.'}
              </p>
              <div style={{overflowX: 'auto'}}>
                <table className="mono" style={{fontSize: 12, borderCollapse: 'collapse', width: '100%'}}>
                  {/* Columns come from the report's own horizons, never a hardcoded 15m/1h/6h/24h list: the
                      active and legacy sets both appear here, and a header that named one schedule's ids
                      would silently mislabel the other's cells. */}
                  <thead><tr><th style={{textAlign: 'left'}}>If threshold were</th><th style={{textAlign: 'right'}}>Eligible</th>
                    {(report.calibration.rows[0]?.byHorizon ?? []).map(h => (
                      <th key={h.horizon} style={{textAlign: 'left'}} title={horizonScheduleNote(h)}>
                        {horizonLabel(h)} mean (n obs/elig){h.observableUnderCadence ? '' : ' · not observable'}
                      </th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {report.calibration.rows.map(row => (
                      <tr key={row.threshold}>
                        <td>{row.threshold}</td>
                        <td style={{textAlign: 'right'}}>{row.eligibleCount}</td>
                        {row.byHorizon.map(h => (
                          <td key={h.horizon} title={`${coverageLabel(h.coverage)} ${observedAfterLabel(h.observedAfterHours)}`}>
                            {h.returnsPct.count ? `${pct(h.returnsPct.mean)} (${h.returnsPct.count}/${h.eligible})` : `— (0/${h.eligible})`}
                            {h.cellStatus !== 'sufficient' && <span className="muted"> {cellStatusLabel(h.cellStatus)}</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <p className="muted" style={{fontSize: 11, marginTop: 14}}>{report.limitations.join(' ')}</p>
        </div>
      )}
    </>
  );
}

export default function GoldminePanel({onPlanTrade}: {onPlanTrade?: (target: TradeTarget) => void}) {
  const [tracking, setTracking] = useState<Tracking | null>(null);
  const [historyError, setHistoryError] = useState('');
  // Read-only refresh bookkeeping (lib/goldmine/live-refresh.ts). `lastAttempt` paces the automatic
  // reads, success or not, so a failing read is retried at the refresh interval, never in a tight loop.
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [newIds, setNewIds] = useState<ReadonlySet<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState('');
  const lastAttempt = useRef<number | null>(null);
  const seenOpportunities = useRef<Set<string> | null>(null);
  const [scan, setScan] = useState<ScanResponse | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [backtest, setBacktest] = useState<BacktestReport | null>(null);
  const [backtestError, setBacktestError] = useState('');
  const historyId = useRef(0);
  const scanId = useRef(0);
  const backtestId = useRef(0);
  const scanning = useRef(false);
  // Read only inside effects/handlers, never during render, so staleness can be shown without an
  // impure Date.now() call in the render body; ticks slowly since a minute of drift here is harmless.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);

  const applyTracking = useCallback((id: number, result: Tracking | {error: string}) => {
    if (id !== historyId.current) return;
    setRefreshing(false);
    if ('error' in result) { setHistoryError(result.error); return; }
    setTracking(result);
    setHistoryError('');
    setLastUpdated(Date.now());
    const {seen, fresh} = trackNewOpportunities(seenOpportunities.current, result.signals ?? []);
    seenOpportunities.current = seen;
    if (fresh.length) {
      setNewIds(old => new Set([...old, ...fresh]));
      setAnnouncement(newOpportunitiesAnnouncement(fresh.length));
    }
  }, []);
  // Every path here is GET /api/goldmine only. Neither the timer nor the button can start a scan.
  const loadHistory = useCallback((id: number) => {
    lastAttempt.current = Date.now();
    void fetchTracking<Tracking>().then(result => applyTracking(id, result));
  }, [applyTracking]);
  const retryHistory = useCallback(() => { setRefreshing(true); loadHistory(++historyId.current); }, [loadHistory]);
  useEffect(() => { loadHistory(++historyId.current); }, [loadHistory]);
  useEffect(() => {
    const tick = () => { if (refreshDue(lastAttempt.current, Date.now(), document.visibilityState === 'visible')) retryHistory(); };
    const timer = setInterval(tick, 30000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [retryHistory]);

  const applyBacktest = useCallback((id: number, result: BacktestReport | {error: string}) => {
    if (id !== backtestId.current) return;
    if ('error' in result) { setBacktestError(result.error); return; }
    setBacktest(result);
    setBacktestError('');
  }, []);
  const retryBacktest = useCallback(() => { const id = ++backtestId.current; void fetchBacktest().then(result => applyBacktest(id, result)); }, [applyBacktest]);
  useEffect(() => { const id = ++backtestId.current; void fetchBacktest().then(result => applyBacktest(id, result)); }, [applyBacktest]);

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

  // The last batch anything recorded, from storage - not from this session's scan. This is the only
  // thing on the panel that reflects an unattended scheduled scan (Vercel Cron runs once a day), so it
  // renders on load, before and independently of any "Scan now" the viewer presses.
  const latest = tracking?.latest ?? null;
  const latestStates = latestBatchStatesLabel(latest);
  const latestStaleness = latestBatchStalenessNote(latest, now);

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
      {/* Storage-backed, so it is the same whether this session has scanned or not - and so a scan run by
          the scheduler rather than by the viewer is visible at all. Deliberately worded as "recorded",
          never "scanned": readLatestBatch() cannot see a scan that recorded nothing, and cannot tell an
          interactive scan from a scheduled one. Not role="status": it is present from first paint rather
          than announced on change, and the scan status line above already owns the live region. */}
      <div className="status-line" style={{padding: '13px 22px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', alignItems: 'flex-start'}}>
        <History size={12} style={{flexShrink: 0, marginTop: 3}} />
        <span>
          {latest && <>Most recent recorded signals: <time dateTime={latest.detectedAt}>{new Date(latest.detectedAt).toLocaleString()}</time>. </>}
          {latestBatchCountsLabel(latest)}
          {latestStates && <span className="muted"> {latestStates}</span>}
          {latestStaleness && <span className="muted"> {latestStaleness}</span>}
        </span>
      </div>
      {scan?.warnings?.map(w => <div className="banner" role="alert" key={w} style={{margin: '16px 22px 0'}}>{w}</div>)}
      {status === 'error' && (
        <div className="banner" role="alert" style={{margin: '16px 22px 0'}}>
          {statusText.error}
          <button className="btn" style={{marginLeft: 12}} onClick={() => void runScan()}>Retry</button>
        </div>
      )}
      <div className="feed">
        {status === 'opportunities' && opportunities.map(candidate => <OpportunityCard candidate={candidate} onPlanTrade={onPlanTrade} key={candidate.address} />)}
        {status === 'idle' && <div className="empty"><Gem size={30} /><h3>Scan for opportunities</h3><span>Run a scan to see verified candidates.</span></div>}
        {status === 'empty' && <div className="empty"><Gem size={30} /><h3>No opportunities right now</h3><span>Every scanned candidate is missing a hard gate or verified safety evidence. Try again after the market moves.</span></div>}
        {status === 'busy' && <div className="empty"><Gem size={30} /><h3>Scan already running</h3><span>Only one scan runs at a time. Try again in a moment.</span></div>}
        {status === 'unavailable' && <div className="empty"><Gem size={30} /><h3>Provider unavailable</h3><span>Try again shortly.</span></div>}
      </div>
      {scan?.coverage && <div className="table-footer">{scan.coverage}</div>}

      <div className="panel-head" style={{marginTop: 0}}>
        <h2 style={{margin: 0}}>Recent opportunities</h2>
        <span className="muted" style={{fontSize: 13}}>Recorded at detection · outcomes observed at the first daily scan at or after each 1-day, 3-day and 7-day target</span>
      </div>
      {/* Reads what the scheduled or manual scans already recorded. Never scans: that is "Scan now" above. */}
      <div className="refresh-line">
        <History size={12} />
        <span data-testid="history-last-updated">
          {lastUpdated
            ? <>List updated <time dateTime={new Date(lastUpdated).toISOString()}>{new Date(lastUpdated).toLocaleTimeString()}</time></>
            : 'Loading recorded opportunities…'}
          {' '}· rechecks every {TRACKING_REFRESH_MS / 60000} min while this tab is visible · read-only, never runs a scan
        </span>
        <button type="button" className="btn" style={{padding: '6px 10px', fontSize: 12}} onClick={retryHistory} disabled={refreshing}
          aria-label="Refresh list of recorded opportunities (read-only, does not run a scan)">
          <RefreshCw size={13} className={refreshing ? 'loading-icon' : ''} /> Refresh list
        </button>
        <span className="muted" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
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
                {newIds.has(signal.id) && <span className="new-pill">New since this page loaded</span>}
                <small className="muted" style={{display: 'block', marginTop: 4}}>Recorded {new Date(signal.detectedAt).toLocaleString()} · research signal, not a trade instruction</small>
              </div>
              <SafetyBadge contractSafety={signal.contractSafety} />
            </div>
            <p style={{fontSize: 13, color: '#b5c1cd', margin: '10px 0'}}>{signal.assessment.summary}</p>
            <div className="mono" style={{fontSize: 12, color: '#8fa0b0', display: 'flex', gap: 14, flexWrap: 'wrap'}}>
              {/* `state` (derived at read time), not the stored `status`: a pending outcome whose window has
                  already closed reads as "expired-unswept", never as work still to come. An observed outcome
                  carries the real elapsed hours, so a "1-day target" return never implies a 24-hour hold. */}
              {signal.outcomes.map(o => (
                <span key={o.horizon} title={o.targetHours === null || o.targetHours === undefined ? undefined : `${o.targetHours}h target`}>
                  {o.horizonLabel ?? o.horizon}: {o.status === 'observed'
                    ? `${o.returnPct === null ? '—' : `${o.returnPct > 0 ? '+' : ''}${o.returnPct}%`}${typeof o.observedAfterHours === 'number' ? ` after ${o.observedAfterHours.toFixed(1)}h` : ''}`
                    : (o.state ?? o.status) === 'expired_unswept' ? 'expired-unswept' : (o.state ?? o.status)}
                </span>
              ))}
            </div>
            <TradeActions mint={signal.address} pool={signal.pair} symbol={signal.symbol} evidenceAt={signal.detectedAt}
              onPlan={planHandler(signal, onPlanTrade)} />
          </div>
        ))}
        {/* Two genuinely different situations that used to render the same sentence, which is how a
            working scheduler that simply found nothing actionable looked identical to one that had
            never run at all. `latest` is what tells them apart. */}
        {!history.length && !historyError && (
          <div className="empty"><Gem size={28} /><h3>No opportunities recorded yet</h3>
            <span>{latest
              ? 'Signals have been recorded, but none of the most recent 50 met every safety and momentum gate. That is a result, not a missing scan.'
              : 'Verified opportunities from past scans, with their tracked outcomes, will appear here.'}</span>
          </div>
        )}
      </div>
      <div className="table-footer">
        {(scan?.disclaimer || tracking?.disclaimer) ?? 'Research signal from provider snapshots, not an executable price, a prediction or financial advice. No outcome or profit is implied.'}
        {' '}Outcome tracking is retrospective model evaluation, not a live price feed.
      </div>

      <BacktestingSection report={backtest} error={backtestError} onRetry={retryBacktest} />
    </section>
  );
}
