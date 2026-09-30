// Read-only refresh of the recorded Goldmine list while the dashboard is open. Everything here reads
// GET /api/goldmine, which only SELECTs: it never calls POST /api/goldmine, never runs or schedules a
// scan, never settles outcomes, and never notifies. New opportunities are marked on the page, once.

// Detection runs on a schedule measured in hours (daily cron; hourly at most during a ramp), so polling
// faster than this would only add database reads without showing anything sooner. Paused while the tab
// is hidden, so an idle background tab costs nothing.
export const TRACKING_REFRESH_MS = 5 * 60000;

// A plain function, not a hook: callers set state from its result in an effect or event handler.
// `fetchImpl` is injectable so tests can prove the request is a GET to exactly this path.
export async function fetchTracking<T>(fetchImpl: typeof fetch = fetch): Promise<T | {error: string}> {
  try {
    const r = await fetchImpl('/api/goldmine', {method: 'GET', cache: 'no-store'});
    const d = await r.json() as T & {error?: string};
    if (!r.ok || d.error) return {error: d.error || 'Signal history unavailable.'};
    return d;
  } catch {
    return {error: 'Cannot reach Goldmine. Check your connection and retry.'};
  }
}

// Due when never refreshed, or when the last successful read is at least one interval old. Hidden tabs are
// never due; the caller re-checks on becoming visible, so returning to the tab catches up at once.
export function refreshDue(lastUpdatedAt: number | null, now: number, visible: boolean): boolean {
  if (!visible) return false;
  return lastUpdatedAt === null || now - lastUpdatedAt >= TRACKING_REFRESH_MS;
}

// Which recorded opportunities appeared since this page first loaded. The first successful read is the
// baseline and marks nothing, so opening the dashboard never presents old signals as new. An id is "new"
// at most once: `seen` only grows, so a later refresh cannot announce the same signal again.
export function trackNewOpportunities(seen: ReadonlySet<string> | null, signals: {id: string; opportunity: boolean}[]): {seen: Set<string>; fresh: string[]} {
  const ids = signals.filter(signal => signal.opportunity).map(signal => signal.id);
  if (seen === null) return {seen: new Set(ids), fresh: []};
  const fresh = ids.filter(id => !seen.has(id));
  return {seen: new Set([...seen, ...fresh]), fresh};
}

export function newOpportunitiesAnnouncement(count: number): string {
  if (count <= 0) return '';
  return `${count} newly recorded opportunit${count === 1 ? 'y' : 'ies'} since this page loaded. Recorded signals are research, not trade instructions.`;
}
