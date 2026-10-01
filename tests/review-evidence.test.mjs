import assert from 'node:assert/strict';
import {test} from 'node:test';
import './helpers/harness.mjs';
const {reviewEvidence,evidenceAge,nearMisses} = await import('../lib/goldmine/review-evidence.ts');
const {emptyReview,reviewStatus} = await import('../lib/manual-review.ts');

test('stored evidence excludes provider text and scores, preserves provenance, false and zero', () => {
  const e = reviewEvidence({source:'dexscreener',observedAt:1000,liquidityUsd:0,marketCapUsd:null,promoted:false,txns:{h1:{buys:0,sells:5}},
    contractSafety:{status:'unsafe',source:'rugcheck',checkedAt:500,facts:{mintAuthorityRenounced:false,lpLockedPct:0,insiderNetworksDetected:0,providerScoreNormalized:2,providerRisks:[{description:'DO NOT LEAK'}],secret:'DO NOT LEAK'}}});
  assert.equal(e.market.checkedAt,1000); assert.equal(e.contract.checkedAt,500);
  assert.equal(e.market.liquidityUsd,0); assert.equal(e.market.marketCapUsd,null);
  assert.equal(e.market.promoted,false); assert.equal(e.market.buys1h,0);
  assert.equal(e.contract.mintAuthorityRenounced,false); assert.equal(e.contract.lpLockedPct,0);
  assert.equal(e.contract.insiderNetworksDetected,0);
  for (const forbidden of ['providerScoreNormalized','providerRisks','DO NOT LEAK','secret']) assert.equal(JSON.stringify(e).includes(forbidden),false);
});
test('unknown, unavailable and unsupported sources never manufacture evidence', () => {
  for (const input of [null,undefined,{},[],{contractSafety:{status:'unavailable',source:'rugcheck',checkedAt:1000,facts:{rugged:false}}},{source:'other',liquidityUsd:9,contractSafety:{status:'verified',source:'other',facts:{rugged:false}}}]) {
    const e = reviewEvidence(input);
    assert.ok(Object.values(e.market).every(v => v === null));
    assert.ok(Object.values(e.contract).every(v => v === null));
  }
});
test('malformed and out-of-range values are unknown; one bad field does not erase valid evidence', () => {
  const e=reviewEvidence({source:'dexscreener',observedAt:Infinity,liquidityUsd:-1,marketCapUsd:'0',txns:{h1:{buys:1.5,sells:4}},promoted:1,
    contractSafety:{source:'rugcheck',status:'verified',checkedAt:-1,facts:{lpLockedPct:101,topHolderPct:-5,topHoldersPct:25,creatorHoldingsPct:NaN,rugged:0,insiderNetworksDetected:2.5}}});
  assert.equal(e.market.checkedAt,null); assert.equal(e.market.liquidityUsd,null); assert.equal(e.market.marketCapUsd,null);
  assert.equal(e.market.buys1h,null); assert.equal(e.market.sells1h,4); assert.equal(e.market.promoted,null);
  assert.equal(e.contract.checkedAt,null); assert.equal(e.contract.lpLockedPct,null); assert.equal(e.contract.topHoldersPct,25);
  assert.equal(e.contract.rugged,null); assert.equal(e.contract.insiderNetworksDetected,null);
});
test('future and missing observation times have unknown age, response download time is irrelevant', () => {
  assert.equal(evidenceAge(null,1000),'Age unknown'); assert.equal(evidenceAge(2000,1000),'Age unknown');
  assert.equal(evidenceAge(1000,61000),'1 minute old'); assert.equal(evidenceAge(1000,3601000),'1 hour old');
});
test('near misses exclude opportunities, risk states and low scores; bound and sort without mutating', () => {
  const signals=[{opportunity:true,state:'BREAKOUT',score:99},{opportunity:false,state:'REJECTED',score:99},
    {opportunity:false,state:'OVERHEATED',score:90},{opportunity:false,state:'EARLY',score:59},
    ...Array.from({length:12},(_,i)=>({opportunity:false,state:'BUILDING',score:60+i,id:i}))];
  const before=structuredClone(signals);const misses=nearMisses(signals);
  assert.equal(misses.length,10);assert.equal(misses[0].score,71);assert.ok(misses.every(s=>!s.opportunity));assert.deepEqual(signals,before);
});
test('manual notes never treat unknown or malformed selections as reviewed and blockers dominate', () => {
  const r=emptyReview();assert.equal(reviewStatus(r).unknown,5);
  r.identity='reviewed';r.contract='blocked';assert.equal(reviewStatus(r).blocked,1);assert.equal(reviewStatus(r).unknown,3);
  const all=Object.fromEntries(Object.keys(r).map(k=>[k,'reviewed']));assert.equal(reviewStatus(all).unknown,0);
  assert.match(reviewStatus(all).label,/not automated verification/);
  all.identity='unexpected';assert.equal(reviewStatus(all).unknown,1);
});

test('evidence from a different mint or pool cannot be attached to a stored signal', () => {
  for(const expected of [{address:'other',pair:'pool'},{address:'mint',pair:'other'}]){
    const e=reviewEvidence({address:'mint',pair:'pool',source:'dexscreener',observedAt:1000,liquidityUsd:100},expected);
    assert.equal(e.market.source,null);assert.equal(e.market.liquidityUsd,null);
  }
});
