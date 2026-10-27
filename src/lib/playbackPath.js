// Sampling a recorded track at an arbitrary instant.
//
// The playback cursor is a CLOCK, not an index. It has to answer "where was
// this machine at 09:41:03.250" for a time that falls between two fixes —
// which, at this fleet's ~28 s reporting cadence, is almost every frame. Both
// halves of that answer have a way of going subtly wrong, so both live here
// where they can be tested against fabricated shapes:
//
//   · POSITION between two fixes is a straight interpolation. That is honest:
//     it is the same claim the polyline already makes by joining them.
//   · HEADING is not. Bearings wrap, and a naive lerp from 350 to 10 sweeps
//     340 degrees the wrong way — the marker spins almost full circle at every
//     northward turn. It has to take the SHORT arc.
//
// Nothing here touches Google Maps or React, so a bad frame can be reproduced
// from a list of numbers.

/** Last index whose `t` is <= `tMs`, or -1. Binary search: called per frame. */
export function indexAt(points, tMs) {
  let lo = 0, hi = points.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= tMs) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return best;
}

/**
 * Interpolate a compass bearing along the SHORT arc.
 *
 * `((b - a + 540) % 360) - 180` is the signed delta in [-180, 180): 350->10
 * gives +20 rather than -340, and 10->350 gives -20. Without it a truck heading
 * just west of north spins the long way round on every fix, which reads as the
 * marker glitching rather than as the vehicle turning.
 */
export function lerpHeading(a, b, f) {
  if (a == null) return b ?? 0;
  if (b == null) return a;
  const delta = ((b - a + 540) % 360) - 180;
  return (a + delta * f + 360) % 360;
}

/**
 * Stretches the unit reported nothing for.
 *
 * Derived from `gapBefore`, which the server sets from real reporting silence
 * rather than from thinning — see findPlaybackFixes. A gap is the one place the
 * track makes no claim at all, so the cursor must not pretend to travel through
 * it (see `skipGaps` in the player).
 */
export function gapsOf(points) {
  const out = [];
  for (let i = 1; i < points.length; i++) {
    if (points[i].gapBefore) out.push({ from: points[i - 1].t, to: points[i].t, index: i });
  }
  return out;
}

/**
 * Where the unit was at `tMs`.
 *
 * Returns the fix itself at or after the last point, and null for an empty
 * track. `moving` is taken from the fix being interpolated FROM, because a
 * segment's character belongs to the leg, not to the instant.
 */
export function sampleAt(points, tMs) {
  if (points.length === 0) return null;
  const i = indexAt(points, tMs);
  if (i < 0) return { ...points[0], f: 0, index: 0 };
  if (i >= points.length - 1) {
    const last = points[points.length - 1];
    return { ...last, f: 1, index: points.length - 1 };
  }

  const a = points[i], b = points[i + 1];

  // Never interpolate ACROSS a silence. There is no evidence of a path between
  // these two fixes, so the honest position for any instant inside the gap is
  // where the unit was last actually seen — held, not slid toward a place it
  // may never have driven.
  if (b.gapBefore) return { ...a, f: 0, index: i, inGap: true };

  const span = b.t - a.t;
  const f = span > 0 ? (tMs - a.t) / span : 0;
  return {
    t: tMs,
    lat: a.lat + (b.lat - a.lat) * f,
    lng: a.lng + (b.lng - a.lng) * f,
    hdg: lerpHeading(a.hdg, b.hdg, f),
    // Speed and ignition are STEPPED, not blended. Both are states the unit
    // reported, and a half-way value between 0 and 40 km/h is a number nothing
    // measured — the readout would show speeds the machine never travelled at.
    spd: a.spd,
    eng: a.eng,
    f,
    index: i,
  };
}

/**
 * The path travelled up to `tMs`, as a polyline.
 *
 * Returns one array per continuous run, so the caller draws the same broken
 * shape the full route uses and a gap never gains a line just because playback
 * crossed it.
 */
export function travelledTo(points, tMs) {
  const runs = [];
  let run = [];
  for (const p of points) {
    if (p.t > tMs) break;
    if (p.gapBefore && run.length) { runs.push(run); run = []; }
    run.push({ lat: p.lat, lng: p.lng });
  }
  const head = sampleAt(points, tMs);
  if (head && run.length && !head.inGap) run.push({ lat: head.lat, lng: head.lng });
  if (run.length) runs.push(run);
  return runs;
}

/**
 * Bring a set of time-stamped map markers into step with the cursor.
 *
 * Playback reveals things as the clock reaches them — event pins and the time
 * ticks along the track — and the rule is the same for both, so it lives in
 * one place rather than being written twice in the effect that draws them.
 *
 * `entries` are mutated: each carries `shown`, which is what makes this cheap.
 * The comparison runs on every animation frame over a few hundred entries,
 * which is nothing; `setMap` is not, so `onChange` fires ONLY on the frame
 * where an entry actually crosses the cursor.
 *
 * The un-reveal half matters as much as the reveal. Scrubbing backwards is how
 * you re-watch something, and a pin that stayed up after the cursor moved back
 * before it would put the whole day on screen after one pass — which is the
 * state this whole change exists to remove.
 *
 * @param {{t:number, shown:boolean}[]} entries mutated in place
 * @param {number} tMs cursor
 * @param {(entry:object, due:boolean) => void} onChange called per transition
 * @returns {number} how many entries changed, for tests and for sanity
 */
export function syncReveal(entries, tMs, onChange) {
  let changed = 0;
  for (const e of entries) {
    const due = e.t <= tMs;
    if (due === e.shown) continue;
    e.shown = due;
    changed++;
    onChange(e, due);
  }
  return changed;
}

/** Metres between two {lat,lng}, on a sphere. Good to a metre at fleet scale. */
function metresApart(a, b) {
  const R = 6_371_000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Where the unit was at each whole minute of its day.
 *
 * The distance-spaced ticks answer "how fast was it along here"; these answer
 * "where was it at 13:07", which is a different question and needs a different
 * spacing — a unit that sat still for an hour has no distance to hang ticks on
 * and still has sixty minutes somebody may want to point at.
 *
 * Two rules keep the count honest:
 *
 *   - A minute inside a reporting silence is skipped. `sampleAt` holds the
 *     last known position across a gap, so a mark there would claim a place
 *     for a time we only know the clock of.
 *   - A minute whose position is within `minMoveM` of the previous mark is
 *     skipped. Sixty marks stacked on one pixel through a lunch stop is not
 *     sixty answers, it is one answer drawn sixty times, and it buries the
 *     track underneath it. The LAST mark before a move still lands, so the
 *     moment a unit set off is never the one that gets dropped.
 *
 * @param {{t:number,lat:number,lng:number,spd:number|null,hdg:number|null,eng:boolean}[]} points
 * @param {{stepMs?:number, minMoveM?:number}} [opts]
 */
export function minuteMarks(points, { stepMs = 60_000, minMoveM = 12 } = {}) {
  if (!points?.length || stepMs <= 0) return [];
  const first = points[0].t, last = points[points.length - 1].t;
  const out = [];
  let prev = null;

  // Start at the first whole step at or after the first fix, so the marks land
  // on the clock (13:07:00) rather than on an offset from whenever the unit
  // happened to report first.
  const start = Math.ceil(first / stepMs) * stepMs;
  for (let t = start; t <= last; t += stepMs) {
    const at = sampleAt(points, t);
    if (!at || at.inGap) continue;
    if (prev && metresApart(prev, at) < minMoveM) continue;
    out.push({ t, lat: at.lat, lng: at.lng, spd: at.spd ?? null, hdg: at.hdg ?? null, eng: at.eng });
    prev = at;
  }
  return out;
}

/**
 * Which of these GeoJSON features contain the point.
 *
 * Ray casting, even-odd, so a polygon with a hole reports the hole as outside
 * — which is what a yard with an excluded building in the middle of it means.
 * Written here rather than taken from Google's geometry library because that
 * library is not among the ones this map loads, and pulling it in for one
 * predicate would cost more than the predicate.
 *
 * Longitude is used as-is: these fences are a few kilometres across and none
 * of them crosses the antimeridian.
 */
export function zonesAt(point, features) {
  if (!point || !features?.length) return [];
  const inRing = (ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      const straddles = (yi > point.lat) !== (yj > point.lat);
      if (!straddles) continue;
      const x = ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
      if (point.lng < x) inside = !inside;
    }
    return inside;
  };
  const inPolygon = (rings) => rings.reduce((acc, r) => acc !== inRing(r), false);

  const hits = [];
  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    const polys = g.type === "Polygon" ? [g.coordinates]
      : g.type === "MultiPolygon" ? g.coordinates
      : null;
    if (!polys) continue;
    if (polys.some(inPolygon)) {
      const name = f.properties?.name;
      if (name) hits.push(String(name));
    }
  }
  return hits;
}
