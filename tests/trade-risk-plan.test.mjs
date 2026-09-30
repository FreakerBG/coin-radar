import assert from 'node:assert/strict';
import test from 'node:test';
import {planTradeRisk} from '../lib/trade-risk-plan.ts';

const inputs = {
  bankrollUsd: 1000, livePoolLiquidityUsd: 50000, maxFullLossPct: 0.5,
  maxPositionPct: 5, maxPoolSharePct: 1, plannedStopPct: 20,
  buySlippagePct: 1, sellSlippagePct: 1, platformFeePctPerSide: 0.95,
  fixedCostsUsd: 0.5,
};

test('full loss, including the buy fee and fixed costs, sets the binding cap', () => {
  const plan = planTradeRisk(inputs);
  assert.ok(plan);
  assert.equal(plan.bindingCap, 'full_loss');
  assert.equal(plan.fullLossBudgetUsd, 5);
  assert.ok(Math.abs(plan.maximumSpendUsd - 4.5 / 1.0095) < 1e-10);
  assert.ok(Math.abs(plan.fullLossExposureUsd - 5) < 1e-10);
  assert.ok(plan.stopBasedSpendCapUsd > plan.maximumSpendUsd);
  assert.ok(plan.plannedStopLossUsd < plan.fullLossBudgetUsd);
  assert.ok(plan.breakEvenRisePct > 0);
});

test('pool share and position caps can lower the spend without raising the loss', () => {
  const pool = planTradeRisk({...inputs,livePoolLiquidityUsd: 100,maxPoolSharePct: 1});
  assert.equal(pool?.bindingCap, 'pool');
  assert.equal(pool.maximumSpendUsd, 1);
  assert.ok(pool.fullLossExposureUsd < pool.fullLossBudgetUsd);
  const position = planTradeRisk({...inputs,maxPositionPct: 0.1});
  assert.equal(position?.bindingCap, 'bankroll');
  assert.equal(position.maximumSpendUsd, 1);
});

test('fixed costs consuming the loss budget recommend no spend', () => {
  const plan = planTradeRisk({...inputs,fixedCostsUsd: 5});
  assert.equal(plan?.bindingCap, 'costs');
  assert.equal(plan.maximumSpendUsd, 0);
  assert.equal(plan.breakEvenRisePct, null);
});

test('rejects incomplete, negative, extreme and impossible scenarios', () => {
  for (const changes of [
    {bankrollUsd: NaN}, {livePoolLiquidityUsd: 0}, {maxFullLossPct: 101},
    {plannedStopPct: 100}, {buySlippagePct: -1}, {sellSlippagePct: 100},
    {fixedCostsUsd: Infinity}, {maxPoolSharePct: 0},
  ]) assert.equal(planTradeRisk({...inputs,...changes}), null);
});

test('higher fees, slippage and network costs increase the break-even hurdle', () => {
  const base = planTradeRisk({...inputs,buySlippagePct: 0,sellSlippagePct: 0,platformFeePctPerSide: 0,fixedCostsUsd: 0});
  const expensive = planTradeRisk(inputs);
  assert.equal(base?.breakEvenRisePct, 0);
  assert.ok(expensive.breakEvenRisePct > base.breakEvenRisePct);
});
