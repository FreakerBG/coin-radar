// Contract safety evidence for Goldmine (Stage 03B), from RugCheck's public API: mint and freeze
// authority, LP lock, holder concentration, creator holdings, insider-network signal, its rugged flag
// and its own listed risks. Only the unauthenticated, read-only GET /v1/tokens/{mint}/report is called.
// No API key, no write endpoint, no wallet action, nothing sent but the mint address in the URL.
//
// The full report is used, not /report/summary: the summary omits mint/freeze authority, holders,
// creator and insider fields entirely (confirmed against RugCheck's published Swagger spec), so it
// cannot supply what this evidence needs.
//
// A candidate becomes 'verified' only once every deterministic check below is both available and
// passed; RugCheck's own score or verdict never decides this directly (see deriveContractSafety).
// Anything short of that fails closed to 'unavailable' or 'unsafe' (lib/goldmine/snapshot.ts), which
// the existing opportunity gate (lib/goldmine/score.ts) already treats as not verified.
import {reportFailure} from '../diagnostics';
import {scoreCandidate, type Assessment} from './score';
import {at, type CandidateSnapshot, type ContractSafety, type ContractSafetyFacts, type ContractSafetyRisk} from './snapshot';

export const SOURCE = 'rugcheck';
const REPORT_URL = (address: string) => `https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(address)}/report`;
const REQUEST_TIMEOUT_MS = 8000;
// How long a fetched report is reused before asking RugCheck again. Well under its observed
// unauthenticated rate limit (~15 requests per window) so a token that keeps reappearing across scans
// costs one request every ten minutes, not one per scan.
const CACHE_TTL_MS = 10 * 60000;
// How old a report (cached or not) may be and still back a safety decision. Kept well above
// CACHE_TTL_MS so normal cache reuse is never stale by this rule; it exists for deriveContractSafety
// callers that pass an explicit, older checkedAt.
const MAX_FACT_AGE_MS = 15 * 60000;

// Deterministic thresholds. RugCheck supplies facts; these bars are ours, not RugCheck's own score.
export const LP_LOCKED_MIN_PCT = 80;
export const MAX_SINGLE_HOLDER_PCT = 20;
export const MAX_TOP_HOLDERS_PCT = 50;
export const MAX_CREATOR_HOLDINGS_PCT = 10;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function pctOrNull(value: unknown): number | null {
  const n = numberOrNull(value);
  return n !== null && n >= 0 && n <= 100 ? n : null;
}
// RugCheck reports null for a renounced authority and a base58 pubkey for one still set. Any other
// shape (missing key, wrong type) is unknown and must never be read as renounced.
function authorityRenounced(value: unknown): boolean | null {
  if (value === null) return true;
  if (typeof value === 'string' && value.trim()) return false;
  return null;
}
// The market with the most reported liquidity (RugCheck can list more than one AMM pool per token).
function primaryMarket(markets: unknown): unknown {
  if (!Array.isArray(markets)) return null;
  let best: unknown = null, bestLiquidity = -1;
  for (const market of markets) {
    const lp = at(market, 'lp');
    if (lp === null || typeof lp !== 'object') continue;
    const liquidity = (numberOrNull(at(lp, 'quoteUSD')) ?? 0) + (numberOrNull(at(lp, 'baseUSD')) ?? 0);
    if (liquidity > bestLiquidity) { bestLiquidity = liquidity; best = market; }
  }
  return best;
}
// The largest single holder's share of supply, and the sum across every reported top holder.
function holderConcentration(topHolders: unknown): {top: number | null; sum: number | null} {
  if (!Array.isArray(topHolders)) return {top: null, sum: null};
  const pcts = topHolders.map(entry => pctOrNull(at(entry, 'pct'))).filter((n): n is number => n !== null);
  if (!pcts.length) return {top: null, sum: null};
  return {top: Math.max(...pcts), sum: Math.min(100, pcts.reduce((sum, n) => sum + n, 0))};
}
// creatorBalance is a raw token amount, in the same units as token.supply (not already a percentage).
function creatorHoldingsPct(creatorBalance: unknown, supply: unknown): number | null {
  const balance = numberOrNull(creatorBalance), total = numberOrNull(supply);
  return balance !== null && total !== null && total > 0 ? Math.min(100, balance / total * 100) : null;
}
function providerRisks(risks: unknown): ContractSafetyRisk[] {
  if (!Array.isArray(risks)) return [];
  return risks.filter(risk => typeof at(risk, 'name') === 'string').map(risk => ({
    name: String(at(risk, 'name')).slice(0, 80),
    level: typeof at(risk, 'level') === 'string' ? String(at(risk, 'level')).toLowerCase() : 'unknown',
    description: typeof at(risk, 'description') === 'string' ? String(at(risk, 'description')).slice(0, 200) : '',
  }));
}

// Reads RugCheck's full report into our own fact shape. Each fact is independently nullable: a report
// that omits or cannot compute one thing leaves only that fact unknown, not the whole report unusable.
// Returns null only when the response is not recognizable as a RugCheck report at all (schema drift).
export function extractFacts(raw: unknown): ContractSafetyFacts | null {
  const token = at(raw, 'token');
  if (token === null || typeof token !== 'object') return null;
  if (typeof at(raw, 'rugged') !== 'boolean') return null;
  const market = primaryMarket(at(raw, 'markets'));
  const holders = holderConcentration(at(raw, 'topHolders'));
  return {
    mintAuthorityRenounced: authorityRenounced(at(token, 'mintAuthority')),
    freezeAuthorityRenounced: authorityRenounced(at(token, 'freezeAuthority')),
    lpLockedPct: market ? pctOrNull(at(market, 'lp', 'lpLockedPct')) : null,
    totalMarketLiquidityUsd: numberOrNull(at(raw, 'totalMarketLiquidity')),
    topHolderPct: holders.top,
    topHoldersPct: holders.sum,
    creatorHoldingsPct: creatorHoldingsPct(at(raw, 'creatorBalance'), at(token, 'supply')),
    insiderNetworksDetected: numberOrNull(at(raw, 'graphInsidersDetected')),
    rugged: at(raw, 'rugged') as boolean,
    providerScoreNormalized: numberOrNull(at(raw, 'score_normalised')),
    providerRisks: providerRisks(at(raw, 'risks')),
  };
}

type SafetyCheck = {available: boolean; passed: boolean; message: string};

// Our own deterministic bar, applied to RugCheck's facts. Never reads score or score_normalised:
// a provider's own aggregate must not silently stand in for these checks.
function safetyChecks(facts: ContractSafetyFacts): SafetyCheck[] {
  const dangerRisk = facts.providerRisks.find(risk => risk.level === 'danger');
  const round = (value: number) => Math.round(value * 10) / 10;
  return [
    {available: facts.mintAuthorityRenounced !== null, passed: facts.mintAuthorityRenounced === true,
      message: facts.mintAuthorityRenounced === false ? 'Mint authority is still active.' : 'Mint authority could not be confirmed renounced.'},
    {available: facts.freezeAuthorityRenounced !== null, passed: facts.freezeAuthorityRenounced === true,
      message: facts.freezeAuthorityRenounced === false ? 'Freeze authority is still active.' : 'Freeze authority could not be confirmed renounced.'},
    {available: facts.lpLockedPct !== null, passed: facts.lpLockedPct !== null && facts.lpLockedPct >= LP_LOCKED_MIN_PCT,
      message: facts.lpLockedPct !== null ? `Only ${round(facts.lpLockedPct)}% of LP is locked (needs ${LP_LOCKED_MIN_PCT}%).` : 'LP lock status could not be confirmed.'},
    {available: facts.topHolderPct !== null && facts.topHoldersPct !== null,
      passed: facts.topHolderPct !== null && facts.topHoldersPct !== null && facts.topHolderPct <= MAX_SINGLE_HOLDER_PCT && facts.topHoldersPct <= MAX_TOP_HOLDERS_PCT,
      message: facts.topHolderPct !== null ? `Holder concentration too high (largest holder ${round(facts.topHolderPct)}%, top holders ${round(facts.topHoldersPct ?? 0)}%).` : 'Holder concentration could not be confirmed.'},
    {available: facts.creatorHoldingsPct !== null, passed: facts.creatorHoldingsPct !== null && facts.creatorHoldingsPct <= MAX_CREATOR_HOLDINGS_PCT,
      message: facts.creatorHoldingsPct !== null ? `Creator holds ${round(facts.creatorHoldingsPct)}% of supply.` : 'Creator holdings could not be confirmed.'},
    {available: facts.insiderNetworksDetected !== null, passed: facts.insiderNetworksDetected === 0,
      message: facts.insiderNetworksDetected !== null ? 'Insider network activity was detected.' : 'Insider network activity could not be confirmed.'},
    {available: facts.rugged !== null, passed: facts.rugged === false, message: 'RugCheck has recorded this contract as rugged.'},
    {available: true, passed: !dangerRisk, message: dangerRisk ? `RugCheck reports a danger-level risk: ${dangerRisk.name}.` : ''},
  ];
}

// Turns one RugCheck response into a ContractSafety value. Pure: no network, so it is directly
// testable with fixtures. `checkedAt` is when the underlying report was fetched (not necessarily
// `now`, when a cached report is reused); a report older than MAX_FACT_AGE_MS is treated the same as
// no report at all.
export function deriveContractSafety(raw: unknown, checkedAt: number, now: number): ContractSafety {
  if (now - checkedAt > MAX_FACT_AGE_MS) return {status: 'unavailable', source: null};
  const facts = extractFacts(raw);
  if (!facts) return {status: 'unavailable', source: null};
  const checks = safetyChecks(facts);
  const failed = checks.filter(check => check.available && !check.passed);
  if (failed.length) return {status: 'unsafe', source: SOURCE, checkedAt, facts, failedChecks: failed.map(check => check.message)};
  if (checks.some(check => !check.available)) return {status: 'unavailable', source: null};
  return {status: 'verified', source: SOURCE, checkedAt, facts};
}

class RugCheckRateLimited extends Error {}

type CacheEntry = {expires: number; fetchedAt: number; raw: unknown};
const cache = new Map<string, CacheEntry>();

async function fetchReport(address: string, now: number): Promise<{raw: unknown; fetchedAt: number}> {
  const cached = cache.get(address);
  if (cached && cached.expires > now) return {raw: cached.raw, fetchedAt: cached.fetchedAt};
  const response = await fetch(REPORT_URL(address), {headers: {Accept: 'application/json'}, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
  if (response.status === 429) throw new RugCheckRateLimited('RugCheck rate limit reached');
  if (!response.ok) throw new Error(`RugCheck returned ${response.status}`);
  const raw = await response.json();
  if (cache.size > 200) cache.clear();
  cache.set(address, {expires: now + CACHE_TTL_MS, fetchedAt: now, raw});
  return {raw, fetchedAt: now};
}

// Fetches and evaluates contract safety for each snapshot, one at a time (never in parallel: RugCheck's
// unauthenticated limit is far below a full discovery batch). The first 429 stops every further request
// for the rest of this call - the remaining snapshots simply keep their existing (unavailable)
// contractSafety - instead of retrying into the same limit. There is otherwise no retry: a single
// failed attempt is reported and left unavailable.
export async function attachContractSafety(snapshots: CandidateSnapshot[], now = Date.now()): Promise<CandidateSnapshot[]> {
  if (!snapshots.length) return snapshots;
  let rateLimited = false;
  const results: CandidateSnapshot[] = [];
  for (const snapshot of snapshots) {
    if (rateLimited) { results.push(snapshot); continue; }
    try {
      const {raw, fetchedAt} = await fetchReport(snapshot.address, now);
      results.push({...snapshot, contractSafety: deriveContractSafety(raw, fetchedAt, now)});
    } catch (error) {
      if (error instanceof RugCheckRateLimited) { rateLimited = true; reportFailure('goldmine', 'contract-safety-rate-limited', error, 'warn'); }
      else reportFailure('goldmine', 'contract-safety', error, 'warn');
      results.push(snapshot);
    }
  }
  return results;
}

export type Scored = {snapshot: CandidateSnapshot; assessment: Assessment};

// Only a candidate that already cleared every hard gate can ever become an opportunity (REJECTED never
// depends on contractSafety), so only those are worth a RugCheck call. Re-scores just those candidates
// after attaching contractSafety; every other candidate's assessment is unchanged.
export async function withContractSafety(scored: Scored[], now = Date.now()): Promise<Scored[]> {
  const actionable = scored.filter(({assessment}) => assessment.state !== 'REJECTED');
  if (!actionable.length) return scored;
  const updated = await attachContractSafety(actionable.map(({snapshot}) => snapshot), now);
  const byAddress = new Map(updated.map(snapshot => [snapshot.address, snapshot]));
  return scored.map(entry => {
    const snapshot = byAddress.get(entry.snapshot.address);
    return snapshot ? {snapshot, assessment: scoreCandidate(snapshot)} : entry;
  });
}
