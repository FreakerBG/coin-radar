// A deliberately conservative *illustration* for manual trades. A planned stop is not guaranteed to fill:
// the spend cap is based on losing the entire token position, including the buy fee and estimated fixed
// transaction costs. No quote, pool depth, execution, wallet, or order is read or written here.
export type TradeRiskInputs = {
  bankrollUsd: number;
  livePoolLiquidityUsd: number;
  maxFullLossPct: number;
  maxPositionPct: number;
  maxPoolSharePct: number;
  plannedStopPct: number;
  buySlippagePct: number;
  sellSlippagePct: number;
  platformFeePctPerSide: number;
  fixedCostsUsd: number;
};

export type TradeRiskResult = {
  fullLossBudgetUsd: number;
  maximumSpendUsd: number;
  fullLossExposureUsd: number;
  plannedStopLossUsd: number;
  stopBasedSpendCapUsd: number;
  bankrollSpendCapUsd: number;
  poolShareSpendCapUsd: number;
  breakEvenRisePct: number | null;
  bindingCap: 'full_loss' | 'bankroll' | 'pool' | 'costs';
};

export function planTradeRisk(input: TradeRiskInputs): TradeRiskResult | null {
  const {bankrollUsd,livePoolLiquidityUsd,maxFullLossPct,maxPositionPct,maxPoolSharePct,plannedStopPct,
    buySlippagePct,sellSlippagePct,platformFeePctPerSide,fixedCostsUsd} = input;
  if (![bankrollUsd,livePoolLiquidityUsd,maxFullLossPct,maxPositionPct,maxPoolSharePct,plannedStopPct,
    buySlippagePct,sellSlippagePct,platformFeePctPerSide,fixedCostsUsd].every(Number.isFinite)) return null;
  if (bankrollUsd <= 0 || bankrollUsd > 1e9 || livePoolLiquidityUsd <= 0 || livePoolLiquidityUsd > 1e12 ||
    maxFullLossPct <= 0 || maxFullLossPct > 100 || maxPositionPct <= 0 || maxPositionPct > 100 ||
    maxPoolSharePct <= 0 || maxPoolSharePct > 100 || plannedStopPct <= 0 || plannedStopPct >= 100 ||
    buySlippagePct < 0 || buySlippagePct >= 100 || sellSlippagePct < 0 || sellSlippagePct >= 100 ||
    platformFeePctPerSide < 0 || platformFeePctPerSide >= 100 || fixedCostsUsd < 0 || fixedCostsUsd > 1e6) return null;

  const buySlip = buySlippagePct / 100, sellSlip = sellSlippagePct / 100;
  const fee = platformFeePctPerSide / 100, stop = plannedStopPct / 100;
  const fullLossBudgetUsd = bankrollUsd * maxFullLossPct / 100;
  const budgetAfterCosts = Math.max(0, fullLossBudgetUsd - fixedCostsUsd);
  const fullLossCap = budgetAfterCosts / (1 + fee);
  const bankrollSpendCapUsd = bankrollUsd * maxPositionPct / 100;
  const poolShareSpendCapUsd = livePoolLiquidityUsd * maxPoolSharePct / 100;
  // Buy slippage reduces acquired tokens; sell slippage, platform fees and the planned price fall reduce
  // proceeds. This stop scenario is informative only and never raises the binding full-loss cap.
  const proceedsAtStop = (1 - stop) * (1 - sellSlip) * (1 - fee) / (1 + buySlip);
  const stopLossFraction = 1 + fee - proceedsAtStop;
  const stopBasedSpendCapUsd = budgetAfterCosts / stopLossFraction;
  const maximumSpendUsd = Math.min(fullLossCap, bankrollSpendCapUsd, poolShareSpendCapUsd);
  const bindingCap = fixedCostsUsd >= fullLossBudgetUsd ? 'costs'
    : maximumSpendUsd === fullLossCap ? 'full_loss'
    : maximumSpendUsd === bankrollSpendCapUsd ? 'bankroll' : 'pool';
  // There is no transaction, and thus no transaction cost, if the cap is zero.
  const fullLossExposureUsd = maximumSpendUsd > 0 ? maximumSpendUsd * (1 + fee) + fixedCostsUsd : 0;
  const plannedStopLossUsd = maximumSpendUsd > 0 ? maximumSpendUsd * stopLossFraction + fixedCostsUsd : 0;
  const breakEvenRisePct = maximumSpendUsd > 0
    ? 100 * (((1 + fee) + fixedCostsUsd / maximumSpendUsd) * (1 + buySlip) / ((1 - sellSlip) * (1 - fee)) - 1)
    : null;
  return {fullLossBudgetUsd,maximumSpendUsd,fullLossExposureUsd,plannedStopLossUsd,
    stopBasedSpendCapUsd,bankrollSpendCapUsd,poolShareSpendCapUsd,breakEvenRisePct,bindingCap};
}
