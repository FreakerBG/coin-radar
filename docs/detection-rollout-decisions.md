# Detection rollout decisions (not an activation)

The owner chose the conservative defaults for the proposed 15-minute detection cadence. This
document records those choices; it does not enable a trigger, send an alert, prune data, or change
the daily Vercel Cron.

- **Notifications:** at most one trade-oriented alert per mint in a rolling 24-hour period, unless
  it first becomes a verified, actionable opportunity after a prior non-qualifying observation.
  Repeated provider sightings or a still-qualifying score fluctuation do not re-alert. Rejected
  and unavailable-safety candidates remain research/control observations, never trade alerts.
  No unattended alert delivery exists in this PR; idempotent delivery and its persistent ledger
  need their own tests before activation.
- **Research history:** preserve repeated observations, including negative controls and their
  outcomes. Target a rolling 30-day *live* research window, but only after an export/archive and
  a tested retention implementation exist. Never delete pending or still-observable d1/d3/d7
  outcomes; never silently exclude archived controls from a claimed all-history analysis. The
  current backtest read is explicitly capped at 2,000 newest signals and reports truncation.
  No pruning or migration is included in this PR. Realistic row-volume and query-cost measurements
  must confirm whether 30 days fits the report window; otherwise report the smaller covered window
  or introduce an archive-aware analysis before enabling 15-minute scans.
- **Outcome schedule:** automated intraday POST detects and records but never settles outcomes.
  The existing Vercel daily GET remains responsible for daily-snapshot-v1 settlement. Existing
  signed-in manual POST retains its historical full-scan behavior. All three share one scan lock.

The separate Worker remains inactive. Before its schedule can be enabled, validate provider budgets,
storage growth, alert deduplication, archive/retention, canary observability, and rollback as laid
out in draft PR #22. The six-hour signal ID buckets already collapse repeated same-state/same-mint
observations in one bucket; that is a write deduplication mechanism, not an alert ledger or a
retention policy.
