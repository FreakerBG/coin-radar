// lib/goldmine/cadence.ts (Stage 06): the observability proof, the active/legacy horizon split and the
// derived (never persisted) outcome states. Pure functions and constants only - no database, no provider,
// no network. The settling behaviour of the real SQL is covered separately in
// tests/goldmine-outcome-schedule.test.mjs against an in-memory D1.
import assert from 'node:assert/strict';
import {describe, test} from 'node:test';

const cadence = await import('../lib/goldmine/cadence.ts');
const {
  ACTIVE_HORIZONS, ACTIVE_HORIZON_IDS, KNOWN_HORIZONS, KNOWN_HORIZON_IDS, LEGACY_HORIZONS, LEGACY_HORIZON_IDS,
  EVALUATION_SCHEDULE_VERSION, LEGACY_EVALUATION_SCHEDULE_VERSION,
  MAX_SCAN_GAP_MS, MIN_SCAN_GAP_MS, OBSERVATION_GRACE_BUFFER_MS, OBSERVATION_GRACE_MS,
  SCAN_CADENCE_MS, SCAN_CRON_EXPRESSION, SCHEDULER_JITTER_MS,
  cadenceReport, countCoverage, coverageTotal, derivedOutcomeState, emptyCoverage, horizonById,
  horizonOrderIndex, hoursOf, isActiveHorizon, isKnownHorizonId, isObservableUnderCadence,
  latestObservableAgeMs, observationAgeMs, settlingScanOffsetMs,
} = cadence;

const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;

// A scan schedule as offsets from detection. Offset 0 is the scan that recorded the signal: detection
// coincides with a scan because lib/goldmine/scan.ts passes one `now` to both evaluateOutcomes and
// recordSignals. `gapAt(index)` supplies the gap before scan index+1, so a test can choose the scheduling
// *phase*, not just an average interval.
function scanOffsets(gapAt, untilMs) {
  const offsets = [0];
  let at = 0;
  for (let index = 0; at <= untilMs; index++) {
    const gap = gapAt(index);
    assert.ok(gap > 0, 'a scan schedule must advance');
    at += gap;
    offsets.push(at);
  }
  return offsets;
}

// A deterministic pseudo-random gap generator (a small LCG), so "many phases" is reproducible in CI and a
// failure can be replayed from its seed.
function seededGaps(seed, min, max) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return min + (state % (max - min + 1));
  };
}

const horizonsToProbe = ACTIVE_HORIZONS.map(horizon => ({...horizon}));
const furthest = Math.max(...horizonsToProbe.map(latestObservableAgeMs));

describe('declared scheduler constants', () => {
  test('the cron expression and cadence match the deployed schedule (daily, Vercel Hobby)', () => {
    assert.equal(SCAN_CRON_EXPRESSION, '0 0 * * *');
    assert.equal(SCAN_CADENCE_MS, DAY);
  });

  test('the maximum and minimum scan gaps are derived from the cadence and the jitter allowance, not typed as literals', () => {
    assert.equal(SCHEDULER_JITTER_MS, 59 * MINUTE, 'Hobby fires a daily cron somewhere in its scheduled hour');
    assert.equal(MAX_SCAN_GAP_MS, SCAN_CADENCE_MS + SCHEDULER_JITTER_MS);
    assert.equal(MIN_SCAN_GAP_MS, SCAN_CADENCE_MS - SCHEDULER_JITTER_MS);
    assert.equal(MAX_SCAN_GAP_MS, 24 * HOUR + 59 * MINUTE, 'the widest legitimate gap is 24h59m');
  });

  test('the 26h grace window clears the maximum scan gap with a documented, positive buffer', () => {
    assert.equal(OBSERVATION_GRACE_MS, 26 * HOUR);
    assert.equal(OBSERVATION_GRACE_BUFFER_MS, OBSERVATION_GRACE_MS - MAX_SCAN_GAP_MS);
    assert.equal(OBSERVATION_GRACE_BUFFER_MS, 61 * MINUTE);
    assert.ok(OBSERVATION_GRACE_BUFFER_MS > 0,
      `the grace window must exceed the maximum scan gap; buffer is ${OBSERVATION_GRACE_BUFFER_MS}ms`);
  });

  test('the evaluation schedule is versioned separately from the scoring model', () => {
    assert.equal(EVALUATION_SCHEDULE_VERSION, 'daily-snapshot-v1');
    assert.equal(LEGACY_EVALUATION_SCHEDULE_VERSION, 'intraday-v0');
    // MODEL_VERSION itself (and that Stage 06 leaves it alone) is asserted in
    // tests/goldmine-outcome-schedule.test.mjs, which loads the application module graph.
    assert.notEqual(EVALUATION_SCHEDULE_VERSION, 'momentum-v2.1.0');
  });
});

describe('active horizons are observable under the declared maximum scan gap', () => {
  // Requirement 1: mathematically observable, stated as the single inequality the proof needs.
  for (const horizon of ACTIVE_HORIZONS) {
    test(`${horizon.id} has a grace window at least as wide as the maximum scan gap`, () => {
      assert.ok(isObservableUnderCadence(horizon),
        `${horizon.id} window ${horizon.window}ms must be >= max scan gap ${MAX_SCAN_GAP_MS}ms`);
      assert.ok(horizon.window >= MAX_SCAN_GAP_MS);
    });
  }

  test('the active targets are exactly 24h, 72h and 168h', () => {
    assert.deepEqual(ACTIVE_HORIZONS.map(h => [h.id, h.after]), [['d1', DAY], ['d3', 3 * DAY], ['d7', 7 * DAY]]);
  });

  test('every legacy horizon is NOT observable under this cadence - including 6h and 24h', () => {
    for (const horizon of LEGACY_HORIZONS) {
      assert.equal(isObservableUnderCadence(horizon), false, `${horizon.id} must be reported as unobservable`);
    }
    // The two the old documentation omitted or understated.
    assert.equal(horizonById('6h').window, HOUR);
    assert.equal(horizonById('24h').window, 3 * HOUR);
    assert.ok(horizonById('24h').window < MAX_SCAN_GAP_MS,
      'the legacy 24h window is narrower than the maximum scan gap: whether it settled depended on cron drift');
  });
});

// Requirement 2: the invariant must be about the *width of the observation window* and the scheduling
// phase, not about `after + window` against the cadence. These two cases refute the rejected formula
// directly, in both directions.
describe('the invariant is window width and phase, not after + window', () => {
  const REJECTED_THRESHOLD = SCAN_CADENCE_MS * 1.25;

  test('a horizon can satisfy `after + window >= cadence * 1.25` and still be unobservable', () => {
    // 100h target with a one-minute window: the rejected formula passes easily, yet a scan is not
    // guaranteed anywhere near that minute.
    const horizon = {after: 100 * HOUR, window: MINUTE};
    assert.ok(horizon.after + horizon.window >= REJECTED_THRESHOLD, 'the rejected invariant would accept this');
    assert.equal(isObservableUnderCadence(horizon), false, 'the real invariant rejects it');
    // And a concrete schedule that misses it: exact daily scans put every scan on a 24h boundary, so none
    // lands in the single minute after 100h.
    const offsets = scanOffsets(() => SCAN_CADENCE_MS, 200 * HOUR);
    assert.equal(settlingScanOffsetMs(horizon, offsets), null, 'no scan falls inside the window');
  });

  test('a horizon can fail `after + window >= cadence * 1.25` and still be observable at every phase', () => {
    // A one-minute target with a 26h window: the rejected formula would reject it, but a daily scan is
    // guaranteed to enter the window.
    const horizon = {after: MINUTE, window: OBSERVATION_GRACE_MS};
    assert.ok(horizon.after + horizon.window < REJECTED_THRESHOLD, 'the rejected invariant would reject this');
    assert.equal(isObservableUnderCadence(horizon), true, 'the real invariant accepts it');
    for (let seed = 1; seed <= 50; seed++) {
      const offsets = scanOffsets(seededGaps(seed, MIN_SCAN_GAP_MS, MAX_SCAN_GAP_MS), latestObservableAgeMs(horizon));
      assert.notEqual(settlingScanOffsetMs(horizon, offsets), null, `seed ${seed} must still settle it`);
    }
  });
});

describe('scheduling phase: some scan always enters every active horizon window', () => {
  // The named adversarial phases, then a deterministic sweep. Each schedule starts at detection (offset 0),
  // exactly as a real signal does.
  const schedules = {
    'every gap at the maximum (24h59m)': () => MAX_SCAN_GAP_MS,
    'every gap at the minimum (23h01m)': () => MIN_SCAN_GAP_MS,
    'every gap exactly one day': () => SCAN_CADENCE_MS,
    'alternating minimum and maximum gaps': index => index % 2 === 0 ? MIN_SCAN_GAP_MS : MAX_SCAN_GAP_MS,
    'alternating maximum and minimum gaps': index => index % 2 === 0 ? MAX_SCAN_GAP_MS : MIN_SCAN_GAP_MS,
    // The worst phase for an exact-multiple target: every scan drifts as early as allowed, so the scan
    // nominally due at the target lands just before it and does not qualify.
    'one minute short of every target': () => SCAN_CADENCE_MS - MINUTE,
  };

  for (const [name, gapAt] of Object.entries(schedules)) {
    test(name, () => {
      const offsets = scanOffsets(gapAt, furthest);
      for (const horizon of horizonsToProbe) {
        const settled = settlingScanOffsetMs(horizon, offsets);
        assert.notEqual(settled, null, `${horizon.id} was never observable under "${name}"`);
        assert.ok(settled >= horizon.after, `${horizon.id} settled before its target (${settled} < ${horizon.after})`);
        assert.ok(settled <= latestObservableAgeMs(horizon), `${horizon.id} settled past its deadline`);
      }
    });
  }

  test('500 deterministic random phases inside the declared gap bounds all settle every active horizon', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const offsets = scanOffsets(seededGaps(seed, MIN_SCAN_GAP_MS, MAX_SCAN_GAP_MS), furthest);
      for (const horizon of horizonsToProbe) {
        assert.notEqual(settlingScanOffsetMs(horizon, offsets), null, `seed ${seed}: ${horizon.id} was never observable`);
      }
    }
  });

  test('a scan schedule that exceeds the declared maximum gap can miss a window - the bound is load-bearing, not decorative', () => {
    // Two days between scans is outside what the declared scheduler can produce; the proof does not cover
    // it, and the code must not pretend it does.
    const offsets = scanOffsets(() => 2 * DAY + HOUR, furthest);
    const missed = horizonsToProbe.filter(horizon => settlingScanOffsetMs(horizon, offsets) === null);
    assert.ok(missed.length > 0, 'a gap wider than MAX_SCAN_GAP_MS must be able to miss at least one window');
  });

  test('the worst observation age stays inside the deadline, and is honestly later than the target', () => {
    // At the earliest-drifting phase the scan due at the target arrives a minute early, so the settling scan
    // is roughly a full cadence later. This is exactly why the target age is never reported as the holding
    // period.
    const offsets = scanOffsets(() => SCAN_CADENCE_MS - MINUTE, furthest);
    const d1 = horizonById('d1');
    const settled = settlingScanOffsetMs(d1, offsets);
    assert.ok(settled > d1.after, 'the observation is legitimately later than the 24h target');
    assert.ok(settled <= latestObservableAgeMs(d1));
    assert.ok(hoursOf(settled) > 24 && hoursOf(settled) < 50, `observed after ${hoursOf(settled)}h`);
  });
});

describe('known versus active horizon ids', () => {
  test('legacy ids are all still known, so stored history stays valid', () => {
    assert.deepEqual(LEGACY_HORIZON_IDS, ['15m', '1h', '6h', '24h']);
    for (const id of LEGACY_HORIZON_IDS) assert.equal(isKnownHorizonId(id), true, `${id} must remain valid`);
  });

  test('the new active ids validate and are distinct from every legacy id', () => {
    assert.deepEqual(ACTIVE_HORIZON_IDS, ['d1', 'd3', 'd7']);
    for (const id of ACTIVE_HORIZON_IDS) assert.equal(isKnownHorizonId(id), true);
    assert.equal(LEGACY_HORIZON_IDS.some(id => ACTIVE_HORIZON_IDS.includes(id)), false, 'the two id sets must not overlap');
  });

  test('a new daily result can never be confused with the legacy 24h definition', () => {
    const legacy = horizonById('24h'), active = horizonById('d1');
    assert.equal(legacy.after, active.after, 'both target 24 hours, which is exactly why the ids must differ');
    assert.notEqual(legacy.window, active.window);
    assert.notEqual(legacy.schedule, active.schedule);
    assert.equal(isActiveHorizon(active), true);
    assert.equal(isActiveHorizon(legacy), false);
  });

  test('the obvious confusable spellings are not known horizons', () => {
    for (const id of ['1d', '3d', '7d', '12h', '', 'D1', 'd2']) {
      assert.equal(isKnownHorizonId(id), false, `${JSON.stringify(id)} must not be accepted as a horizon id`);
      assert.equal(horizonById(id), null);
    }
  });

  test('known horizons list legacy first, then active, and an unknown id sorts last', () => {
    assert.deepEqual(KNOWN_HORIZON_IDS, [...LEGACY_HORIZON_IDS, ...ACTIVE_HORIZON_IDS]);
    assert.equal(horizonOrderIndex('15m'), 0);
    assert.equal(horizonOrderIndex('d7'), KNOWN_HORIZON_IDS.length - 1);
    assert.equal(horizonOrderIndex('nonsense'), KNOWN_HORIZON_IDS.length, 'an unknown id must sort after every known one, not before all of them');
  });
});

describe('derived outcome state', () => {
  const now = Date.UTC(2026, 8, 20, 12);

  test('a pending row still inside its window is live pending', () => {
    assert.equal(derivedOutcomeState({status: 'pending', deadlineAt: now + 1}, now), 'pending');
  });

  test('a pending row exactly at its deadline is still live, matching the sweep predicate (deadline_at < now)', () => {
    assert.equal(derivedOutcomeState({status: 'pending', deadlineAt: now}, now), 'pending');
  });

  test('a pending row past its deadline is expired-unswept, never live pending and never claimed as missed', () => {
    assert.equal(derivedOutcomeState({status: 'pending', deadlineAt: now - 1}, now), 'expired_unswept');
  });

  test('a settled row keeps its stored status whatever the deadline says', () => {
    for (const status of ['observed', 'unavailable', 'missed']) {
      assert.equal(derivedOutcomeState({status, deadlineAt: now - DAY}, now), status);
      assert.equal(derivedOutcomeState({status, deadlineAt: now + DAY}, now), status);
    }
  });

  test('coverage counts every derived state separately and reconciles to the total', () => {
    const coverage = emptyCoverage();
    assert.deepEqual(coverage, {pending: 0, expiredUnswept: 0, observed: 0, unavailable: 0, missed: 0});
    for (const state of ['pending', 'expired_unswept', 'expired_unswept', 'observed', 'unavailable', 'missed']) {
      countCoverage(coverage, state);
    }
    assert.deepEqual(coverage, {pending: 1, expiredUnswept: 2, observed: 1, unavailable: 1, missed: 1});
    assert.equal(coverageTotal(coverage), 6);
  });
});

describe('actual observation elapsed time', () => {
  const detectedAt = Date.UTC(2026, 8, 20, 0);

  test('reports the real elapsed duration, not the horizon target', () => {
    assert.equal(observationAgeMs(detectedAt, detectedAt + 47 * HOUR + 30 * MINUTE), 47.5 * HOUR);
    assert.equal(hoursOf(observationAgeMs(detectedAt, detectedAt + 47 * HOUR + 30 * MINUTE)), 47.5);
    // The same horizon, observed at its target instead: the id cannot distinguish these two, the elapsed can.
    assert.equal(hoursOf(observationAgeMs(detectedAt, detectedAt + DAY)), 24);
  });

  test('a zero elapsed is a real duration; null means there is nothing to measure', () => {
    assert.equal(observationAgeMs(detectedAt, detectedAt), 0);
    assert.equal(observationAgeMs(detectedAt, null), null);
    assert.equal(observationAgeMs(detectedAt, Number.NaN), null);
    assert.equal(observationAgeMs(Number.NaN, detectedAt), null);
    assert.equal(observationAgeMs(detectedAt, detectedAt - 1), null, 'an impossible negative elapsed is never reported as a duration');
    assert.equal(hoursOf(null), null);
  });
});

describe('cadenceReport (the block the API and dashboard both read)', () => {
  const report = cadenceReport();

  test('carries the cadence, both schedule versions and every known horizon', () => {
    assert.equal(report.cronExpression, SCAN_CRON_EXPRESSION);
    assert.equal(report.scanCadenceMs, SCAN_CADENCE_MS);
    assert.equal(report.maxScanGapMs, MAX_SCAN_GAP_MS);
    assert.equal(report.observationGraceMs, OBSERVATION_GRACE_MS);
    assert.equal(report.observationGraceBufferMs, OBSERVATION_GRACE_BUFFER_MS);
    assert.equal(report.evaluationScheduleVersion, EVALUATION_SCHEDULE_VERSION);
    assert.equal(report.legacyEvaluationScheduleVersion, LEGACY_EVALUATION_SCHEDULE_VERSION);
    assert.deepEqual(report.horizons.map(h => h.id), KNOWN_HORIZON_IDS);
    assert.equal(report.horizons.length, KNOWN_HORIZONS.length);
  });

  test('every horizon states its schedule, whether it is active and whether this cadence can observe it', () => {
    assert.deepEqual(report.horizons.map(h => [h.id, h.active, h.observableUnderCadence]), [
      ['15m', false, false], ['1h', false, false], ['6h', false, false], ['24h', false, false],
      ['d1', true, true], ['d3', true, true], ['d7', true, true],
    ]);
    for (const horizon of report.horizons) {
      assert.equal(horizon.latestObservableAgeMs, horizon.targetMs + horizon.graceWindowMs);
      assert.ok(horizon.label && horizon.description, `${horizon.id} needs a user-facing label and description`);
    }
  });

  test('the boundary note says plainly that an observation is not guaranteed to be at the target age', () => {
    assert.match(report.exactTargetBoundaryNote, /never guaranteed to be exactly the target age/);
  });

  test('is JSON-serializable, so it can cross the API boundary unchanged', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
  });
});

describe('Workers/Vercel compatibility', () => {
  test('the cadence module imports nothing, so it is safe in a Workers isolate and the client bundle', async () => {
    const {readFile} = await import('node:fs/promises');
    const source = await readFile(new URL('../lib/goldmine/cadence.ts', import.meta.url), 'utf8');
    assert.equal(/^\s*import\s/m.test(source), false, 'lib/goldmine/cadence.ts must stay dependency-free');
    assert.equal(/\brequire\(/.test(source), false);
    // No Node-only or platform-specific globals either: a Workers isolate has none of these, and the same
    // module is bundled into the browser.
    // `window` is deliberately absent from this list: it is the name of a horizon's grace-window field here,
    // not the browser global.
    for (const pattern of [/\bprocess\./, /\bBuffer\b/, /\b__dirname\b/, /\bglobalThis\b/, /\bdocument\./]) {
      assert.equal(pattern.test(source), false, `${pattern} must not appear in a runtime-portable module`);
    }
  });
});
