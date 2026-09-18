// Candidate snapshot: one token's best pool at one moment, normalized from provider data. It is the
// only input to scoring (lib/goldmine/score.ts) and is stored with every tracked signal, so later
// model versions can re-score exactly what was observed. A value the provider omits, or sends as a
// non-finite, negative or implausible number, is null: scoring treats null as missing evidence, never
// as zero.
export const SNAPSHOT_SCHEMA = 1;

export const WINDOWS = ['m5', 'h1', 'h6', 'h24'] as const;
export type Window = typeof WINDOWS[number];

// Transaction counts per window. They count swaps, not unique wallets.
export type Flow = {buys: number | null; sells: number | null};

// Public X evidence already cached in social_cache (lib/social-cache.ts). Scoring never requests it.
export type SocialEvidence = {sampleSize: number; uniqueAuthors: number; duplicateText: number; fetchedAt: number};

// Contract-level safety evidence (mint and freeze authority, holder concentration, LP status). No
// configured provider supplies it yet: snapshotFromPair always records it as unavailable, which keeps
// opportunity status blocked. 'verified' is the shape a future safety provider must fill.
export type ContractSafety = {status: 'unavailable'; source: null} | {status: 'verified'; source: string};

export type CandidateSnapshot = {
  schema: typeof SNAPSHOT_SCHEMA;
  source: 'dexscreener';
  observedAt: number;
  address: string;
  pair: string;
  dexId: string | null;
  symbol: string;
  name: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  pairCreatedAt: number | null;
  ageMinutes: number | null;
  volumeUsd: Record<Window, number | null>;
  txns: Record<Window, Flow>;
  priceChangePct: Record<Window, number | null>;
  // Paid DEX Screener promotion (a boost). Promotion is never counted as organic momentum.
  promoted: boolean;
  links: {websites: number; socials: number};
  social: SocialEvidence | null;
  contractSafety: ContractSafety;
};

export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// A pool timestamp more than this far in the future is a provider error, not a new pool.
const CLOCK_SKEW_MS = 5 * 60000;

function finite(value: unknown): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}
const amount = (value: unknown) => { const n = finite(value); return n !== null && n >= 0 ? n : null; };
const count = (value: unknown) => { const n = amount(value); return n !== null && Number.isInteger(n) ? n : null; };
// A price change below -100% is impossible.
const change = (value: unknown) => { const n = finite(value); return n !== null && n >= -100 ? n : null; };
// Reads a nested provider field without trusting its shape.
export function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>((node, key) => node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined, value);
}
const text = (value: unknown, fallback: string, max = 60) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback;

export function snapshotFromPair(pair: unknown, observedAt: number, promoted = false): CandidateSnapshot | null {
  const address = at(pair, 'baseToken', 'address'), pairAddress = at(pair, 'pairAddress');
  if (at(pair, 'chainId') !== 'solana' || typeof address !== 'string' || !SOLANA_ADDRESS.test(address)) return null;
  if (typeof pairAddress !== 'string' || !SOLANA_ADDRESS.test(pairAddress)) return null;

  const price = finite(at(pair, 'priceUsd'));
  const created = count(at(pair, 'pairCreatedAt'));
  const pairCreatedAt = created !== null && created <= observedAt + CLOCK_SKEW_MS ? created : null;
  const perWindow = <T>(read: (window: Window) => T) => Object.fromEntries(WINDOWS.map(window => [window, read(window)])) as Record<Window, T>;
  const list = (value: unknown) => Array.isArray(value) ? value.length : 0;

  return {
    schema: SNAPSHOT_SCHEMA,
    source: 'dexscreener',
    observedAt,
    address,
    pair: pairAddress,
    dexId: text(at(pair, 'dexId'), '', 40) || null,
    symbol: text(at(pair, 'baseToken', 'symbol'), '?', 40),
    name: text(at(pair, 'baseToken', 'name'), 'Unknown'),
    priceUsd: price !== null && price > 0 ? price : null,
    liquidityUsd: amount(at(pair, 'liquidity', 'usd')),
    marketCapUsd: amount(at(pair, 'marketCap')),
    fdvUsd: amount(at(pair, 'fdv')),
    pairCreatedAt,
    ageMinutes: pairCreatedAt === null ? null : Math.max(0, (observedAt - pairCreatedAt) / 60000),
    volumeUsd: perWindow(window => amount(at(pair, 'volume', window))),
    txns: perWindow(window => ({buys: count(at(pair, 'txns', window, 'buys')), sells: count(at(pair, 'txns', window, 'sells'))})),
    priceChangePct: perWindow(window => change(at(pair, 'priceChange', window))),
    promoted: promoted || (count(at(pair, 'boosts', 'active')) ?? 0) > 0,
    links: {websites: list(at(pair, 'info', 'websites')), socials: list(at(pair, 'info', 'socials'))},
    social: null,
    contractSafety: {status: 'unavailable', source: null} as ContractSafety,
  };
}

// One snapshot per token: the pool with the most reported liquidity, as the v1 market list chooses.
// A pool without liquidity data ranks below every pool that has it.
export function bestPoolSnapshots(pairs: unknown[], observedAt: number, promoted: Set<string> = new Set()): CandidateSnapshot[] {
  const best = new Map<string, CandidateSnapshot>();
  for (const pair of pairs) {
    const snapshot = snapshotFromPair(pair, observedAt, promoted.has(String(at(pair, 'baseToken', 'address'))));
    if (!snapshot) continue;
    const current = best.get(snapshot.address);
    if (!current || (snapshot.liquidityUsd ?? -1) > (current.liquidityUsd ?? -1)) best.set(snapshot.address, snapshot);
  }
  return [...best.values()];
}

// Reads the public summary of a social_cache row. Anything malformed is treated as no evidence.
export function socialEvidence(data: unknown, fetchedAt: unknown): SocialEvidence | null {
  const sampleSize = count(at(data, 'summary', 'sampleSize')), uniqueAuthors = count(at(data, 'summary', 'uniqueAuthors')), duplicateText = count(at(data, 'summary', 'duplicateText'));
  const fetched = count(fetchedAt);
  if (sampleSize === null || uniqueAuthors === null || duplicateText === null || fetched === null) return null;
  if (uniqueAuthors > sampleSize || duplicateText > sampleSize) return null;
  return {sampleSize, uniqueAuthors, duplicateText, fetchedAt: fetched};
}
