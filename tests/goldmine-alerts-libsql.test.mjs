// Production runs on Turso (libSQL) through lib/turso-db.ts, not node:sqlite. The alert policy relies on
// numbered parameters (?1..?6), INSERT ... SELECT ... ON CONFLICT DO NOTHING, an upsert with MAX(), and
// UPDATE ... RETURNING; this runs them through the real adapter against a really-migrated libSQL file.
import assert from 'node:assert/strict';
import {createClient} from '@libsql/client';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, describe, test} from 'node:test';
import {applyTursoMigrations} from '../scripts/migrate-turso.mjs';
import {addresses} from './helpers/harness.mjs';

const {createTursoDatabase} = await import('../lib/turso-db.ts');
const {recordAlertEligibility, deliverNextAlert} = await import('../lib/goldmine/alerts.ts');

const dir = mkdtempSync(path.join(tmpdir(), 'coin-radar-alerts-'));
// Best effort: the adapter keeps its own client (and on Windows its file handle) for the process lifetime.
after(() => { try { rmSync(dir, {recursive: true, force: true}); } catch { /* left for the OS temp cleaner */ } });

const entry = (qualifying, safety = qualifying ? 'verified' : 'unsafe') => ({
  snapshot: {contractSafety: {status: safety}},
  assessment: {address: addresses.tokenA, modelVersion: 'momentum-v2.1.0', state: 'BREAKOUT', opportunity: qualifying, priceUsd: 1},
});

describe('alert SQL on a migrated libSQL database', () => {
  test('policy, idempotency and delivery behave exactly as on node:sqlite', async () => {
    const url = 'file:' + path.join(dir, 'alerts.db');
    const client = createClient({url});
    await applyTursoMigrations(client);
    const database = createTursoDatabase({url, authToken: ''});
    const t0 = Date.UTC(2026, 9, 1), hour = 3600000;

    assert.equal(await recordAlertEligibility(database, [entry(true)], t0), 1);
    assert.equal(await recordAlertEligibility(database, [entry(true)], t0), 0, 'exact retry');
    assert.equal(await recordAlertEligibility(database, [entry(true)], t0 + hour), 0, 'inside 24 h');
    await recordAlertEligibility(database, [entry(false)], t0 + 2 * hour);
    assert.equal(await recordAlertEligibility(database, [entry(true)], t0 + 3 * hour), 1, 'genuine transition');
    const rows = (await client.execute('SELECT reason, status FROM goldmine_alert_outbox ORDER BY created_at')).rows.map(row => [row.reason, row.status]);
    assert.deepEqual(rows, [['first', 'pending'], ['transition', 'pending']]);

    assert.equal(await deliverNextAlert(database, t0 + 3 * hour, async () => {}), 'delivered');
    const state = (await client.execute('SELECT last_qualifying_at, last_genuine_nonqualifying_at FROM goldmine_alert_state')).rows[0];
    assert.deepEqual([Number(state.last_qualifying_at), Number(state.last_genuine_nonqualifying_at)], [t0 + 3 * hour, t0 + 2 * hour]);
    client.close();
  });
});
