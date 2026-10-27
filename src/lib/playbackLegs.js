// A replayed day, cut into legs.
//
// A LEG is the driving between two stops. The TRIP is the whole replayed day.
//
// ## Stops come from movement, not from the speed column
//
// The server's `stop` events are runs of fixes REPORTING a speed of zero. That
// is wrong for units whose speed line is dead: KBV 403X on 2026-09-24 reported
// 0 km/h on every fix, ignition on, while covering 77 km, so its six "stops"
// swallowed the whole day and there was not one leg left. Position does not
// lie that way. So a stop here is a stretch of at least three minutes (the
// server's own minimum) where the unit covered ground slower than walking pace,
// measured from where it actually was.
//
// ## Distance
//
// Measured along the same points the map draws and with the server's rule for
// the day's total: nothing is counted across a reporting silence (`gapBefore`),
// because there is no evidence of a path there. So the legs add up to the trip,
// and the trip matches the figure the route line has always shown.

import { haversineM } from "./tripProgress";
import { indexAt } from "./playbackPath";

/** A stop is at least this long; the same minimum as the server's stops. */
const MIN_STOP_MS = 3 * 60_000;

/** Slower than this over a stretch, by position, is standing still. 3 km/h. */
const REST_MPS = 3 / 3.6;

/**
 * A leg shorter than this is shuffling around a yard or GPS drift, not a
 * journey. Numbering it would make "Leg 3 of 9" out of a unit that drove three
 * times.
 */
const MIN_LEG_M = 200;

/** Metres along the track at every point: `cum[i]` is the distance to point i. */
export function cumulativeM(points) {
  const cum = new Array(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const step = points[i].gapBefore ? 0 : haversineM(points[i - 1], points[i]);
    cum[i] = cum[i - 1] + step;
  }
  return cum;
}

/** Metres along the track at time `tMs`, interpolated between fixes. */
export function distanceAt(points, cum, tMs) {
  if (!points.length) return 0;
  const i = indexAt(points, tMs);
  if (i < 0) return 0;
  if (i >= points.length - 1) return cum[points.length - 1];
  const a = points[i], b = points[i + 1];
  // Held across a silence, the same as the marker (see sampleAt).
  if (b.gapBefore || b.t <= a.t) return cum[i];
  const f = Math.min(1, Math.max(0, (tMs - a.t) / (b.t - a.t)));
  return cum[i] + (cum[i + 1] - cum[i]) * f;
}

/**
 * Where the unit stood still, as `{ from, to }` spans of at least MIN_STOP_MS.
 *
 * Each step between two fixes is at rest when the straight line between them,
 * over the time between them, is below walking pace. That holds across a
 * silence too: a unit that went quiet and came back where it was was parked.
 * Consecutive resting steps join into one span.
 */
export function stopsOf(points) {
  const out = [];
  let from = null, to = null;
  const flush = () => {
    if (from != null && to - from >= MIN_STOP_MS) out.push({ from, to });
    from = null;
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const dt = (b.t - a.t) / 1000;
    const resting = dt > 0 && haversineM(a, b) / dt < REST_MPS;
    if (resting) {
      if (from == null) from = a.t;
      to = b.t;
    } else {
      flush();
    }
  }
  flush();
  return out;
}

/** The day's legs, in order: `{ from, to, startM, endM, distanceM }`. */
export function legsOf(points) {
  if (points.length < 2) return [];
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const cum = cumulativeM(points);

  const spans = [];
  let from = t0;
  for (const s of stopsOf(points)) {
    if (s.from > from) spans.push({ from, to: s.from });
    from = Math.max(from, s.to);
  }
  if (t1 > from) spans.push({ from, to: t1 });

  return spans
    .map((s) => {
      const startM = distanceAt(points, cum, s.from);
      const endM = distanceAt(points, cum, s.to);
      return { ...s, startM, endM, distanceM: endM - startM };
    })
    .filter((l) => l.distanceM >= MIN_LEG_M);
}

/**
 * Where the cursor is, in distance.
 *
 * `leg` is the leg being driven, or, while stopped, the one just finished
 * (`stopped: true`), so the read-out keeps saying which leg you are between
 * rather than blanking. Before the first leg starts it is null.
 */
export function legProgress(points, cum, legs, tMs) {
  const tripM = points.length ? cum[points.length - 1] : 0;
  const doneM = distanceAt(points, cum, tMs);
  let index = -1;
  for (let i = 0; i < legs.length; i++) {
    if (legs[i].from <= tMs) index = i; else break;
  }
  if (index < 0) return { tripM, doneM, leg: null, index: -1, count: legs.length };
  const leg = legs[index];
  const stopped = tMs > leg.to;
  const legDoneM = stopped ? leg.distanceM : Math.max(0, doneM - leg.startM);
  return { tripM, doneM, leg, legDoneM, index, count: legs.length, stopped };
}

/** Kilometres the way the panel prints them. */
export const km = (m) => (m / 1000).toFixed(1);
