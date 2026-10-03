// Pure view logic for the review-evidence panel (app/candidate-evidence.tsx), kept out of JSX so it is
// directly testable with node:test. It formats and labels what lib/goldmine/review-evidence.ts returned;
// it never reclassifies a factor and never turns an unknown into a pass.
import {MODEL_VERSION} from './score';
import {CLOCK_SKEW_MS} from './snapshot';
import type {FactorId, FactorStatus, ReviewEvidence, ReviewFactor} from './review-evidence';

// "Recent" ends where a safety decision itself stops trusting a report (contract-safety.ts
// MAX_FACT_AGE_MS, 15 minutes). Duplicated here only so client code does not import the server-side
// provider module; tests/goldmine-evidence-view.test.mjs pins the two values together.
export const EVIDENCE_RECENT_MS = 15 * 60000;

export type FreshnessTier = 'recent' | 'stale' | 'uncertain' | 'invalid' | 'unknown';
// Worst first. A summary shows the worse of the market and report tiers.
const TIER_ORDER: FreshnessTier[] = ['invalid', 'unknown', 'uncertain', 'stale', 'recent'];

// A timestamp in the future is never recent: within the clock tolerance it is uncertain, beyond it invalid.
export function freshnessTier(asOf: number | null | undefined, now: number): FreshnessTier {
  if (typeof asOf !== 'number' || !Number.isFinite(asOf) || !Number.isFinite(now)) return 'unknown';
  const age = now - asOf;
  if (age < 0) return -age <= CLOCK_SKEW_MS ? 'uncertain' : 'invalid';
  return age <= EVIDENCE_RECENT_MS ? 'recent' : 'stale';
}
export const worseTier = (a: FreshnessTier, b: FreshnessTier): FreshnessTier => TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b;

export const TIER_LABEL: Record<FreshnessTier, string> = {
  recent: 'recent snapshot',
  stale: 'past snapshot',
  uncertain: 'time uncertain',
  invalid: 'time invalid',
  unknown: 'time unknown',
};
export const TIER_SENTENCE: Record<FreshnessTier, string> = {
  recent: 'Recent snapshot, still not a live quote.',
  stale: 'Past snapshot. Liquidity, holders, authorities and price can change within minutes. Recheck the live pool in Axiom before any order.',
  uncertain: 'Time uncertain (a clock difference puts it slightly in the future). Treat it as a past snapshot.',
  invalid: 'Time invalid (in the future). Treat these values as unverified.',
  unknown: 'Time unknown. Treat these values as unverified.',
};

// Age without implying precision. Future times are not given an age.
export function ageLabel(asOf: number | null | undefined, now: number): string {
  const tier = freshnessTier(asOf, now);
  if (tier === 'unknown' || tier === 'invalid' || tier === 'uncertain') return TIER_LABEL[tier];
  const minutes = Math.floor((now - (asOf as number)) / 60000);
  if (minutes < 1) return 'under a minute ago';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

// Never "safe", "passed" or "verified": a factor row only says what the stored record shows.
export const STATUS_LABEL: Record<FactorStatus | 'manual', string> = {
  fails_check: 'Failed Coin Radar check at scan',
  within_check: 'Within check at scan',
  recorded: 'Recorded',
  not_measured: 'Not measured',
  manual: 'Check in Axiom',
};

type FactorMeta = {label: string; group: 'Contract and supply' | 'Market and liquidity' | 'Age and activity' | 'Social'; unit: 'usd' | 'pct' | 'signed_pct' | 'minutes' | 'count' | 'renounced' | 'yes_no'; note: string};
export const FACTOR_META: Record<FactorId, FactorMeta> = {
  mint_authority: {label: 'Mint authority', group: 'Contract and supply', unit: 'renounced', note: 'Token-2022 extension authorities are not covered.'},
  freeze_authority: {label: 'Freeze authority', group: 'Contract and supply', unit: 'renounced', note: ''},
  lp_locked: {label: 'LP locked', group: 'Contract and supply', unit: 'pct', note: 'Liquidity-weighted across reported markets. LP burned rather than locked may read as unlocked.'},
  largest_holder: {label: 'Largest holder', group: 'Contract and supply', unit: 'pct', note: 'Largest owner among RugCheck’s listed holders. Pool and locker accounts are not excluded.'},
  top_holders: {label: 'Listed top holders, combined', group: 'Contract and supply', unit: 'pct', note: 'Not necessarily ten wallets, so not comparable to Axiom’s Top 10 Holders %.'},
  creator_holding: {label: 'Creator wallet holding', group: 'Contract and supply', unit: 'pct', note: 'The creator wallet only. Other developer-linked wallets and past developer selling are not measured.'},
  insider_networks: {label: 'Insider networks found', group: 'Contract and supply', unit: 'count', note: 'A count, not Axiom’s Insiders %. It can miss relationships.'},
  rugged_flag: {label: 'Recorded as rugged', group: 'Contract and supply', unit: 'yes_no', note: 'RugCheck’s own determination.'},
  liquidity_usd: {label: 'Pool liquidity', group: 'Market and liquidity', unit: 'usd', note: 'Reported pool size, not executable depth for your order.'},
  market_cap_usd: {label: 'Market cap', group: 'Market and liquidity', unit: 'usd', note: 'Not substituted by FDV when missing.'},
  fdv_usd: {label: 'FDV', group: 'Market and liquidity', unit: 'usd', note: ''},
  volume_h1_usd: {label: 'Volume · 1 h', group: 'Market and liquidity', unit: 'usd', note: 'Volume can be washed.'},
  volume_h24_usd: {label: 'Volume · 24 h', group: 'Market and liquidity', unit: 'usd', note: ''},
  pool_age_minutes: {label: 'Pool age at scan', group: 'Age and activity', unit: 'minutes', note: 'Pool creation, not token creation; for a migrated token this is about the migration time.'},
  buys_h1: {label: 'Buys · 1 h', group: 'Age and activity', unit: 'count', note: 'Swaps, not unique wallets.'},
  sells_h1: {label: 'Sells · 1 h', group: 'Age and activity', unit: 'count', note: 'Swaps in the scan’s last hour. Sellability for your order is unverified.'},
  price_change_h1: {label: 'Price change · 1 h', group: 'Age and activity', unit: 'signed_pct', note: ''},
  price_change_h24: {label: 'Price change · 24 h', group: 'Age and activity', unit: 'signed_pct', note: ''},
  paid_promotion: {label: 'Paid DEX Screener promotion', group: 'Age and activity', unit: 'yes_no', note: 'Promotion is never counted as momentum.'},
  website_links: {label: 'Website links', group: 'Social', unit: 'count', note: 'Supplied by the project. Presence is not authenticity.'},
  social_links: {label: 'Social links', group: 'Social', unit: 'count', note: 'Supplied by the project. Presence is not authenticity.'},
  x_distinct_authors: {label: 'Distinct X authors in cached sample', group: 'Social', unit: 'count', note: 'Only exists if an X search was run from the Advisor. A bounded sample, not followers or reach.'},
};
export const FACTOR_GROUPS = ['Contract and supply', 'Market and liquidity', 'Age and activity', 'Social'] as const;

// Coin Radar cannot measure these at all. They are named so the gap is explicit, never implied covered.
export const MANUAL_CHECKS = [
  'Dev Holding %', 'Insiders %', 'Snipers %', 'Bundle %', 'Holders', 'Pro Traders',
  'Developer selling and wallets funded by the developer',
  'Follower authenticity and independent discussion',
  'Transfer fee, mutable metadata and Token-2022 extensions',
] as const;

const usd = (n: number) => '$' + new Intl.NumberFormat('en-US', {maximumFractionDigits: n >= 100 ? 0 : 2}).format(n);
export function factorValue(factor: ReviewFactor): string {
  const {value} = factor;
  if (value === null) return '—';
  const unit = FACTOR_META[factor.id].unit;
  if (typeof value === 'boolean') {
    if (unit === 'renounced') return value ? 'Renounced' : 'Active';
    return value ? 'Yes' : 'No';
  }
  if (unit === 'usd') return usd(value);
  if (unit === 'pct') return `${Math.round(value * 10) / 10}%`;
  if (unit === 'signed_pct') return `${value > 0 ? '+' : ''}${Math.round(value * 10) / 10}%`;
  if (unit === 'minutes') return value < 120 ? `${Math.floor(value)} min` : value < 2880 ? `${Math.round(value / 6) / 10} h` : `${Math.floor(value / 1440)} days`;
  return new Intl.NumberFormat('en-US').format(value);
}

export function safetyReportTier(evidence: ReviewEvidence, now: number): FreshnessTier | null {
  return evidence.safety.status === 'unavailable' ? null : freshnessTier(evidence.safety.reportAt, now);
}
// The worse of the two timestamps. A missing report does not make the market snapshot any older; the
// summary's "not verified" count already says the report is missing.
export function evidenceTier(evidence: ReviewEvidence, now: number): FreshnessTier {
  const market = freshnessTier(evidence.marketObservedAt, now);
  const report = safetyReportTier(evidence, now);
  return report === null ? market : worseTier(market, report);
}

const plural = (count: number, one: string, many = one + 's') => `${count} ${count === 1 ? one : many}`;
export function summaryLine(evidence: ReviewEvidence | null | undefined, now: number): string {
  if (!evidence) return 'Evidence details were not included in this response. Treat every value as unverified.';
  if (!evidence.readable) return 'Recorded snapshot unreadable. Treat every value as unverified.';
  const unmeasured = evidence.factors.filter(factor => factor.status === 'not_measured').length + MANUAL_CHECKS.length;
  const tier = evidenceTier(evidence, now);
  const age = tier === 'recent' || tier === 'stale' ? `snapshot ${ageLabel(evidence.marketObservedAt, now)} (${TIER_LABEL[tier]})` : TIER_LABEL[tier];
  return [
    plural(evidence.hardFailures.length, 'hard failure') + ' recorded',
    plural(evidence.notVerified.length, 'item') + ' not verified',
    plural(evidence.flags.length, 'research flag'),
    `${unmeasured} not measured`,
    age,
  ].join(' · ');
}

// Near misses are drawn only from the signals GET /api/goldmine already returns (its fixed 50-row read):
// current model, not REJECTED, not an opportunity, newest first, one per mint and pool. No extra query.
// The size of that read (lib/goldmine/signals.ts readTracking, `LIMIT 50`), for UI copy only.
// tests/goldmine-route.test.mjs pins it to what GET actually returns.
export const RECENT_SIGNALS_READ = 50;
export const NEAR_MISS_DISPLAY_LIMIT = 10;
export function nearMisses<T extends {address: string; pair: string; modelVersion?: string; state: string; opportunity: boolean; detectedAt: string}>(signals: T[]): T[] {
  const seen = new Set<string>();
  const time = (value: string) => { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; };
  const newest = [...signals].sort((a, b) => time(b.detectedAt) - time(a.detectedAt));
  return newest.filter(signal => {
    if (signal.modelVersion !== MODEL_VERSION || signal.state === 'REJECTED' || signal.opportunity) return false;
    const key = `${signal.address}:${signal.pair}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
