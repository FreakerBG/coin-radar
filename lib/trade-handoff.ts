// The one piece of state passed from a Goldmine signal to the Advisor: which exact mint and which exact
// pool the owner wants to plan around. It is held in the dashboard's memory only (never stored, never sent
// anywhere by itself) and carries no price or amount, so nothing downstream can mistake it for a fill.
import {isSolanaAddress} from './trade-links';
import type {Coin} from './market';

export type TradeTarget = {
  address: string;
  pair: string;
  symbol: string;
  source: 'market' | 'goldmine';
  // Market selections carry the Discover snapshot's liquidity; a Goldmine target does not, because its
  // detection snapshot can be hours old and would be a misleading liquidity-drop baseline.
  liquidity: number | null;
  // Goldmine only: when the signal was recorded, so the Advisor can say how old the evidence is.
  detectedAt?: string;
};

const cleanSymbol = (symbol: unknown) => typeof symbol === 'string' && symbol.trim() ? symbol.trim().slice(0, 40) : '?';

// Null unless both the mint and the pool are valid: a handoff to "some pool of this mint" would let the
// position monitor watch a different market than the one the signal described.
export function goldmineTarget(signal: {address: string; pair: string; symbol: string; detectedAt?: string | number}): TradeTarget | null {
  if (!isSolanaAddress(signal.address) || !isSolanaAddress(signal.pair)) return null;
  const detected = signal.detectedAt === undefined ? NaN : new Date(signal.detectedAt).getTime();
  return {
    address: signal.address, pair: signal.pair, symbol: cleanSymbol(signal.symbol), source: 'goldmine', liquidity: null,
    ...(Number.isFinite(detected) ? {detectedAt: new Date(detected).toISOString()} : {}),
  };
}

export function marketTarget(coin: Coin | null): TradeTarget | null {
  if (!coin || !isSolanaAddress(coin.address) || !isSolanaAddress(coin.pair)) return null;
  return {address: coin.address, pair: coin.pair, symbol: cleanSymbol(coin.symbol), source: 'market', liquidity: coin.liquidity};
}

// Identity for effects and form resets: the same mint on a different pool is a different target.
export const targetKey = (target: TradeTarget | null) => target ? `${target.address}:${target.pair}` : '';

// Evidence counts for a target only when it describes the same mint and pool and is recent; otherwise the
// Advisor would size or baseline a position on another market's numbers.
export const EVIDENCE_FRESH_MS = 90000;
export function evidenceFor<T extends {address: string; pair: string}>(target: TradeTarget | null, fresh: T | null, fetchedAt: number, now: number): T | null {
  if (!target || !fresh || fresh.address !== target.address || fresh.pair !== target.pair) return null;
  return now - fetchedAt < EVIDENCE_FRESH_MS ? fresh : null;
}

export type ManualPosition = {id: string; address: string; pair: string; symbol: string; entryPrice: number; amount: number; entryLiquidity: number | null};

// Builds the body for POST /api/portfolio {action: 'position'}. This is the only way a position is created,
// and it requires the price and amount the owner actually filled at, typed by hand. Opening Axiom or Phantom
// never reaches here. Bounds mirror the route's zod schema so the form can say what is wrong before saving.
export function manualPosition(input: {id: string; target: TradeTarget | null; entryPrice: string; amount: string; entryLiquidity: number | null}): {ok: true; position: ManualPosition} | {ok: false; reason: string} {
  const {target} = input;
  if (!target || !isSolanaAddress(target.address) || !isSolanaAddress(target.pair)) return {ok: false, reason: 'Select a coin first.'};
  const entryPrice = parseDecimal(input.entryPrice);
  const amount = parseDecimal(input.amount);
  if (entryPrice === null || entryPrice <= 0 || entryPrice > 1e9) return {ok: false, reason: 'Enter the actual fill price in USD.'};
  if (amount === null || amount < 0.01 || amount > 1e8) return {ok: false, reason: 'Enter the actual amount spent in USD (at least $0.01).'};
  const liquidity = input.entryLiquidity;
  return {ok: true, position: {
    id: input.id, address: target.address, pair: target.pair, symbol: target.symbol, entryPrice, amount,
    entryLiquidity: typeof liquidity === 'number' && Number.isFinite(liquidity) && liquidity >= 0 ? liquidity : null,
  }};
}

// Plain decimals only. Number('') is 0 and Number('0x10') is 16, so neither may decide what was filled.
function parseDecimal(value: string): number | null {
  const text = value.trim();
  if (!/^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}
