// Goldmine Momentum Score v2: a deterministic, versioned assessment of one candidate snapshot.
//
// - Six components add up to at most 100 points. Each lists the evidence behind its points. Points come
//   only from inputs that are present and pass a check, so removing an input never raises a score. In
//   particular safety points are earned per risk check, never granted up front and then deducted.
// - Hard gates reject a candidate whose critical market data is missing or whose observable data shows
//   danger (thin liquidity, no sells, a collapse, implausible turnover). A rejected candidate is REJECTED
//   whatever its points. The 5m, 1h and 24h price changes are critical because the overheating check
//   needs all three: a missing one could otherwise hide an OVERHEATED candidate.
// - The market state (EARLY, BUILDING, BREAKOUT, OVERHEATED, DISTRIBUTION) describes what the snapshot
//   shows. It is not a prediction.
// - Opportunity status additionally requires an actionable state, a minimum score, every market risk
//   check assessed (no missing risk input) and verified contract safety. No configured provider supplies contract safety, so it fails closed: no candidate is an
//   opportunity until that evidence exists.
//
// Changing any rule or threshold changes MODEL_VERSION, so stored signals stay comparable per version.
import type {CandidateSnapshot} from './snapshot';

export const MODEL_VERSION = 'momentum-v2.1.0';
export const DISCLAIMER = 'Research signal from provider snapshots, not an executable price, a prediction or financial advice. No outcome or profit is implied.';

export const STATES = ['EARLY', 'BUILDING', 'BREAKOUT', 'OVERHEATED', 'DISTRIBUTION', 'REJECTED'] as const;
export type CandidateState = typeof STATES[number];
const ACTIONABLE: CandidateState[] = ['EARLY', 'BUILDING', 'BREAKOUT'];

export type ComponentId = 'liquidity_volume' | 'volume_acceleration' | 'buyer_pressure' | 'age_valuation' | 'social_momentum' | 'safety_risk';
export type Component = {id: ComponentId; label: string; points: number; max: number; status: 'scored' | 'partial' | 'unavailable'; evidence: string[]};
export type GateCategory = 'data' | 'safety' | 'manipulation' | 'momentum';
export type Gate = {id: string; category: GateCategory; message: string};

export type Assessment = {
  modelVersion: string;
  address: string;
  pair: string;
  symbol: string;
  observedAt: number;
  priceUsd: number | null;
  score: number;
  state: CandidateState;
  opportunity: boolean;
  components: Component[];
  // Why the candidate is REJECTED. Empty unless state is REJECTED.
  rejections: Gate[];
  // Why a candidate that is not rejected is still not an opportunity.
  blockers: Gate[];
  risks: string[];
  summary: string;
  disclaimer: string;
};

// Gates.
export const MIN_LIQUIDITY_USD = 25000;
export const MIN_AGE_MINUTES = 15;
export const MAX_TURNOVER = 100;
export const COLLAPSE_1H_PCT = -40;
export const COLLAPSE_24H_PCT = -60;
export const NO_SELLS_MIN_BUYS = 20;
// Ratios computed from fewer transactions than this are noise and score nothing.
export const MIN_FLOW_TXNS = 20;
export const OPPORTUNITY_MIN_SCORE = 60;
// Cached X evidence older than this is not current momentum.
export const SOCIAL_MAX_AGE_MS = 6 * 3600000;

const round = (value: number, digits = 2) => Number(value.toFixed(digits));
const usd = (value: number) => '$' + Math.round(value).toLocaleString('en-US');
const pct = (value: number) => `${value > 0 ? '+' : ''}${round(value, 1)}%`;
const component = (id: ComponentId, label: string, max: number, points: number, status: Component['status'], evidence: string[]): Component =>
  ({id, label, max, points: Math.max(0, Math.min(max, Math.floor(points))), status, evidence});

// Derived measures shared by components, gates and states. null means "not computable".
export function measures(s: CandidateSnapshot) {
  const h1 = s.txns.h1, h6 = s.txns.h6;
  const h1Total = h1.buys !== null && h1.sells !== null ? h1.buys + h1.sells : null;
  const liquidity = s.liquidityUsd !== null && s.liquidityUsd > 0 ? s.liquidityUsd : null;
  const valuation = s.marketCapUsd ?? s.fdvUsd;
  return {
    h1Total,
    buyShare: h1Total !== null && h1Total >= MIN_FLOW_TXNS ? h1.buys! / h1Total : null,
    turnover: liquidity !== null && s.volumeUsd.h24 !== null ? s.volumeUsd.h24 / liquidity : null,
    // Last hour's volume against the average hour of the last six.
    acceleration: s.volumeUsd.h1 !== null && s.volumeUsd.h6 !== null && s.volumeUsd.h6 > 0 ? s.volumeUsd.h1 / (s.volumeUsd.h6 / 6) : null,
    // Last five minutes, annualized to an hour, against the last hour.
    shortAcceleration: s.volumeUsd.m5 !== null && s.volumeUsd.h1 !== null && s.volumeUsd.h1 > 0 ? s.volumeUsd.m5 * 12 / s.volumeUsd.h1 : null,
    buyerGrowth: h1.buys !== null && h6.buys !== null && h6.buys > 0 ? h1.buys / (h6.buys / 6) : null,
    valuation,
    dilution: s.fdvUsd !== null && s.marketCapUsd !== null && s.marketCapUsd > 0 ? s.fdvUsd / s.marketCapUsd : null,
    valuationToLiquidity: valuation !== null && liquidity !== null ? valuation / liquidity : null,
  };
}
type Measures = ReturnType<typeof measures>;

function liquidityVolume(s: CandidateSnapshot, m: Measures): Component {
  const evidence: string[] = [];
  let points = 0;
  const liquidity = s.liquidityUsd ?? 0;
  const tier = liquidity >= 250000 ? 12 : liquidity >= 100000 ? 10 : liquidity >= 50000 ? 7 : liquidity >= MIN_LIQUIDITY_USD ? 4 : 0;
  points += tier;
  evidence.push(`${usd(liquidity)} reported pool liquidity (+${tier}).`);
  if (s.volumeUsd.h24 === null || m.turnover === null) {
    evidence.push('24h volume is unavailable; volume quality is not scored.');
    return component('liquidity_volume', 'Liquidity and genuine volume', 20, points, 'partial', evidence);
  }
  if (s.volumeUsd.h24 >= 50000) { points += 4; evidence.push(`${usd(s.volumeUsd.h24)} 24h volume (+4).`); }
  else evidence.push(`${usd(s.volumeUsd.h24)} 24h volume is below $50,000 (+0).`);
  if (m.turnover >= 0.5 && m.turnover <= 30) { points += 4; evidence.push(`Turnover ${round(m.turnover)}x liquidity is in the plausible 0.5x-30x band (+4).`); }
  else evidence.push(`Turnover ${round(m.turnover)}x liquidity is outside the plausible 0.5x-30x band; volume may be thin or artificial (+0).`);
  return component('liquidity_volume', 'Liquidity and genuine volume', 20, points, 'scored', evidence);
}

function volumeAcceleration(s: CandidateSnapshot, m: Measures): Component {
  const label = 'Volume acceleration';
  if (m.h1Total === null || m.h1Total < MIN_FLOW_TXNS) {
    return component('volume_acceleration', label, 20, 0, 'unavailable', [`Fewer than ${MIN_FLOW_TXNS} transactions in the last hour; acceleration is not meaningful.`]);
  }
  if (m.acceleration === null) return component('volume_acceleration', label, 20, 0, 'unavailable', ['1h or 6h volume is unavailable.']);
  const evidence: string[] = [];
  const a = m.acceleration;
  const long = a >= 3 ? 12 : a >= 2 ? 9 : a >= 1.3 ? 6 : a >= 1 ? 3 : 0;
  evidence.push(`Last hour's volume is ${round(a)}x the 6h hourly average (+${long}).`);
  let short = 0;
  if (m.shortAcceleration === null) evidence.push('5m volume is unavailable; short-term acceleration is not scored.');
  else {
    short = m.shortAcceleration >= 1.5 ? 8 : m.shortAcceleration >= 1 ? 4 : 0;
    evidence.push(`Last 5 minutes run at ${round(m.shortAcceleration)}x the last hour's pace (+${short}).`);
  }
  return component('volume_acceleration', label, 20, long + short, m.shortAcceleration === null ? 'partial' : 'scored', evidence);
}

function buyerPressure(s: CandidateSnapshot, m: Measures): Component {
  const label = 'Buyer growth and buy/sell balance';
  const caveat = 'Counts are swap transactions, not unique wallets.';
  if (m.buyShare === null) return component('buyer_pressure', label, 20, 0, 'unavailable', [`Fewer than ${MIN_FLOW_TXNS} transactions in the last hour, or counts unavailable.`, caveat]);
  const evidence: string[] = [];
  const share = m.buyShare;
  const balance = share > 0.8 ? 4 : share >= 0.55 ? 10 : share >= 0.5 ? 5 : 0;
  evidence.push(share > 0.8
    ? `${round(share * 100, 0)}% of last-hour swaps are buys: one-sided flow can mean restricted selling or wash buying (+4).`
    : `${round(share * 100, 0)}% of last-hour swaps are buys (+${balance}).`);
  let growth = 0;
  if (m.buyerGrowth === null) evidence.push('6h buy count is unavailable; buyer growth is not scored.');
  else {
    growth = m.buyerGrowth >= 2 ? 10 : m.buyerGrowth >= 1.3 ? 6 : m.buyerGrowth >= 1 ? 3 : 0;
    evidence.push(`Last-hour buys are ${round(m.buyerGrowth)}x the 6h hourly average (+${growth}).`);
  }
  evidence.push(caveat);
  return component('buyer_pressure', label, 20, balance + growth, m.buyerGrowth === null ? 'partial' : 'scored', evidence);
}

function ageValuation(s: CandidateSnapshot, m: Measures): Component {
  const evidence: string[] = [];
  const age = s.ageMinutes;
  const agePoints = age === null ? 0 : age < 60 ? 2 : age < 360 ? 5 : age < 4320 ? 8 : age < 43200 ? 6 : 3;
  if (age === null) evidence.push('Pool age is unavailable (+0).');
  else evidence.push(`Pool age ${age < 120 ? `${Math.floor(age)} minutes` : `${round(age / 60, 1)} hours`} (+${agePoints}).`);
  let valuationPoints = 0;
  if (m.valuation === null) evidence.push('Market cap and FDV are unavailable; valuation is not scored.');
  else if (m.dilution === null) evidence.push('Market cap or FDV is unavailable, so dilution cannot be checked; valuation is not scored (+0).');
  else if (m.dilution > 5) evidence.push(`FDV is ${round(m.dilution, 1)}x market cap: large unreleased supply (+0).`);
  else {
    const v = m.valuation;
    valuationPoints = v < 100000 ? 2 : v < 1e6 ? 7 : v < 1e7 ? 5 : v < 5e7 ? 3 : 1;
    evidence.push(`Valuation ${usd(v)} (+${valuationPoints}).`);
  }
  return component('age_valuation', 'Token age and valuation', 15, agePoints + valuationPoints, m.dilution === null || age === null ? 'partial' : 'scored', evidence);
}

function socialMomentum(s: CandidateSnapshot): Component {
  const label = 'Social momentum';
  if (s.promoted) return component('social_momentum', label, 10, 0, 'scored', ['Paid DEX Screener promotion is active; promotion is not organic momentum (+0).']);
  const social = s.social;
  if (!social) return component('social_momentum', label, 10, 0, 'unavailable', ['No cached X evidence for this contract. Project-supplied links are not counted.']);
  if (s.observedAt - social.fetchedAt > SOCIAL_MAX_AGE_MS) return component('social_momentum', label, 10, 0, 'unavailable', ['Cached X evidence is older than 6 hours.']);
  if (social.sampleSize < 5) return component('social_momentum', label, 10, 0, 'scored', [`Only ${social.sampleSize} recent posts in the cached sample (+0).`]);
  const evidence: string[] = [];
  const authors = social.uniqueAuthors >= 10 ? 6 : social.uniqueAuthors >= 5 ? 3 : 0;
  evidence.push(`${social.uniqueAuthors} distinct authors in a sample of ${social.sampleSize} posts (+${authors}).`);
  const duplicateShare = social.duplicateText / social.sampleSize;
  const originality = duplicateShare < 0.2 ? 4 : duplicateShare < 0.4 ? 2 : 0;
  evidence.push(`${round(duplicateShare * 100, 0)}% repeated text (+${originality}).`);
  evidence.push('A bounded sample, not total mentions; engagement can be manipulated.');
  return component('social_momentum', label, 10, authors + originality, 'scored', evidence);
}

// Market-observable risk checks. Each earns its points only when its input is present and passes: a
// failed check is a risk, and a missing input is unassessed and earns nothing. Seven of the fifteen
// points are reserved for verified contract safety, which no provider supplies yet.
export type RiskCheck = {id: string; points: number; available: boolean; passed: boolean; pass: string; risk: string; missing: string};
export function riskChecks(s: CandidateSnapshot, m: Measures): RiskCheck[] {
  const c = s.priceChangePct;
  const check = (id: string, points: number, value: number | null, passes: (value: number) => boolean, pass: string, risk: string, missing: string): RiskCheck =>
    ({id, points, available: value !== null, passed: value !== null && passes(value), pass, risk, missing});
  return [
    check('reversal', 2, c.h1, v => v <= 50, 'No extreme 1h rise', 'More than 50% rise in one hour: elevated reversal risk', '1h price change unavailable; reversal risk not assessed'),
    check('decline', 1, c.h24, v => v >= -30, 'No severe 24h fall', 'More than 30% fall in 24 hours', '24h price change unavailable; decline not assessed'),
    check('turnover', 1, m.turnover, v => v <= 30, '24h volume at most 30x liquidity', '24h volume above 30x liquidity', 'Turnover unavailable; volume distortion not assessed'),
    check('flow', 1, m.buyShare, v => v <= 0.8, 'Two-sided swap flow', 'One-sided buy flow', 'Too few swaps to assess flow balance'),
    check('dilution', 1, m.dilution, v => v <= 5, 'FDV at most 5x market cap', 'FDV more than 5x market cap', 'Market cap or FDV unavailable; dilution not assessed'),
    check('exit_depth', 1, m.valuationToLiquidity, v => v <= 100, 'Valuation at most 100x pool liquidity', 'Valuation above 100x pool liquidity: thin exit depth', 'Valuation or liquidity unavailable; exit depth not assessed'),
    check('maturity', 1, s.ageMinutes, v => v >= 60, 'Pool at least one hour old', 'Pool younger than one hour', 'Pool age unavailable; maturity not assessed'),
  ];
}

function safetyRisk(s: CandidateSnapshot, checks: RiskCheck[]): Component {
  const evidence: string[] = [];
  let points = 0;
  const contract = s.contractSafety.status === 'verified';
  if (s.contractSafety.status === 'verified') { points += 7; evidence.push(`Contract safety verified by ${s.contractSafety.source} (+7).`); }
  else if (s.contractSafety.status === 'unsafe') evidence.push(`Contract safety checked by ${s.contractSafety.source}: ${s.contractSafety.failedChecks.join('; ')} (+0 of 7).`);
  else evidence.push('Contract safety (mint and freeze authority, holder concentration, LP status) is unavailable (+0 of 7).');
  for (const check of checks) {
    if (check.passed) { points += check.points; evidence.push(`${check.pass} (+${check.points}).`); }
    else evidence.push(`${check.available ? check.risk : check.missing} (+0).`);
  }
  const complete = contract && checks.every(check => check.available);
  return component('safety_risk', 'Safety risk', 15, points, complete ? 'scored' : 'partial', evidence);
}

// Hard gates. Any failure makes the candidate REJECTED.
export function hardGates(s: CandidateSnapshot, m: Measures): Gate[] {
  const gates: Gate[] = [];
  const fail = (id: string, category: GateCategory, message: string) => gates.push({id, category, message});
  if (s.priceUsd === null) fail('missing_price', 'data', 'Price is unavailable.');
  if (s.liquidityUsd === null) fail('missing_liquidity', 'data', 'Pool liquidity is unavailable.');
  if (s.ageMinutes === null) fail('missing_pool_age', 'data', 'Pool creation time is unavailable.');
  if (m.h1Total === null) fail('missing_activity', 'data', 'Last-hour buy and sell counts are unavailable.');
  if (s.volumeUsd.h24 === null) fail('missing_volume', 'data', '24h volume is unavailable.');
  if (s.priceChangePct.m5 === null || s.priceChangePct.h1 === null || s.priceChangePct.h24 === null) fail('missing_price_change', 'data', 'The 5m, 1h or 24h price change is unavailable, so overheating cannot be ruled out.');
  if (s.ageMinutes !== null && s.ageMinutes < MIN_AGE_MINUTES) fail('insufficient_history', 'data', `Pool is younger than ${MIN_AGE_MINUTES} minutes; too little history to assess.`);
  if (s.liquidityUsd !== null && s.liquidityUsd < MIN_LIQUIDITY_USD) fail('thin_liquidity', 'safety', `Liquidity below ${usd(MIN_LIQUIDITY_USD)}: exits may be impossible without a large price impact.`);
  if (s.txns.h1.buys !== null && s.txns.h1.buys >= NO_SELLS_MIN_BUYS && s.txns.h1.sells === 0) fail('sells_absent', 'safety', 'Buys but no sells in the last hour: selling may be restricted (honeypot pattern).');
  const c = s.priceChangePct;
  if ((c.h1 !== null && c.h1 <= COLLAPSE_1H_PCT) || (c.h24 !== null && c.h24 <= COLLAPSE_24H_PCT)) fail('price_collapse', 'safety', `Price collapse: ${c.h1 !== null && c.h1 <= COLLAPSE_1H_PCT ? `${pct(c.h1)} in 1h` : `${pct(c.h24!)} in 24h`}.`);
  if (m.turnover !== null && m.turnover > MAX_TURNOVER) fail('extreme_turnover', 'manipulation', `24h volume is ${round(m.turnover, 0)}x liquidity: wash trading suspected.`);
  return gates;
}

// Market state from the snapshot, in priority order. null when no state's conditions hold.
export function marketState(s: CandidateSnapshot, m: Measures): Exclude<CandidateState, 'REJECTED'> | null {
  const c = s.priceChangePct;
  const h1 = c.h1 ?? 0;
  if ((c.h1 !== null && c.h1 >= 50) || (c.h24 !== null && c.h24 >= 300) || (c.m5 !== null && c.m5 >= 20)) return 'OVERHEATED';
  if (m.buyShare !== null && m.buyShare <= 0.45 && c.h1 !== null && c.h1 < 0) return 'DISTRIBUTION';
  if (m.buyShare === null || c.h1 === null) return null;
  if (h1 >= 10 && m.acceleration !== null && m.acceleration >= 2 && m.buyShare >= 0.55 && (s.liquidityUsd ?? 0) >= 50000) return 'BREAKOUT';
  if (s.ageMinutes !== null && s.ageMinutes < 360 && m.buyShare >= 0.5 && h1 >= 0) return 'EARLY';
  if (m.acceleration !== null && m.acceleration >= 1 && m.buyShare >= 0.5 && h1 >= 0) return 'BUILDING';
  return null;
}

export function scoreCandidate(s: CandidateSnapshot): Assessment {
  const m = measures(s);
  const checks = riskChecks(s, m);
  const components = [liquidityVolume(s, m), volumeAcceleration(s, m), buyerPressure(s, m), ageValuation(s, m), socialMomentum(s), safetyRisk(s, checks)];
  const score = components.reduce((sum, part) => sum + part.points, 0);
  const rejections = hardGates(s, m);
  const phase = rejections.length ? null : marketState(s, m);
  if (!rejections.length && !phase) rejections.push({id: 'no_qualifying_momentum', category: 'momentum', message: 'No early, building or breakout pattern, and no overheating or distribution to report.'});
  const state: CandidateState = rejections.length ? 'REJECTED' : phase!;

  const blockers: Gate[] = [];
  if (state !== 'REJECTED') {
    if (!ACTIONABLE.includes(state)) blockers.push({id: 'state_not_actionable', category: 'momentum', message: `${state} is a risk state, not an entry pattern.`});
    if (score < OPPORTUNITY_MIN_SCORE) blockers.push({id: 'score_below_threshold', category: 'momentum', message: `Score ${score} is below ${OPPORTUNITY_MIN_SCORE}.`});
    const unassessed = checks.filter(check => !check.available);
    if (unassessed.length) blockers.push({id: 'risk_inputs_incomplete', category: 'safety', message: `Risk not fully assessed: ${unassessed.map(check => check.missing).join('; ')}.`});
    if (s.contractSafety.status === 'unsafe') blockers.push({id: 'contract_safety_unverified', category: 'safety', message: 'Contract safety checks failed, so opportunity status fails closed.'});
    else if (s.contractSafety.status !== 'verified') blockers.push({id: 'contract_safety_unverified', category: 'safety', message: 'Contract safety data is unavailable, so opportunity status fails closed.'});
  }
  const opportunity = state !== 'REJECTED' && blockers.length === 0;
  const risks = checks.filter(check => check.available && !check.passed).map(check => `${check.risk}.`);
  const reason = state === 'REJECTED' ? rejections.map(gate => gate.message).join(' ') : opportunity ? 'Passes every gate.' : `Not an opportunity: ${blockers.map(gate => gate.message).join(' ')}`;

  return {
    modelVersion: MODEL_VERSION,
    address: s.address,
    pair: s.pair,
    symbol: s.symbol,
    observedAt: s.observedAt,
    priceUsd: s.priceUsd,
    score,
    state,
    opportunity,
    components,
    rejections,
    blockers,
    risks,
    summary: `${state} · score ${score}/100. ${reason}`,
    disclaimer: DISCLAIMER,
  };
}
