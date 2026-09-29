// Durable, server-side trade-alert eligibility and an outbox (docs/detection-rollout-decisions.md policy).
// This is the foundation only: **no sender is wired to it, so unattended notifications are not live.**
// Axiom and Phantom remain links for manual action; nothing here trades, signs or touches a wallet.
//
// Policy, enforced in SQL so it holds across serverless instances, retries, restarts and overlapping runs:
//   - Only a fully verified, actionable opportunity qualifies: assessment.opportunity (which already requires
//     an actionable state, the score floor, every risk input and contractSafety 'verified') AND, checked
//     again here, contractSafety.status === 'verified'. REJECTED and safety-uncertain candidates are research
//     observations and never queue an alert.
//   - At most one alert per mint in any rolling 24 hours ...
//   - ... except a genuine transition: the mint was *assessed* as not qualifying (REJECTED, unsafe, or
//     verified-safe but otherwise short of an opportunity) after its last alert, was not seen qualifying since,
//     and now qualifies. A safety-unknown observation (RugCheck rate limit, cooldown, outage) is not a
//     transition, so a provider flap can never re-alert. At most one transition alert per mint per 24 hours,
//     so the exception cannot become a flapping loop.
//
// Idempotency: the outbox id is derived from the recorded signal id and the detection time, and
// the whole decision is one INSERT ... SELECT ... WHERE NOT EXISTS statement against the outbox itself. A retried
// or duplicate scheduled run re-derives the same id (ON CONFLICT DO NOTHING) or finds the alert it already
// queued; two overlapping runs are serialized by the database's single writer, so the second sees the first's
// row. Per-mint memory (goldmine_alert_state) only moves forward (MAX), and is written after the decision, so a
// crash between the two statements leaves a state the retry resolves the same way.
//
// Delivery: `delivered` is set only by markAlertDelivered, which a sender calls after its channel confirms.
// A failed attempt is retried with backoff and ends as `failed`; an alert older than ALERT_MAX_AGE_MS is
// `expired`, never sent late. A crash after a channel accepted a message but before it was marked delivered
// can resend once after the lease expires (at-least-once); the alert id is the channel's dedupe key.
import {redact} from '../diagnostics';
import type {Assessment} from './score';
import {signalId, type Scored} from './signals';

export const ALERT_WINDOW_MS = 24 * 3600000;
export const ALERT_MAX_AGE_MS = 30 * 60000;
export const ALERT_LEASE_MS = 60000;
export const ALERT_MAX_ATTEMPTS = 5;

export type Eligibility = 'qualifying' | 'not_qualifying' | 'uncertain';

export function eligibility({snapshot, assessment}: Scored): Eligibility {
  if (assessment.opportunity && snapshot.contractSafety.status === 'verified') return 'qualifying';
  if (assessment.state === 'REJECTED' || snapshot.contractSafety.status === 'unsafe' || snapshot.contractSafety.status === 'verified') return 'not_qualifying';
  return 'uncertain';
}



// Called after recordSignals with the same scored list and detection time, so every queued alert points at a
// recorded signal. Returns how many alerts this call newly queued.
export async function recordAlertEligibility(database: D1Database, scored: Scored[], detectedAt: number): Promise<number> {
  let queued = 0;
  for (const entry of scored) {
    const assessment: Assessment = entry.assessment;
    if (assessment.priceUsd === null) continue; // not recorded by recordSignals, so nothing to point at
    const kind = eligibility(entry);
    if (kind === 'uncertain') continue;
    if (kind === 'qualifying') {
      const signal = signalId(assessment, detectedAt);
      // The id pins an exact retry of this detection (same signal, same detection time) to one row. It is
      // deliberately not the signal id alone: a genuine transition can land in the same six-hour bucket as
      // the mint's earlier alert and must still get its own row. Duplicate *runs* are stopped by the NOT
      // EXISTS policy below, which is one atomic statement.
      const result = await database.prepare(`INSERT INTO goldmine_alert_outbox (id, address, signal_id, model_version, reason, created_at)
SELECT ?1, ?2, ?3, ?4,
  CASE WHEN NOT EXISTS (SELECT 1 FROM goldmine_alert_outbox WHERE address = ?2) THEN 'first'
       WHEN NOT EXISTS (SELECT 1 FROM goldmine_alert_outbox WHERE address = ?2 AND created_at > ?5 - ?6) THEN 'window'
       ELSE 'transition' END,
  ?5
WHERE NOT EXISTS (SELECT 1 FROM goldmine_alert_outbox WHERE address = ?2 AND created_at > ?5 - ?6)
   OR (EXISTS (SELECT 1 FROM goldmine_alert_state st WHERE st.address = ?2
               AND st.last_genuine_nonqualifying_at IS NOT NULL
               AND st.last_genuine_nonqualifying_at > COALESCE(st.last_qualifying_at, 0)
               AND st.last_genuine_nonqualifying_at > (SELECT MAX(created_at) FROM goldmine_alert_outbox WHERE address = ?2))
       AND NOT EXISTS (SELECT 1 FROM goldmine_alert_outbox WHERE address = ?2 AND reason = 'transition' AND created_at > ?5 - ?6))
ON CONFLICT(id) DO NOTHING`).bind(`alert:${signal}:${detectedAt}`, assessment.address, signal, assessment.modelVersion, detectedAt, ALERT_WINDOW_MS).run();
      queued += result.meta.changes ?? 0;
    }
    await database.prepare(`INSERT INTO goldmine_alert_state (address, last_qualifying_at, last_genuine_nonqualifying_at, updated_at) VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(address) DO UPDATE SET
  last_qualifying_at = CASE WHEN excluded.last_qualifying_at IS NULL THEN last_qualifying_at ELSE MAX(COALESCE(last_qualifying_at, 0), excluded.last_qualifying_at) END,
  last_genuine_nonqualifying_at = CASE WHEN excluded.last_genuine_nonqualifying_at IS NULL THEN last_genuine_nonqualifying_at ELSE MAX(COALESCE(last_genuine_nonqualifying_at, 0), excluded.last_genuine_nonqualifying_at) END,
  updated_at = MAX(updated_at, excluded.updated_at)`).bind(assessment.address, kind === 'qualifying' ? detectedAt : null, kind === 'not_qualifying' ? detectedAt : null, detectedAt).run();
  }
  return queued;
}

export type QueuedAlert = {id: string; address: string; signalId: string; modelVersion: string; reason: string; createdAt: number; attempts: number; owner: string};

// Claims the oldest deliverable alert under a lease, first expiring any that are too old to be worth sending.
export async function claimNextAlert(database: D1Database, now: number, leaseMs = ALERT_LEASE_MS): Promise<QueuedAlert | null> {
  await database.prepare("UPDATE goldmine_alert_outbox SET status = 'expired', lease_owner = NULL, lease_expires = NULL WHERE status = 'pending' AND created_at < ?").bind(now - ALERT_MAX_AGE_MS).run();
  const owner = crypto.randomUUID();
  const row = await database.prepare(`UPDATE goldmine_alert_outbox SET lease_owner = ?1, lease_expires = ?2 + ?3
    WHERE id = (SELECT id FROM goldmine_alert_outbox WHERE status = 'pending' AND next_attempt_at <= ?2 AND (lease_expires IS NULL OR lease_expires < ?2) ORDER BY created_at, id LIMIT 1)
      AND status = 'pending' AND (lease_expires IS NULL OR lease_expires < ?2)
    RETURNING id, address, signal_id, model_version, reason, created_at, attempts`)
    .bind(owner, now, leaseMs).first<{id: string; address: string; signal_id: string; model_version: string; reason: string; created_at: number; attempts: number}>();
  return row ? {id: row.id, address: row.address, signalId: row.signal_id, modelVersion: row.model_version, reason: row.reason, createdAt: row.created_at, attempts: row.attempts, owner} : null;
}

// Only after the channel confirmed delivery. False if this claim no longer holds the alert.
export async function markAlertDelivered(database: D1Database, alert: QueuedAlert, now: number): Promise<boolean> {
  const row = await database.prepare("UPDATE goldmine_alert_outbox SET status = 'delivered', delivered_at = ?, lease_owner = NULL, lease_expires = NULL WHERE id = ? AND lease_owner = ? AND status = 'pending' RETURNING id")
    .bind(now, alert.id, alert.owner).first();
  return row !== null;
}

export async function markAlertFailed(database: D1Database, alert: QueuedAlert, now: number, error: unknown): Promise<void> {
  const attempts = alert.attempts + 1;
  const message = redact(error instanceof Error ? error.message : String(error)).slice(0, 200);
  await database.prepare("UPDATE goldmine_alert_outbox SET attempts = ?, status = ?, next_attempt_at = ?, last_error = ?, lease_owner = NULL, lease_expires = NULL WHERE id = ? AND lease_owner = ? AND status = 'pending'")
    .bind(attempts, attempts >= ALERT_MAX_ATTEMPTS ? 'failed' : 'pending', now + Math.min(2 ** attempts * 30000, 15 * 60000), message, alert.id, alert.owner).run();
}

// One delivery attempt through `send`, which must resolve only once its channel has accepted the message.
// Returns what happened. No production sender exists yet; this is exercised by tests with fake channels.
export async function deliverNextAlert(database: D1Database, now: number, send: (alert: QueuedAlert) => Promise<void>): Promise<'none' | 'delivered' | 'failed' | 'lost_lease'> {
  const alert = await claimNextAlert(database, now);
  if (!alert) return 'none';
  try {
    await send(alert);
  } catch (error) {
    await markAlertFailed(database, alert, now, error);
    return 'failed';
  }
  return (await markAlertDelivered(database, alert, now)) ? 'delivered' : 'lost_lease';
}
