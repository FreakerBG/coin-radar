// lib/goldmine/scheduled-auth.ts: authorization for the unattended scheduled Goldmine scan. Two
// independent conventions (custom header, Vercel's native Authorization: Bearer), both fail closed
// when their env var is unset, mirroring the rest of this codebase's shared-secret checks.
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { isAuthorizedScheduledScan } from '../lib/goldmine/scheduled-auth.ts';

const ORIGINAL_CRON = process.env.GOLDMINE_CRON_SECRET;
const ORIGINAL_BEARER = process.env.CRON_SECRET;

afterEach(() => {
  if (ORIGINAL_CRON === undefined) delete process.env.GOLDMINE_CRON_SECRET;
  else process.env.GOLDMINE_CRON_SECRET = ORIGINAL_CRON;
  if (ORIGINAL_BEARER === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_BEARER;
});

function request(headers = {}) {
  return new Request('https://coin-radar.test/api/goldmine/scheduled', { headers });
}

describe('custom header convention (x-goldmine-cron-secret)', () => {
  test('fails closed when GOLDMINE_CRON_SECRET is unset, however the request is made', () => {
    delete process.env.GOLDMINE_CRON_SECRET;
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': 'anything' })), false);
    assert.equal(isAuthorizedScheduledScan(request()), false);
  });

  test('accepts the exact configured secret and rejects a wrong one', () => {
    process.env.GOLDMINE_CRON_SECRET = 'super-secret';
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': 'super-secret' })), true);
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': 'wrong' })), false);
    assert.equal(isAuthorizedScheduledScan(request()), false);
  });

  test('an empty configured secret never authorizes', () => {
    process.env.GOLDMINE_CRON_SECRET = '';
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': '' })), false);
  });
});

describe('Vercel-native Authorization: Bearer convention (CRON_SECRET)', () => {
  test('fails closed when CRON_SECRET is unset', () => {
    delete process.env.CRON_SECRET;
    assert.equal(isAuthorizedScheduledScan(request({ authorization: 'Bearer anything' })), false);
  });

  test('accepts the exact configured bearer secret and rejects a wrong one', () => {
    process.env.CRON_SECRET = 'cron-secret-value';
    assert.equal(isAuthorizedScheduledScan(request({ authorization: 'Bearer cron-secret-value' })), true);
    assert.equal(isAuthorizedScheduledScan(request({ authorization: 'Bearer wrong-value' })), false);
  });

  test('rejects a missing Bearer prefix, wrong scheme, or missing header entirely', () => {
    process.env.CRON_SECRET = 'cron-secret-value';
    assert.equal(isAuthorizedScheduledScan(request({ authorization: 'cron-secret-value' })), false);
    assert.equal(isAuthorizedScheduledScan(request({ authorization: 'Basic cron-secret-value' })), false);
    assert.equal(isAuthorizedScheduledScan(request()), false);
  });
});

describe('either convention is sufficient on its own', () => {
  test('both secrets configured: either header authorizes independently', () => {
    process.env.GOLDMINE_CRON_SECRET = 'header-secret';
    process.env.CRON_SECRET = 'bearer-secret';
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': 'header-secret' })), true);
    assert.equal(isAuthorizedScheduledScan(request({ authorization: 'Bearer bearer-secret' })), true);
    assert.equal(isAuthorizedScheduledScan(request({ 'x-goldmine-cron-secret': 'wrong', authorization: 'Bearer also-wrong' })), false);
  });

  test('an unauthenticated request with no headers at all is never authorized, both secrets configured', () => {
    process.env.GOLDMINE_CRON_SECRET = 'header-secret';
    process.env.CRON_SECRET = 'bearer-secret';
    assert.equal(isAuthorizedScheduledScan(request()), false);
  });
});
