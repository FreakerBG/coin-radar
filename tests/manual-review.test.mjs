import assert from 'node:assert/strict';
import {test} from 'node:test';
import './helpers/harness.mjs';
const {emptyReview,reviewStatus,REVIEW_CHECKS} = await import('../lib/manual-review.ts');

test('manual notes never treat unknown or malformed selections as reviewed and blockers dominate', () => {
  const r=emptyReview();assert.equal(reviewStatus(r).unknown,REVIEW_CHECKS.length);
  r.identity='reviewed';r.contract='blocked';assert.equal(reviewStatus(r).blocked,1);assert.equal(reviewStatus(r).unknown,3);
  assert.match(reviewStatus(r).label,/blocker/);
  const all=Object.fromEntries(Object.keys(r).map(k=>[k,'reviewed']));assert.equal(reviewStatus(all).unknown,0);
  assert.match(reviewStatus(all).label,/not automated verification/);
  all.identity='unexpected';assert.equal(reviewStatus(all).unknown,1);
});

test('a fresh review is a new object, so resetting never shares state with an earlier target', () => {
  const a=emptyReview();a.identity='reviewed';
  assert.equal(emptyReview().identity,'unknown');
});
