// Review evidence (Stage 09A): the deliberately scoped, client-facing view of what a recorded signal's
// snapshot contained and how its *stored* assessment classified it. docs/goldmine-intelligence.md
// section 6 reserved exactly this: a deeper view is a new field, never a widening of
// ContractSafetySummary, which stays the minimal badge shape it has always been.
//
// Rules this module keeps:
// - Nothing is rescored. Failure classifications come only from the stored assessment's own gates (its
//   rejections, blockers and risks) and the contract-safety result stored beside it (status and
//   failedChecks, written by lib/goldmine/contract-safety.ts at detection). No current threshold is
//   applied to a past fact, so a signal recorded under another model version keeps the classification
//   that model gave it.
// - Allow-list only. From RugCheck: our own derived numbers and booleans and the report time. Never the
//   provider's score, its risk list or any provider-authored description. Every string sent here is one
//   of our own messages that is already client-facing (Gate messages, assessment risks, failedChecks,
//   which contractSafetySummary already joins into `reason`).
// - Unknown is never a pass. A missing, malformed or partial value is `not_measured`; a fact reads
//   `within_check` only when the stored result proves its check passed at detection.
// - Pure and defensive: any input shape returns a value, never throws.
import {at, clientCheckMessage} from './snapshot';

export const REVIEW_EVIDENCE_VERSION = 1;

export type FactorStatus = 'fails_check' | 'within_check' | 'recorded' | 'not_measured';
export type FactorSource = 'dexscreener' | 'rugcheck' | 'x_cache';
export const FACTOR_IDS = [
  // Contract and supply (RugCheck report, `asOf` = report time)
  'mint_authority', 'freeze_authority', 'lp_locked', 'largest_holder', 'top_holders', 'creator_holding', 'insider_networks', 'rugged_flag',
  // Market and liquidity (DEX Screener snapshot, `asOf` = snapshot time)
  'liquidity_usd', 'market_cap_usd', 'fdv_usd', 'volume_h1_usd', 'volume_h24_usd',
  // Age and activity
  'pool_age_minutes', 'buys_h1', 'sells_h1', 'price_change_h1', 'price_change_h24', 'paid_promotion',
  // Social
  'website_links', 'social_links', 'x_distinct_authors',
] as const;
export type FactorId = typeof FACTOR_IDS[number];
export type ReviewFactor = {id: FactorId; value: number | boolean | null; status: FactorStatus; source: FactorSource; asOf: number | null};

// Why contract safety is `unavailable`. The stored record cannot tell budget, cooldown, a stale report or
// a missing fact apart (contract-safety.ts keeps no facts for any of them), so the second reason says so.
export type SafetyUnavailableReason = 'not_checked_rejected' | 'not_checked_or_incomplete';

export type ReviewEvidence = {
  version: typeof REVIEW_EVIDENCE_VERSION;
  // False when the stored snapshot could not be read at all. Every factor is then not_measured.
  readable: boolean;
  modelVersion: string | null;
  state: string | null;
  marketObservedAt: number | null;
  safety: {status: 'verified' | 'unsafe' | 'unavailable'; reportAt: number | null; unavailableReason: SafetyUnavailableReason | null};
  // Stored reasons, grouped. Each is one of our own messages, verbatim, in stored order.
  hardFailures: string[];
  notVerified: string[];
  flags: string[];
  factors: ReviewFactor[];
};

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const nonNegative = (value: unknown): number | null => { const n = finite(value); return n !== null && n >= 0 ? n : null; };
const pct = (value: unknown): number | null => { const n = finite(value); return n !== null && n >= 0 && n <= 100 ? n : null; };
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
const MAX_MESSAGE = 300;
const clip = (message: string) => message.length > MAX_MESSAGE ? message.slice(0, MAX_MESSAGE - 1) + '…' : message;

type StoredGate = {id: string; category: string | null; message: string};
function gates(value: unknown): StoredGate[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap(gate => isObject(gate) && typeof gate.id === 'string' && typeof gate.message === 'string'
    ? [{id: gate.id, category: typeof gate.category === 'string' ? gate.category : null, message: gate.message}]
    : []);
}

// Maps a stored failedChecks message to the fact it is about. These are lib/goldmine/contract-safety.ts's
// own messages. A message that matches none of them (a future or older wording) is still shown as a hard
// failure; it only stops this module from inferring that any *other* fact passed (see contractFactors).
const FAILED_CHECK_FACTS: [RegExp, FactorId[]][] = [
  [/^Mint authority /, ['mint_authority']],
  [/^Freeze authority /, ['freeze_authority']],
  [/of LP is locked|^LP lock /, ['lp_locked']],
  [/^Holder concentration /, ['largest_holder', 'top_holders']],
  [/^Creator hold/, ['creator_holding']],
  [/^Insider network /, ['insider_networks']],
  [/recorded this contract as rugged/, ['rugged_flag']],
  [/danger-level risk/, []],
];

// contractSafetySummary's own fallback wording for an unsafe record without usable messages. It matches
// no FAILED_CHECK_FACTS pattern on purpose, so no other fact is ever inferred to have passed.
const UNSAFE_WITHOUT_DETAIL = 'Contract safety checks failed.';

type StoredSafety = {status: 'verified' | 'unsafe' | 'unavailable'; reportAt: number | null; facts: Record<string, unknown> | null; failedChecks: string[]};
function storedSafety(value: unknown): StoredSafety {
  const status = isObject(value) ? value.status : undefined;
  const reportAt = isObject(value) ? finite(value.checkedAt) : null;
  const facts = isObject(value) && isObject(value.facts) ? value.facts : null;
  // Same reading as contractSafetySummary, so the badge and this view never disagree about the status:
  // anything not recognizably verified or unsafe is unavailable. A malformed verified or unsafe record
  // keeps its status but contributes no facts it does not actually carry (they read not_measured).
  if (status === 'unsafe') {
    const failedChecks = strings(isObject(value) ? value.failedChecks : null).map(clientCheckMessage).map(clip);
    return {status, reportAt, facts, failedChecks: failedChecks.length ? failedChecks : [UNSAFE_WITHOUT_DETAIL]};
  }
  if (status === 'verified') return {status, reportAt, facts, failedChecks: []};
  return {status: 'unavailable', reportAt: null, facts: null, failedChecks: []};
}

function contractFactors(safety: StoredSafety): ReviewFactor[] {
  const facts = safety.facts ?? {};
  const values: Record<string, number | boolean | null> = {
    mint_authority: bool(facts.mintAuthorityRenounced),
    freeze_authority: bool(facts.freezeAuthorityRenounced),
    lp_locked: pct(facts.lpLockedPct),
    largest_holder: pct(facts.topHolderPct),
    top_holders: pct(facts.topHoldersPct),
    creator_holding: pct(facts.creatorHoldingsPct),
    insider_networks: nonNegative(facts.insiderNetworksDetected),
    rugged_flag: bool(facts.rugged),
  };
  const failed = new Set<FactorId>();
  let everyFailureRecognized = true;
  for (const message of safety.failedChecks) {
    const match = FAILED_CHECK_FACTS.find(([pattern]) => pattern.test(message));
    if (!match) everyFailureRecognized = false;
    else match[1].forEach(id => failed.add(id));
  }
  const holderCheckFailed = failed.has('largest_holder');
  const ids: FactorId[] = ['mint_authority', 'freeze_authority', 'lp_locked', 'largest_holder', 'top_holders', 'creator_holding', 'insider_networks', 'rugged_flag'];
  return ids.map(id => {
    const value = values[id] ?? null;
    let status: FactorStatus;
    if (safety.status === 'unavailable' || value === null) status = 'not_measured';
    // Verified is stored only when every one of the checks was available and passed at detection.
    else if (safety.status === 'verified') status = 'within_check';
    // The stored holder check combines both limits into one message, so which one failed is not
    // recorded. Neither value is claimed to be inside or outside its limit.
    else if (holderCheckFailed && (id === 'largest_holder' || id === 'top_holders')) status = 'recorded';
    else if (failed.has(id)) status = 'fails_check';
    // Unsafe lists every available check that failed. A present fact that is not among them passed,
    // but only when every stored message was understood; otherwise make no claim.
    else status = everyFailureRecognized ? 'within_check' : 'recorded';
    return {id, value, status, source: 'rugcheck' as const, asOf: safety.status === 'unavailable' ? null : safety.reportAt};
  });
}

// DEX Screener values are recorded, never re-judged against today's gates. A factor is marked as failing
// only when the stored assessment itself carries the rejection that names it.
const REJECTION_FACTOR: Record<string, FactorId> = {thin_liquidity: 'liquidity_usd', sells_absent: 'sells_h1'};

function marketFactors(snapshot: Record<string, unknown> | null, rejections: StoredGate[]): ReviewFactor[] {
  const observedAt = snapshot ? finite(snapshot.observedAt) : null;
  const read = (...path: string[]) => snapshot ? at(snapshot, ...path) : undefined;
  const failedIds = new Set(rejections.map(gate => REJECTION_FACTOR[gate.id]).filter(Boolean));
  const market = (id: FactorId, value: number | boolean | null): ReviewFactor => ({
    id, value, source: 'dexscreener', asOf: value === null ? null : observedAt,
    status: value === null ? 'not_measured' : failedIds.has(id) ? 'fails_check' : 'recorded',
  });
  const socialAt = nonNegative(read('social', 'fetchedAt'));
  const authors = nonNegative(read('social', 'uniqueAuthors'));
  return [
    market('liquidity_usd', nonNegative(read('liquidityUsd'))),
    // Never substituted by FDV: a missing market cap is shown as missing.
    market('market_cap_usd', nonNegative(read('marketCapUsd'))),
    market('fdv_usd', nonNegative(read('fdvUsd'))),
    market('volume_h1_usd', nonNegative(read('volumeUsd', 'h1'))),
    market('volume_h24_usd', nonNegative(read('volumeUsd', 'h24'))),
    market('pool_age_minutes', nonNegative(read('ageMinutes'))),
    market('buys_h1', nonNegative(read('txns', 'h1', 'buys'))),
    market('sells_h1', nonNegative(read('txns', 'h1', 'sells'))),
    market('price_change_h1', finite(read('priceChangePct', 'h1'))),
    market('price_change_h24', finite(read('priceChangePct', 'h24'))),
    market('paid_promotion', bool(read('promoted'))),
    market('website_links', nonNegative(read('links', 'websites'))),
    market('social_links', nonNegative(read('links', 'socials'))),
    {id: 'x_distinct_authors', value: authors, source: 'x_cache', asOf: authors === null ? null : socialAt, status: authors === null || socialAt === null ? 'not_measured' : 'recorded'},
  ];
}

// Identity: when the caller knows which mint and pool a record is for, a stored snapshot naming any other
// mint or pool is treated as unreadable, so evidence can never be shown under the wrong token or pool.
export function reviewEvidence(snapshotValue: unknown, assessmentValue: unknown, identity?: {address: string; pair: string}): ReviewEvidence {
  const matches = !identity || (isObject(snapshotValue) && snapshotValue.address === identity.address && snapshotValue.pair === identity.pair);
  const snapshot = matches && isObject(snapshotValue) ? snapshotValue : null;
  const assessment = isObject(assessmentValue) ? assessmentValue : null;
  const state = assessment && typeof assessment.state === 'string' ? assessment.state : null;
  const rejections = gates(assessment?.rejections);
  const blockers = gates(assessment?.blockers);
  const safety = storedSafety(snapshot?.contractSafety);

  const hardFailures: string[] = [], notVerified: string[] = [], flags: string[] = [];
  // Rejections are hard gates. Missing data is "not verified"; a momentum rejection is a flag; any
  // safety, manipulation or unrecognized category is a hard failure, since unknown must never soften.
  for (const gate of rejections) {
    if (gate.category === 'data') notVerified.push(clip(gate.message));
    else if (gate.category === 'momentum') flags.push(clip(gate.message));
    else hardFailures.push(clip(gate.message));
  }
  // Stored at detection by the checker itself: never recomputed from the facts.
  hardFailures.push(...safety.failedChecks);
  for (const gate of blockers) {
    // The contract blocker is represented by the stored failedChecks (unsafe) or the reason below
    // (unavailable), so its generic message is not repeated.
    if (gate.id === 'contract_safety_unverified') continue;
    if (gate.category === 'momentum') flags.push(clip(gate.message));
    else notVerified.push(clip(gate.message));
  }
  let unavailableReason: SafetyUnavailableReason | null = null;
  if (safety.status === 'unavailable') {
    unavailableReason = state === 'REJECTED' ? 'not_checked_rejected' : 'not_checked_or_incomplete';
    notVerified.push(unavailableReason === 'not_checked_rejected'
      ? 'Contract safety was not checked: RugCheck runs only for candidates that pass the hard gates.'
      : 'No complete RugCheck report was attached at scan (budget, cooldown, a stale report or a missing fact; the record cannot tell which).');
  }
  // Failed market risk checks, as the stored model worded them.
  flags.push(...strings(assessment?.risks).map(clip));
  if (snapshot && snapshot.promoted === true) flags.push('Paid DEX Screener promotion was active at scan.');

  return {
    version: REVIEW_EVIDENCE_VERSION,
    readable: snapshot !== null,
    modelVersion: assessment && typeof assessment.modelVersion === 'string' ? assessment.modelVersion : null,
    state,
    marketObservedAt: snapshot ? finite(snapshot.observedAt) : null,
    safety: {status: safety.status, reportAt: safety.status === 'unavailable' ? null : safety.reportAt, unavailableReason},
    hardFailures, notVerified, flags,
    factors: [...contractFactors(safety), ...marketFactors(snapshot, rejections)],
  };
}
