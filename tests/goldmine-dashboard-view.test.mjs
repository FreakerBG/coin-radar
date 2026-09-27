// Pure view logic for the Goldmine dashboard panel (lib/goldmine/dashboard-view.ts). No React, no
// network, no D1 - deterministic classification of already-fetched API data.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

const {BATCH_OVERDUE_AFTER_MS, isLatestBatchOverdue, isStale, latestBatchAgeMs, latestBatchCountsLabel, latestBatchStalenessNote, latestBatchStatesLabel, opportunitiesOf, scanState, STALE_AFTER_MS} = await import('../lib/goldmine/dashboard-view.ts');

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

function batch(overrides = {}) {
  return {
    detectedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
    signalCount: 28,
    opportunityCount: 0,
    byState: [{state: 'EARLY', count: 5}, {state: 'BUILDING', count: 3}, {state: 'REJECTED', count: 20}],
    ...overrides,
  };
}

describe('latestBatchAgeMs', () => {
  test('measures the gap from the recorded batch to now', () => {
    assert.equal(latestBatchAgeMs(batch(), NOW), 60 * 60 * 1000);
  });
  test('no batch at all has no age', () => {
    assert.equal(latestBatchAgeMs(null, NOW), null);
  });
  test('an unparseable timestamp has an unknown age, never a guessed one', () => {
    assert.equal(latestBatchAgeMs(batch({detectedAt: 'not-a-date'}), NOW), null);
  });
});

describe('isLatestBatchOverdue: only a gap longer than the configured daily interval allows', () => {
  test('exactly at the threshold is not yet overdue; one millisecond past it is', () => {
    const atThreshold = batch({detectedAt: new Date(NOW - BATCH_OVERDUE_AFTER_MS).toISOString()});
    assert.equal(isLatestBatchOverdue(atThreshold, NOW), false);
    const justPast = batch({detectedAt: new Date(NOW - BATCH_OVERDUE_AFTER_MS - 1).toISOString()});
    assert.equal(isLatestBatchOverdue(justPast, NOW), true);
  });
  test('a 25-hour gap is not overdue: a daily Hobby cron legitimately drifts up to 59 minutes', () => {
    assert.equal(isLatestBatchOverdue(batch({detectedAt: new Date(NOW - 25 * 60 * 60 * 1000).toISOString()}), NOW), false);
  });
  test('no batch is not "overdue": nothing has ever been recorded, which is a different statement', () => {
    assert.equal(isLatestBatchOverdue(null, NOW), false);
  });
  test('an unknown age never raises a scheduler alarm', () => {
    assert.equal(isLatestBatchOverdue(batch({detectedAt: 'not-a-date'}), NOW), false);
  });
});

describe('latestBatchCountsLabel: says "recorded", never "scanned"', () => {
  test('a batch with no opportunities reads as a result, not as an absence', () => {
    const label = latestBatchCountsLabel(batch());
    assert.equal(label, '28 signals recorded, none met every safety and momentum gate.');
    assert.equal(label.includes('scan'), false, 'must not claim anything about when a scan ran');
  });
  test('opportunities are counted when there are some', () => {
    assert.equal(latestBatchCountsLabel(batch({opportunityCount: 2})), '28 signals recorded, 2 met every safety and momentum gate.');
  });
  test('a single signal is singular', () => {
    assert.equal(latestBatchCountsLabel(batch({signalCount: 1})), '1 signal recorded, none met every safety and momentum gate.');
  });
  test('nothing recorded says exactly that, and nothing about a scheduler', () => {
    const label = latestBatchCountsLabel(null);
    assert.equal(label, 'No signals have been recorded yet on this deployment.');
    assert.equal(/scheduler|cron/i.test(label), false);
  });
});

describe('latestBatchStatesLabel', () => {
  test('breaks the batch down in the order the API returned it', () => {
    assert.equal(latestBatchStatesLabel(batch()), '5 EARLY · 3 BUILDING · 20 REJECTED');
  });
  test('returns an empty string with nothing to break down, so the caller can omit the element', () => {
    assert.equal(latestBatchStatesLabel(null), '');
    assert.equal(latestBatchStatesLabel(batch({byState: []})), '');
  });
});

describe('latestBatchStalenessNote', () => {
  test('silent while the gap is within what a daily schedule allows', () => {
    assert.equal(latestBatchStalenessNote(batch(), NOW), '');
    assert.equal(latestBatchStalenessNote(null, NOW), '');
  });
  test('names the threshold and the alternative explanation, never asserting the scheduler failed', () => {
    const note = latestBatchStalenessNote(batch({detectedAt: new Date(NOW - 48 * 60 * 60 * 1000).toISOString()}), NOW);
    assert.match(note, /over 26 hours/);
    assert.match(note, /finds nothing new to record/);
    assert.equal(/broken|failed|stopped|down/i.test(note), false, 'must not assert a cause it cannot observe');
  });
});
