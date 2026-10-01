// Session-local manual observations. Completion is not a safety verdict or permission to trade.
export const REVIEW_CHECKS = [
  {id: 'identity', label: 'Exact Solana mint and pool', hint: 'Match both addresses in the trading app; symbols alone are not identity.'},
  {id: 'contract', label: 'Authorities, holders and LP', hint: 'Reopen RugCheck and check current authorities, concentration and LP status.'},
  {id: 'wallets', label: 'Wallet relationships and audience', hint: 'Inspect dev holdings, insiders, snipers, bundles and independent discussion. Record missing evidence as unknown.'},
  {id: 'execution', label: 'Liquidity and exit route', hint: 'Inspect current liquidity, recent sells and your own route preview; a preview does not guarantee a future exit.'},
  {id: 'costs', label: 'Full-loss budget, fees and slippage', hint: 'Use the position planner and inspect actual order costs in Axiom or Phantom.'},
] as const;
export type ReviewId = typeof REVIEW_CHECKS[number]['id'];
export type ReviewChoice = 'unknown' | 'reviewed' | 'blocked';
export type ManualReview = Record<ReviewId, ReviewChoice>;
export const emptyReview = (): ManualReview => Object.fromEntries(REVIEW_CHECKS.map(c => [c.id, 'unknown'])) as ManualReview;
export function reviewStatus(review: ManualReview): {label: string; unknown: number; blocked: number} {
  const choices = REVIEW_CHECKS.map(c => review[c.id]);
  const blocked = choices.filter(v => v === 'blocked').length;
  const unknown = choices.filter(v => v !== 'reviewed' && v !== 'blocked').length;
  return {blocked, unknown, label: blocked ? 'Manual blocker recorded' : unknown ? 'Review incomplete · unknown evidence' : 'Manual review noted · not automated verification'};
}
