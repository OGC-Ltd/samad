// Playback over a range of fleet days.
//
// The server replays ONE day per request (`/vehicles/:id/playback?day=`), and
// a day is also what it caps and simplifies by. A range is therefore fetched
// a day at a time and joined here, so the replay, the legs and the trip total
// run across midnight as if it were one recording.
//
// The span travels through FleetMap's state as a single string: `YYYY-MM-DD`
// for one day, `YYYY-MM-DD..YYYY-MM-DD` for a range. Every place that resets
// playback to today keeps working unchanged, because today is a span too.

/** Longest range offered: a month. One request per day, fetched a few at a
 *  time (see FETCH_AT_ONCE in useVehiclePlayback); at the busiest unit in the
 *  fleet a month is ~2 MB, which is the ceiling worth replaying in a browser. */
export const MAX_RANGE_DAYS = 31;

/**
 * The server's own threshold for a reporting silence (TRACK_HOLE_MS in
 * fleet-server's telemetry.repository). Used at each midnight join, where the
 * server could not see across the boundary to decide.
 */
const HOLE_MS = 6 * 60_000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` moved by `delta` calendar days. Calendar maths only: no zone. */
export function addDays(day, delta) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Days from `from` to `to`, both included. */
export function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

/** `{ from, to }` from a span string; `to` equals `from` for one day. */
export function parseSpan(span) {
  const [from, to] = String(span ?? "").split("..");
  if (!DAY_RE.test(from ?? "")) return null;
  return { from, to: DAY_RE.test(to ?? "") && to > from ? to : from };
}

/**
 * The span string for `from`..`to`, put in order and clipped to
 * MAX_RANGE_DAYS from `from`, and never past `maxDay` (today).
 */
export function spanKey(from, to = from, maxDay = null) {
  let a = from, b = to ?? from;
  if (b < a) [a, b] = [b, a];
  if (maxDay && b > maxDay) b = maxDay;
  if (maxDay && a > maxDay) a = maxDay;
  const last = addDays(a, MAX_RANGE_DAYS - 1);
  if (b > last) b = last;
  return a === b ? a : `${a}..${b}`;
}

/** Every day in a span, in order. */
export function daysOf(span) {
  const s = parseSpan(span);
  if (!s) return [];
  const out = [];
  for (let d = s.from; d <= s.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * Several days' playback responses, joined into the shape of one.
 *
 * Points and events are concatenated in day order. At each midnight the first
 * point of the later day is marked `gapBefore` when the unit was silent longer
 * than the server's threshold across the join, which is the one decision the
 * server could not make, having seen only its own day. Days that are null
 * (nothing came back) are skipped.
 */
export function mergeDays(days) {
  const list = days.filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];

  const points = [];
  const events = [];
  for (const d of list) {
    const pts = d.points ?? [];
    if (pts.length && points.length) {
      const prev = points[points.length - 1];
      const first = pts[0];
      const join = first.t - prev.t > HOLE_MS ? { ...first, gapBefore: true } : first;
      points.push(join, ...pts.slice(1));
    } else {
      points.push(...pts);
    }
    events.push(...(d.events ?? []));
  }

  const first = list[0], last = list[list.length - 1];
  return {
    ...first,
    day: first.day,
    toDay: last.day,
    from: first.from,
    to: last.to,
    fixes: list.reduce((n, d) => n + (d.fixes ?? 0), 0),
    points,
    rawPoints: list.reduce((n, d) => n + (d.rawPoints ?? 0), 0),
    truncated: list.some((d) => d.truncated),
    truncatedEvents: list.some((d) => d.truncatedEvents),
    firstAt: points[0]?.t ?? null,
    lastAt: points[points.length - 1]?.t ?? null,
    distanceM: list.reduce((n, d) => n + (d.distanceM ?? 0), 0),
    gaps: points.filter((p) => p.gapBefore).length,
    events,
  };
}
