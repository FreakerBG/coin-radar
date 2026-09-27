// The one authoritative description of *when* this deployment can observe an outcome, and therefore of
// which evaluation horizons it can honestly evaluate at all (Stage 06). Nothing here scores a candidate,
// reads a provider, touches storage or changes contract safety: it is pure constants and pure functions
// over them, so the API, the database writer, the dashboard and the tests all derive the same numbers from
// this file instead of restating them.
//
// It deliberately imports nothing, so it is safe in a Workers isolate, in a Vercel function and in the
// client bundle (app/goldmine-panel.tsx reads the labels from here through lib/goldmine/backtest-view.ts).

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// --- The configured scheduler ------------------------------------------------------------------------

// vercel.json's `crons` entry for /api/goldmine/scheduled. Stated here so the invariants below are
// derived from the schedule that is actually deployed, not from an assumption about it.
export const SCAN_CRON_EXPRESSION = '0 0 * * *';
// The nominal interval between two scheduled scans: once a day. This is the Vercel Hobby plan's limit
// (docs/goldmine-intelligence.md section 4, docs/deployment-runbook.md), an owner decision, not a
// pending upgrade.
export const SCAN_CADENCE_MS = DAY;
// Hobby fires a daily cron somewhere inside its scheduled hour (00:00-00:59 UTC), so one invocation can
// be up to 59 minutes later - or earlier - than the nominal instant.
export const SCHEDULER_JITTER_MS = 59 * MINUTE;
// The widest gap between two consecutive scheduled invocations that a scheduler working exactly as
// configured can produce: the nominal interval, plus a maximally-late invocation following a maximally
// early one. Derived, never typed as a literal.
export const MAX_SCAN_GAP_MS = SCAN_CADENCE_MS + SCHEDULER_JITTER_MS; // 24h59m
// ...and the narrowest, which is what makes an exact-24h-multiple target land on a scheduling boundary
// (see EXACT_TARGET_BOUNDARY_NOTE below). Not part of the observability proof; it only bounds how much
// *later* than its target an observation can legitimately be.
export const MIN_SCAN_GAP_MS = SCAN_CADENCE_MS - SCHEDULER_JITTER_MS; // 23h01m

// --- The observation window -------------------------------------------------------------------------

// Every active horizon's post-target grace window. 26 hours, the value the owner decision starts from,
// validated rather than assumed:
//
//   Claim. If a signal is detected at a scan, and consecutive scans are never more than MAX_SCAN_GAP_MS
//   apart, then at least one scan falls inside [target, target + OBSERVATION_GRACE_MS].
//
//   Proof. A signal's detected_at is the scan's own timestamp: lib/goldmine/scan.ts passes one `now` to
//   evaluateOutcomes and recordSignals, so detection coincides exactly with a scan s(0). Let the later
//   scans be s(1) < s(2) < ... with s(i+1) - s(i) <= MAX_SCAN_GAP_MS, and let T = s(0) + after be the
//   target instant. Because `after` is finite and positive and the scan times increase without bound,
//   there is a least j with s(j) >= T. That j is at least 1, so s(j-1) exists, and s(j-1) < T by
//   minimality. Hence s(j) <= s(j-1) + MAX_SCAN_GAP_MS < T + MAX_SCAN_GAP_MS <= T +
//   OBSERVATION_GRACE_MS. So s(j) lies in [T, T + OBSERVATION_GRACE_MS], which is exactly the window
//   evaluateOutcomes settles inside (`due_at <= now AND deadline_at >= now`). QED
//
//   The claim therefore needs window >= MAX_SCAN_GAP_MS and nothing else - not `after + window` compared
//   against the cadence, which says nothing about whether a scan is *phased* to land in the window.
//   isObservableUnderCadence() below is that single inequality; OBSERVATION_GRACE_BUFFER_MS is how much
//   margin 26h leaves over the strict minimum.
export const OBSERVATION_GRACE_MS = 26 * HOUR;
// Margin of the chosen grace window over the proven minimum (61 minutes at the constants above). Positive
// by construction of OBSERVATION_GRACE_MS; asserted in tests/goldmine-cadence.test.mjs so a future change
// to the cadence or the jitter allowance that erases the margin fails CI instead of silently producing
// horizons that cannot be observed.
export const OBSERVATION_GRACE_BUFFER_MS = OBSERVATION_GRACE_MS - MAX_SCAN_GAP_MS;

// Why an observation is almost never exactly `after` old, even when everything works. `after` is an exact
// multiple of SCAN_CADENCE_MS, so the target lands on a scheduling boundary: the scan nominally due at the
// target is early (by up to SCHEDULER_JITTER_MS) about as often as it is late, and an early one does not
// qualify - it comes before due_at. The next one then settles the outcome roughly a full cadence later.
// An observation is therefore legitimately either close to `after` or close to `after + SCAN_CADENCE_MS`,
// which is why every read path reports the real elapsed time (observationAgeMs) instead of labelling the
// stored price as the target-age price.
export const EXACT_TARGET_BOUNDARY_NOTE = 'A daily scan due exactly at the target can fire up to 59 minutes early, which does not qualify, and the next daily scan then settles the outcome. An observation is therefore either near its target age or roughly one day past it - never guaranteed to be exactly the target age.';

// --- Evaluation schedules ---------------------------------------------------------------------------

// The evaluation schedule new signals are recorded under. It versions *when outcomes are observed*, which
// is why it is separate from lib/goldmine/score.ts's MODEL_VERSION: MODEL_VERSION describes how a
// candidate is scored, and scoring is unchanged by this stage. Bumping one must never be read as bumping
// the other.
export const EVALUATION_SCHEDULE_VERSION = 'daily-snapshot-v1';
// The schedule every already-stored outcome row was written under: intraday horizons sized for a
// five-minute scan cadence that this deployment never ran. Those rows are still read, reported and
// counted; they are simply never created again.
export const LEGACY_EVALUATION_SCHEDULE_VERSION = 'intraday-v0';

export type EvaluationScheduleVersion = typeof EVALUATION_SCHEDULE_VERSION | typeof LEGACY_EVALUATION_SCHEDULE_VERSION;

export type HorizonDefinition = {
  // The value stored in goldmine_outcomes.horizon. Part of that table's primary key
  // (signal_id, horizon), so an id is also the row's permanent identity.
  readonly id: string;
  // Target age: due_at = detected_at + after.
  readonly after: number;
  // Post-target grace: deadline_at = due_at + window. The outcome settles at the first scan inside
  // [due_at, deadline_at]; a scan after deadline_at finds it already swept to 'missed'.
  readonly window: number;
  readonly schedule: EvaluationScheduleVersion;
  readonly label: string;
  readonly description: string;
};

// The horizons new signals get. Each is "the first daily snapshot at or after the target age", never a
// claim about an exact-time price: the grace window is wide enough to guarantee a daily scan enters it
// (see OBSERVATION_GRACE_MS), and the read paths report the observation's real elapsed time.
//
// The ids are deliberately not '1d'/'3d'/'7d' and deliberately share no spelling with the legacy set: a
// 'd1' row can only have been created by this schedule, and can never be confused with the legacy '24h'
// definition, which had the same 24-hour target but a 3-hour window and different semantics.
export const ACTIVE_HORIZONS: readonly HorizonDefinition[] = [
  {id: 'd1', after: DAY, window: OBSERVATION_GRACE_MS, schedule: EVALUATION_SCHEDULE_VERSION, label: '1-day target', description: '1-day target, observed at the next daily snapshot at or after 24 hours.'},
  {id: 'd3', after: 3 * DAY, window: OBSERVATION_GRACE_MS, schedule: EVALUATION_SCHEDULE_VERSION, label: '3-day target', description: '3-day target, observed at the next daily snapshot at or after 72 hours.'},
  {id: 'd7', after: 7 * DAY, window: OBSERVATION_GRACE_MS, schedule: EVALUATION_SCHEDULE_VERSION, label: '7-day target', description: '7-day target, observed at the next daily snapshot at or after 168 hours.'},
];

// The horizons already present in stored history, with exactly the `after`/`window` they were written
// with. They are kept here, unchanged, for three reasons, and removing them would break all three:
//   - a stored row's deadline_at only reconciles against the definition it was written under;
//   - isValidStoredOutcomeRow must keep accepting them, or every historical row becomes malformed and
//     disappears from coverage reporting (skippedMalformedOutcomes instead of visible history);
//   - the dashboard has to be able to say *why* they cannot be evaluated on this cadence, which needs
//     their real window, not a guess.
// Nothing ever writes one of these again: recordSignals only iterates ACTIVE_HORIZONS.
export const LEGACY_HORIZONS: readonly HorizonDefinition[] = [
  {id: '15m', after: 15 * MINUTE, window: 5 * MINUTE, schedule: LEGACY_EVALUATION_SCHEDULE_VERSION, label: '15m (legacy)', description: 'Legacy intraday horizon: 15-minute target, 5-minute window. Unobservable on a once-daily cadence.'},
  {id: '1h', after: HOUR, window: 15 * MINUTE, schedule: LEGACY_EVALUATION_SCHEDULE_VERSION, label: '1h (legacy)', description: 'Legacy intraday horizon: 1-hour target, 15-minute window. Unobservable on a once-daily cadence.'},
  {id: '6h', after: 6 * HOUR, window: HOUR, schedule: LEGACY_EVALUATION_SCHEDULE_VERSION, label: '6h (legacy)', description: 'Legacy intraday horizon: 6-hour target, 1-hour window. Unobservable on a once-daily cadence.'},
  {id: '24h', after: 24 * HOUR, window: 3 * HOUR, schedule: LEGACY_EVALUATION_SCHEDULE_VERSION, label: '24h (legacy)', description: 'Legacy horizon: 24-hour target, 3-hour window. Narrower than the maximum gap between two daily scans, so whether it ever settled depended on cron drift.'},
];

// Every horizon id a stored row may legitimately carry. Read/validation paths use this; the writer never
// does. Legacy first, then active, each ascending by target - so a report lists the schedule that can no
// longer be evaluated before the one that can, rather than interleaving '24h' and 'd1' as if they were
// two readings of the same thing.
export const KNOWN_HORIZONS: readonly HorizonDefinition[] = [...LEGACY_HORIZONS, ...ACTIVE_HORIZONS];
export const KNOWN_HORIZON_IDS: readonly string[] = KNOWN_HORIZONS.map(horizon => horizon.id);
export const ACTIVE_HORIZON_IDS: readonly string[] = ACTIVE_HORIZONS.map(horizon => horizon.id);
export const LEGACY_HORIZON_IDS: readonly string[] = LEGACY_HORIZONS.map(horizon => horizon.id);
// Display/sort order for anything keyed by horizon id.
export const HORIZON_ORDER: readonly string[] = KNOWN_HORIZON_IDS;

const BY_ID = new Map(KNOWN_HORIZONS.map(horizon => [horizon.id, horizon]));
export const horizonById = (id: string): HorizonDefinition | null => BY_ID.get(id) ?? null;
export const isKnownHorizonId = (id: string): boolean => BY_ID.has(id);
export const isActiveHorizon = (horizon: {schedule: EvaluationScheduleVersion}): boolean => horizon.schedule === EVALUATION_SCHEDULE_VERSION;
export const horizonOrderIndex = (id: string): number => {
  const index = HORIZON_ORDER.indexOf(id);
  // An id that is not a known horizon sorts after every known one rather than before all of them, which
  // is what indexOf's -1 would otherwise do.
  return index < 0 ? HORIZON_ORDER.length : index;
};

// --- Observability under the configured cadence -------------------------------------------------------

// The entire invariant, and the only thing the proof above needs: the observation window must be at least
// as wide as the widest gap between two scans. `after` is irrelevant to it - a horizon is observable
// because a scan is guaranteed to *enter its window*, not because the window happens to sit far enough
// from detection.
export const isObservableUnderCadence = (horizon: {window: number}, maxScanGapMs: number = MAX_SCAN_GAP_MS): boolean =>
  horizon.window >= maxScanGapMs;

// The latest age an observation for this horizon can ever have: its deadline. Past this the row is swept
// to 'missed' by the next scan and no price is ever recorded against it.
export const latestObservableAgeMs = (horizon: {after: number; window: number}): number => horizon.after + horizon.window;

// The first of `scanOffsetsMs` (offsets from detection, ascending) that settles this horizon, or null if
// none does. Mirrors evaluateOutcomes' SQL predicate exactly (`due_at <= now AND deadline_at >= now`), so
// a test can drive an arbitrary scheduling phase through it and check the proof's conclusion rather than
// just re-checking its arithmetic.
export function settlingScanOffsetMs(horizon: {after: number; window: number}, scanOffsetsMs: readonly number[]): number | null {
  const deadline = latestObservableAgeMs(horizon);
  for (const offset of scanOffsetsMs) if (offset >= horizon.after && offset <= deadline) return offset;
  return null;
}

// --- Derived outcome state (never persisted) ----------------------------------------------------------

// 'expired_unswept' is derived at read time from (status, deadline_at, now) and is deliberately NOT a
// stored status: a row whose window closed is only rewritten to 'missed' by a scan (evaluateOutcomes), and
// opening a dashboard must never write to storage. Reporting such a row as live `pending` would overstate
// how much evidence is still coming; reporting it as `missed` would claim a sweep that has not happened.
export type DerivedOutcomeState = 'pending' | 'expired_unswept' | 'observed' | 'unavailable' | 'missed';

// `<` matches evaluateOutcomes' own sweep predicate (`deadline_at < ?`) exactly, so a row sitting exactly
// on its deadline is still live here for the same reason it is still settleable there.
export function derivedOutcomeState(row: {status: string; deadlineAt: number}, now: number): DerivedOutcomeState {
  if (row.status !== 'pending') return row.status as DerivedOutcomeState;
  return row.deadlineAt < now ? 'expired_unswept' : 'pending';
}

// How long after detection the observation actually happened - the honest answer to "is this a 24-hour
// price?", which the horizon id alone cannot give. Null whenever there is no observation to measure, or
// the stored timestamps cannot produce a sane duration (never a negative or non-finite elapsed).
export function observationAgeMs(detectedAt: number, observedAt: number | null): number | null {
  if (observedAt === null || !Number.isFinite(observedAt) || !Number.isFinite(detectedAt)) return null;
  const elapsed = observedAt - detectedAt;
  return elapsed >= 0 ? elapsed : null;
}

export const hoursOf = (ms: number | null): number | null => ms === null ? null : Number((ms / HOUR).toFixed(2));

// --- Coverage ---------------------------------------------------------------------------------------

// Every derived state gets its own count. `pending` means *genuinely still inside its window*, which is
// narrower than the stored status of the same name; `expiredUnswept` holds the difference. The five always
// sum to the number of valid outcome rows in the bucket, so a total can be reconciled and no row silently
// leaves the denominator.
export type OutcomeCoverage = {pending: number; expiredUnswept: number; observed: number; unavailable: number; missed: number};
export const emptyCoverage = (): OutcomeCoverage => ({pending: 0, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 0});
export const coverageTotal = (coverage: OutcomeCoverage): number =>
  coverage.pending + coverage.expiredUnswept + coverage.observed + coverage.unavailable + coverage.missed;

const COVERAGE_KEYS: Record<DerivedOutcomeState, keyof OutcomeCoverage> = {
  pending: 'pending', expired_unswept: 'expiredUnswept', observed: 'observed', unavailable: 'unavailable', missed: 'missed',
};
export const countCoverage = (coverage: OutcomeCoverage, state: DerivedOutcomeState): void => {
  coverage[COVERAGE_KEYS[state]]++;
};

// --- Serialized horizon metadata (API + dashboard) ----------------------------------------------------

export type HorizonReport = {
  id: string;
  label: string;
  description: string;
  schedule: EvaluationScheduleVersion;
  active: boolean;
  targetMs: number;
  graceWindowMs: number;
  latestObservableAgeMs: number;
  observableUnderCadence: boolean;
};

export const horizonReport = (horizon: HorizonDefinition): HorizonReport => ({
  id: horizon.id,
  label: horizon.label,
  description: horizon.description,
  schedule: horizon.schedule,
  active: isActiveHorizon(horizon),
  targetMs: horizon.after,
  graceWindowMs: horizon.window,
  latestObservableAgeMs: latestObservableAgeMs(horizon),
  observableUnderCadence: isObservableUnderCadence(horizon),
});

export type CadenceReport = {
  cronExpression: string;
  scanCadenceMs: number;
  schedulerJitterMs: number;
  maxScanGapMs: number;
  minScanGapMs: number;
  observationGraceMs: number;
  observationGraceBufferMs: number;
  evaluationScheduleVersion: string;
  legacyEvaluationScheduleVersion: string;
  exactTargetBoundaryNote: string;
  horizons: HorizonReport[];
};

// One self-describing block so every consumer - the dashboard, an operator reading the JSON, a future
// stage - can see the cadence a report was computed under without re-deriving it.
export const cadenceReport = (): CadenceReport => ({
  cronExpression: SCAN_CRON_EXPRESSION,
  scanCadenceMs: SCAN_CADENCE_MS,
  schedulerJitterMs: SCHEDULER_JITTER_MS,
  maxScanGapMs: MAX_SCAN_GAP_MS,
  minScanGapMs: MIN_SCAN_GAP_MS,
  observationGraceMs: OBSERVATION_GRACE_MS,
  observationGraceBufferMs: OBSERVATION_GRACE_BUFFER_MS,
  evaluationScheduleVersion: EVALUATION_SCHEDULE_VERSION,
  legacyEvaluationScheduleVersion: LEGACY_EVALUATION_SCHEDULE_VERSION,
  exactTargetBoundaryNote: EXACT_TARGET_BOUNDARY_NOTE,
  horizons: KNOWN_HORIZONS.map(horizonReport),
});
