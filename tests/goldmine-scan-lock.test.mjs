// What the shared `goldmine:scan` lock does and does not guarantee, and the scheduler-authorization
// boundaries that are easy to state but were not asserted.
//
// The lock is a lease, not a mutex: acquireLock() writes a row with an expiry and takes it only when
// no unexpired row exists. That means it excludes a second scan *only while the lease lasts*. The
// lease was the 60s default while the pipeline's own provider budgets already add up to roughly 62s
// before a single database round trip, and Vercel allows a function to run for 300s - so a scan
// could outlive its lease, a second scan could legitimately acquire, and both could run at once.
// Two concurrent scans stamp signals with different Date.now() values, so the INSERT OR IGNORE in
// recordSignals() does not collapse them and the same token is recorded twice for one window.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { createD1, installFetch, offlineFetch, runtime, startClock } from './helpers/harness.mjs';

const { acquireLock, releaseLock, DEFAULT_LOCK_TTL_MS } = await import('../lib/research-db.ts');
const { SCAN_LOCK_TTL_MS } = await import('../lib/goldmine/scan.ts');
const { SCAN_BUDGET_MS } = await import('../lib/goldmine/contract-safety.ts');

const LOCK_ID = 'goldmine:scan';

let clock;
beforeEach(() => {
  clock = startClock();
  runtime.env.DB = createD1();
  installFetch(offlineFetch);
});
afterEach(() => { delete process.env.VERCEL; });

describe('the scan lease is long enough to actually exclude a second scan', () => {
  test('the scan lease exceeds the pipeline worst case, and the old default did not', () => {
    // Provider budgets the pipeline can spend before any database work, from the modules themselves:
    const outcomeSettling = 10_000;               // lib/goldmine/signals.ts, 5 parallel batches @10s
    const discovery = 2 * 12_000;                 // lib/market.ts, two sequential stages @12s
    const contractSafety = SCAN_BUDGET_MS + 8_000; // budget plus one in-flight request
    const providerWorstCase = outcomeSettling + discovery + contractSafety;

    assert.ok(
      providerWorstCase > DEFAULT_LOCK_TTL_MS,
      `provider budgets alone (${providerWorstCase}ms) already exceeded the old ${DEFAULT_LOCK_TTL_MS}ms lease`,
    );
    assert.ok(
      SCAN_LOCK_TTL_MS > providerWorstCase,
      `the scan lease (${SCAN_LOCK_TTL_MS}ms) must exceed the provider worst case (${providerWorstCase}ms)`,
    );
    // ...and it must cover the platform's own ceiling, because a scan can do database work on top of
    // the provider budgets. Vercel terminates a function at 300s on this account's plan, so a scan
    // cannot still be running once the lease expires.
    assert.ok(SCAN_LOCK_TTL_MS >= 300_000, 'the lease must cover the platform max duration');
  });

  test('a second acquirer is refused for the whole lease, not just for the old 60 seconds', async () => {
    const held = await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS);
    assert.ok(held);

    // Still inside the window where the old 60s lease would already have expired.
    clock.advance(DEFAULT_LOCK_TTL_MS + 1000);
    assert.equal(await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS), null, 'the lease must still be held');

    // And still held right up to the end of the lease.
    clock.advance(SCAN_LOCK_TTL_MS - DEFAULT_LOCK_TTL_MS - 3000);
    assert.equal(await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS), null);
  });

  test('the lease does expire, so a scan killed mid-flight cannot block the next one forever', async () => {
    assert.ok(await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS));
    // The holder is killed without ever releasing (Vercel terminating the function at max duration).
    clock.advance(SCAN_LOCK_TTL_MS + 1000);
    assert.ok(await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS), 'the lease self-heals after it expires');
  });

  test('releasing is owner-scoped: a previous holder cannot release the current one', async () => {
    const first = await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS);
    clock.advance(SCAN_LOCK_TTL_MS + 1000);
    const second = await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS);
    assert.ok(second && second !== first);

    await releaseLock(LOCK_ID, first);            // the expired holder's late release
    assert.equal(await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS), null, 'the current holder still holds it');

    await releaseLock(LOCK_ID, second);
    assert.ok(await acquireLock(LOCK_ID, SCAN_LOCK_TTL_MS), 'the real holder can release it');
  });

  test('other lock users keep the short default lease', async () => {
    // monitor:<user> guards a short, request-shaped operation; lengthening its lease would make a
    // failed monitor run block that user for five minutes for no benefit.
    assert.equal(DEFAULT_LOCK_TTL_MS, 60_000);
    assert.ok(await acquireLock('monitor:someone'));
    clock.advance(DEFAULT_LOCK_TTL_MS + 1000);
    assert.ok(await acquireLock('monitor:someone'), 'the default lease is unchanged');
  });
});
