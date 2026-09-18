// Pure view logic for the Goldmine dashboard panel (lib/goldmine/dashboard-view.ts). No React, no
// network, no D1 - deterministic classification of already-fetched API data.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

const {isStale, opportunitiesOf, scanState, STALE_AFTER_MS} = await import('../lib/goldmine/dashboard-view.ts');

const NOW = Date.UTC(2026, 8, 18, 12, 0, 0);

function candidate(overrides = {}) {
  return {
    opportunity: false,
    address: 'TokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    state: 'REJECTED',
    score: 0,
    snapshot: {contractSafety: {status: 'unavailable', source: null}},
    ...overrides,
  };
}

describe('isStale', () => {
  test('no scan yet (null asOf) is not stale - that is the idle state', () => {
    assert.equal(isStale(null, NOW), false);
  });
  test('exactly at the boundary is not yet stale; one millisecond past it is', () => {
    const asOf = new Date(NOW - STALE_AFTER_MS).toISOString();
    assert.equal(isStale(asOf, NOW), false);
    const justPast = new Date(NOW - STALE_AFTER_MS - 1).toISOString();
    assert.equal(isStale(justPast, NOW), true);
  });
  test('a well-formed recent timestamp is fresh', () => {
    assert.equal(isStale(new Date(NOW - 1000).toISOString(), NOW), false);
  });
  test('an unparseable timestamp is treated as stale, never as fresh', () => {
    assert.equal(isStale('not-a-date', NOW), true);
  });
});

describe('opportunitiesOf: only what the backend itself marked an opportunity', () => {
  test('excludes every candidate the backend did not mark opportunity:true, whatever its contractSafety says', () => {
    const list = [
      candidate({opportunity: false, address: 'A', snapshot: {contractSafety: {status: 'unsafe', source: 'rugcheck'}}}),
      candidate({opportunity: false, address: 'B', snapshot: {contractSafety: {status: 'unavailable', source: null}}}),
      candidate({opportunity: true, address: 'C', snapshot: {contractSafety: {status: 'verified', source: 'rugcheck'}}}),
    ];
    assert.deepEqual(opportunitiesOf(list).map(c => c.address), ['C']);
  });
  test('never recomputes the decision from contractSafety: it only reads the opportunity flag the API already decided', () => {
    // This shape cannot occur from the real API (the opportunity gate requires verified contractSafety),
    // but the panel must not independently second-guess the flag either way - it defers to the backend.
    const adversarial = candidate({opportunity: true, address: 'X', snapshot: {contractSafety: {status: 'unsafe', source: 'rugcheck'}}});
    assert.deepEqual(opportunitiesOf([adversarial]).map(c => c.address), ['X']);
  });
  test('an empty list stays empty', () => {
    assert.deepEqual(opportunitiesOf([]), []);
  });
});

describe('scanState: one classification, in a fixed precedence order', () => {
  test('loading wins over every other input', () => {
    assert.equal(scanState({loading: true, error: 'boom', status: 'busy', opportunityCount: 5}), 'loading');
  });
  test('error is reported once loading has finished', () => {
    assert.equal(scanState({loading: false, error: 'Network unreachable', status: null, opportunityCount: 0}), 'error');
  });
  test('no scan run yet this session is idle, distinct from an empty successful scan', () => {
    assert.equal(scanState({loading: false, error: null, status: null, opportunityCount: 0}), 'idle');
  });
  test('the scan lock being held by another scan is its own state, not an error', () => {
    assert.equal(scanState({loading: false, error: null, status: 'busy', opportunityCount: 0}), 'busy');
  });
  test('a provider outage is its own state, distinct from a genuinely empty result', () => {
    assert.equal(scanState({loading: false, error: null, status: 'provider_unavailable', opportunityCount: 0}), 'unavailable');
  });
  test('a completed scan with no qualifying opportunities is empty, not an error', () => {
    assert.equal(scanState({loading: false, error: null, status: 'checked', opportunityCount: 0}), 'empty');
  });
  test('a completed scan with qualifying opportunities reports them', () => {
    assert.equal(scanState({loading: false, error: null, status: 'checked', opportunityCount: 3}), 'opportunities');
  });
});
