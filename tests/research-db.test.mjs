// Shared D1 helpers (lib/research-db.ts): lock ownership and expiry, origin check, config defaults.
import assert from 'node:assert/strict';
import {beforeEach, test} from 'node:test';
import {createD1, runtime, startClock} from './helpers/harness.mjs';

const {acquireLock, releaseLock, getConfig, sameOrigin, db} = await import('../lib/research-db.ts');
const {defaultConfig} = await import('../lib/advisor.ts');

let d1, clock;
beforeEach(() => {
  clock = startClock();
  d1 = createD1();
  runtime.env.DB = d1;
});

test('a lock has one owner until released or expired after 60 seconds', async () => {
  const owners = await Promise.all([acquireLock('job'), acquireLock('job'), acquireLock('job')]);
  const winner = owners.filter(Boolean);
  assert.equal(winner.length, 1, 'concurrent acquisition has a single winner');

  clock.advance(60000);
  assert.equal(await acquireLock('job'), null, 'not yet expired at exactly 60 seconds');
  assert.ok(await acquireLock('other-job'), 'locks are independent by ID');

  await releaseLock('job', 'not-the-owner');
  assert.equal(await acquireLock('job'), null, 'only the owner can release');
  await releaseLock('job', winner[0]);
  assert.ok(await acquireLock('job'));
});

test('an expired lock can be taken over, and the stale owner cannot release the new lock', async () => {
  const stale = await acquireLock('job');
  clock.advance(60001);
  const fresh = await acquireLock('job');
  assert.ok(fresh);
  assert.notEqual(fresh, stale);
  await releaseLock('job', stale);
  assert.equal(await acquireLock('job'), null);
});

test('stored configuration is merged over defaults per user', async () => {
  d1.sqlite.prepare('INSERT INTO research_accounts (user_id, config) VALUES (?, ?)').run('user-a', JSON.stringify({bankroll: 500, xDailyRequests: 2}));
  assert.deepEqual(await getConfig('user-a'), {...defaultConfig, bankroll: 500, xDailyRequests: 2});
  assert.deepEqual(await getConfig('user-b'), defaultConfig);
});

test('same-origin requires an Origin header matching the request URL origin exactly', () => {
  const request = origin => new Request('https://coin-radar.test/api/x', {method: 'POST', headers: origin ? {origin} : {}});
  assert.equal(sameOrigin(request('https://coin-radar.test')), true);
  for (const origin of [null, 'null', 'http://coin-radar.test', 'https://coin-radar.test.attacker.test', 'https://coin-radar.test:444']) {
    assert.equal(sameOrigin(request(origin)), false, String(origin));
  }
});

test('a missing D1 binding fails with a non-sensitive error', () => {
  delete runtime.env.DB;
  assert.throws(() => db(), {message: 'Research storage is unavailable.'});
});
