/**
 * Fuel › Report — the advanced fuel analysis for one unit over a period.
 *
 * Pure: the unit's readings and its fuel ledger in, the report out. It is what
 * the ControlTech "Advanced Fuel Analysis" report answers — what the tank held
 * at the start and end, what went in, what went out, what the engine burned,
 * and where the machine was each minute — built from the same readings the
 * vehicle panel's chart draws, so the two can never disagree.
 *
 * ## Trips, stops and parkings
 *
 * The track is cut into three kinds of interval, as the report the operators
 * know cuts it:
 *
 *   trip     the unit moving (speed at or above MOVING_KMH)
 *   stop     standing still for less than PARKING_MS
 *   parking  standing still for PARKING_MS or longer
 *
 * A gap in the readings longer than GAP_MS ends whatever interval was running:
 * a unit that went dark for two hours did not drive or park for two hours as
 * far as we know, and drawing either would be a claim nobody made.
 *
 * ## The fuel figures
 *
 * Levels read off a fuel probe jump by litres from one reading to the next as
 * the diesel moves, so the level at the start and end of the period is the
 * MEDIAN of the first and last few readings, not the single first or last
 * one. Fillings and drains are the server's ledger, judged by its adjudicator
 * — this module does not decide what a drop was. Consumption is the tank
 * balance: start + filled − end − (drains the server called a theft).
 */

export const MOVING_KMH = 3;
export const PARKING_MS = 5 * 60_000;
export const GAP_MS = 20 * 60_000;
/** Hops shorter than this are GPS jitter, not travel (fleet-server's floor). */
const JITTER_M = 20;
/** Readings the start and end level are taken over. */
const EDGE_READINGS = 7;
/** Below this a probe is not reading a tank, it is reading nothing: a dead or
 *  disconnected probe reports 0.07–0.12 L (KTCC 872B, 30 Sep 22:29 onward),
 *  and taking that as the level reports a full tank as stolen. */
export const DEAD_PROBE_ML = 1000;
const readsFuel = (ml) => Number.isFinite(ml) && ml >= DEAD_PROBE_ML;

const R = 6_371_000;
const rad = (d) => (d * Math.PI) / 180;
export function haversineM(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const hasFix = (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lng) && !(p.lat === 0 && p.lng === 0);
const litres = (ml) => (Number.isFinite(ml) ? ml / 1000 : null);

function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Level in litres at the start / end of the readings, robust to slosh. */
export function edgeLevels(pings) {
  const lv = pings.filter((p) => readsFuel(p.fuelLevelMl));
  if (!lv.length) return { start: null, end: null };
  return {
    start: litres(median(lv.slice(0, EDGE_READINGS).map((p) => p.fuelLevelMl))),
    end: litres(median(lv.slice(-EDGE_READINGS).map((p) => p.fuelLevelMl))),
  };
}

/** The level nearest an instant, in litres, or null. */
function levelAt(pings, t) {
  let best = null;
  let bestD = Infinity;
  for (const p of pings) {
    if (!readsFuel(p.fuelLevelMl)) continue;
    const d = Math.abs(p.t - t);
    if (d < bestD) { bestD = d; best = p; }
    if (p.t > t && d > bestD) break;
  }
  return best && bestD <= 10 * 60_000 ? best.fuelLevelMl / 1000 : null;
}

/**
 * The track as trips, stops and parkings, in time order.
 * @returns {Array<{kind, start, end, durationMs, distanceKm, maxSpeedKmh,
 *   fuelStartL, fuelEndL, from, to}>}
 */
export function segmentTrack(pings, { movingKmh = MOVING_KMH, parkingMs = PARKING_MS, gapMs = GAP_MS } = {}) {
  const out = [];
  let cur = null;
  let prev = null;

  const close = () => {
    if (!cur) return;
    const durationMs = cur.end - cur.start;
    if (cur.moving) {
      if (cur.distanceM >= 50 || durationMs >= 60_000) {
        out.push({ ...cur, kind: 'trip', durationMs });
      }
    } else if (durationMs > 0) {
      out.push({ ...cur, kind: durationMs >= parkingMs ? 'parking' : 'stop', durationMs });
    }
    cur = null;
  };

  for (const p of pings) {
    if (!Number.isFinite(p.t)) continue;
    const moving = Number(p.speedKmh) >= movingKmh;
    if (prev && p.t - prev.t > gapMs) { close(); prev = null; }
    if (!cur || cur.moving !== moving) {
      close();
      cur = {
        moving, start: p.t, end: p.t, distanceM: 0, maxSpeedKmh: Number(p.speedKmh) || 0,
        from: hasFix(p) ? { lat: p.lat, lng: p.lng } : null, to: hasFix(p) ? { lat: p.lat, lng: p.lng } : null,
      };
    } else {
      cur.end = p.t;
      cur.maxSpeedKmh = Math.max(cur.maxSpeedKmh, Number(p.speedKmh) || 0);
      if (hasFix(p)) cur.to = { lat: p.lat, lng: p.lng };
    }
    if (prev && hasFix(prev) && hasFix(p) && moving) {
      const d = haversineM(prev, p);
      if (d >= JITTER_M) cur.distanceM += d;
    }
    prev = p;
  }
  close();

  return out.map(({ distanceM, ...s }) => ({
    ...s,
    moving: undefined,
    distanceKm: distanceM / 1000,
    fuelStartL: levelAt(pings, s.start),
    fuelEndL: levelAt(pings, s.end),
  }));
}

/** Engine-on time, summed between readings no further apart than GAP_MS. */
export function engineMs(pings, gapMs = GAP_MS) {
  let ms = 0;
  for (let i = 1; i < pings.length; i++) {
    const a = pings[i - 1];
    const dt = pings[i].t - a.t;
    if (a.engineOn === true && dt > 0 && dt <= gapMs) ms += dt;
  }
  return ms;
}

/** A filling the ledger counts as fuel put in: a refill, or not yet checked. */
export const countsAsFilling = (f) => f.verdict === 'REFILL' || f.verdict === 'PENDING' || f.verdict == null;
/** A drain the server called a possible theft — the only one subtracted as lost. */
export const isTheft = (d) => d.verdict === 'DRAIN' && d.drainCause === 'SIPHON';

/**
 * The whole report.
 * @param pings     time-ordered readings {t, lat, lng, speedKmh, engineOn, fuelLevelMl}
 * @param fillings  /fuel/fillings rows for the unit and period
 * @param drains    /fuel/thefts rows for the unit and period
 */
export function buildFuelReport({ pings = [], fillings = [], drains = [], from, to } = {}) {
  const rows = pings.filter((p) => Number.isFinite(p.t) && (from == null || p.t >= from) && (to == null || p.t < to));
  const segments = segmentTrack(rows);
  const trips = segments.filter((s) => s.kind === 'trip');
  const parkings = segments.filter((s) => s.kind === 'parking');
  const stops = segments.filter((s) => s.kind === 'stop');

  const { start: fuelStartL, end: fuelEndL } = edgeLevels(rows);

  const fills = fillings
    .filter(countsAsFilling)
    .map((f) => ({
      id: f.id,
      at: Date.parse(f.filledAt),
      location: f.location ?? null,
      beforeL: litres(f.initialFuelLevelMl),
      afterL: litres(f.finalFuelLevelMl),
      volumeL: litres(f.observedRiseMl ?? f.filledMl),
      verdict: f.verdict ?? 'PENDING',
    }))
    .sort((a, b) => a.at - b.at);

  const drops = drains
    .map((d) => {
      // A fall that ENDS on a dead-probe reading is the probe going dark, not
      // fuel leaving: the tank's next real reading is where it was. Kept in
      // the list (the server did raise it) but never counted as lost.
      const probeDropout = Number.isFinite(d.finalFuelLevelMl) && d.finalFuelLevelMl < DEAD_PROBE_ML;
      return {
        id: d.id,
        at: Date.parse(d.beganAt),
        location: d.initialLocation ?? null,
        beforeL: litres(d.initialFuelLevelMl),
        afterL: litres(d.finalFuelLevelMl),
        volumeL: litres(d.measuredDropMl ?? d.stolenMl),
        verdict: d.verdict ?? 'PENDING',
        cause: d.drainCause ?? null,
        theft: isTheft(d) && !probeDropout,
        probeDropout,
        moving: Number(d.initialSpeedKmh) > 0,
      };
    })
    .sort((a, b) => a.at - b.at);

  // The tank's balance: start + filled + unrecorded − theft − consumed = end.
  // Every term is rounded to the 0.1 L the report shows BEFORE consumed is
  // derived, so the figures on screen add up to the litre's tenth (unrounded,
  // 665.0 + 128.0 − 24.1 − 489.9 came out at 279.0, not the 279.1 shown).
  // Where the tank ends higher than start + fillings − theft allow, a rise
  // went unrecorded: consumed is nil and the rise is its own term, so the
  // balance still closes instead of hiding the gap behind a clamp.
  const r1 = (v) => (v == null ? null : Math.round(v * 10) / 10);
  const startL = r1(fuelStartL);
  const endL = r1(fuelEndL);
  const filledL = r1(fills.reduce((n, f) => n + (r1(f.volumeL) ?? 0), 0));
  const theftL = r1(drops.filter((d) => d.theft).reduce((n, d) => n + (r1(d.volumeL) ?? 0), 0));
  const gap = startL != null && endL != null ? r1(startL + filledL - theftL - endL) : null;
  const consumedL = gap == null ? null : Math.max(0, gap);
  const unrecordedL = gap == null ? null : Math.max(0, -gap);

  const distanceKm = trips.reduce((n, s) => n + s.distanceKm, 0);
  // Every reading, moving or not ("mileage in all messages"): what the
  // tracker's position covered, jitter under JITTER_M left out as in trips.
  let allM = 0;
  for (let i = 1, prev = rows.find(hasFix); i < rows.length; i += 1) {
    if (!hasFix(rows[i]) || !prev || rows[i] === prev) continue;
    const d = haversineM(prev, rows[i]);
    if (d >= JITTER_M) { allM += d; prev = rows[i]; }
  }
  const engineHours = engineMs(rows) / 3_600_000;
  const movingMs = trips.reduce((n, s) => n + s.durationMs, 0);
  const maxSpeedKmh = rows.reduce((m, p) => Math.max(m, Number(p.speedKmh) || 0), 0);

  return {
    from: rows[0]?.t ?? from ?? null,
    to: rows[rows.length - 1]?.t ?? to ?? null,
    readings: rows.length,
    segments,
    trips,
    parkings,
    stops,
    fillings: fills,
    drains: drops,
    stats: {
      fuelStartL: startL,
      fuelEndL: endL,
      filledL,
      unrecordedL,
      fillingCount: fills.length,
      theftL,
      theftCount: drops.filter((d) => d.theft).length,
      drainCount: drops.length,
      consumedL,
      distanceKm,
      allDistanceKm: allM / 1000,
      engineHours,
      movingHours: movingMs / 3_600_000,
      parkingHours: parkings.reduce((n, s) => n + s.durationMs, 0) / 3_600_000,
      tripCount: trips.length,
      parkingCount: parkings.length,
      stopCount: stops.length,
      maxSpeedKmh,
      avgSpeedKmh: movingMs > 0 ? distanceKm / (movingMs / 3_600_000) : null,
      // Per distance only when the unit actually travelled; per engine hour
      // only when the engine actually ran. A tractor working a field burns
      // per hour and barely moves; a lorry is the other way round.
      lPer100Km: consumedL != null && distanceKm >= 1 ? (consumedL / distanceKm) * 100 : null,
      lPerHour: consumedL != null && engineHours >= 0.25 ? consumedL / engineHours : null,
    },
  };
}

/**
 * The chart's line, thinned to about `max` points by keeping each bucket's
 * first, lowest and highest reading — a drop or a filling inside a bucket
 * survives the thinning, which a plain stride would cut out. So does every
 * reading where the engine came on or went off, so the engine line keeps its
 * steps.
 * Each point: {t, fuelL, fuelSmoothL, speedKmh, mileageKm, altitudeM, extVoltageV, intVoltageV,
 * engineOn}; engineOn is 1, 0, or null where the tracker did not say.
 */
export function chartSeries(pings, max = 1500) {
  const out = [];
  let km = 0;
  let prev = null;
  const all = [];
  for (const p of pings) {
    if (prev && hasFix(prev) && hasFix(p) && Number(p.speedKmh) >= MOVING_KMH) {
      const d = haversineM(prev, p);
      if (d >= JITTER_M) km += d / 1000;
    }
    prev = p;
    all.push({
      t: p.t,
      fuelL: readsFuel(p.fuelLevelMl) ? p.fuelLevelMl / 1000 : null,
      speedKmh: Number.isFinite(p.speedKmh) ? p.speedKmh : null,
      mileageKm: km,
      altitudeM: Number.isFinite(p.altitudeM) ? p.altitudeM : null,
      extVoltageV: Number.isFinite(p.extVoltageV) ? p.extVoltageV : null,
      intVoltageV: Number.isFinite(p.intVoltageV) ? p.intVoltageV : null,
      engineOn: p.engineOn === true ? 1 : p.engineOn === false ? 0 : null,
    });
  }
  smoothFuel(all);
  if (all.length <= max) return all;
  const per = Math.ceil(all.length / (max / 3));
  for (let i = 0; i < all.length; i += per) {
    const b = all.slice(i, i + per);
    const withFuel = b.filter((x) => x.fuelL != null);
    const keep = new Set([b[0]]);
    if (withFuel.length) {
      keep.add(withFuel.reduce((m, x) => (x.fuelL < m.fuelL ? x : m)));
      keep.add(withFuel.reduce((m, x) => (x.fuelL > m.fuelL ? x : m)));
    }
    for (let k = i; k < i + b.length; k += 1) {
      if (k > 0 && all[k].engineOn != null && all[k - 1].engineOn != null && all[k].engineOn !== all[k - 1].engineOn) keep.add(all[k]);
    }
    out.push(...[...keep].sort((a, b2) => a.t - b2.t));
  }
  return out;
}

/** Half the window the processed fuel level takes its median over. */
export const SMOOTH_HALF_MS = 150_000;

/**
 * The processed fuel level, `fuelSmoothL`: each reading's median over the
 * readings within SMOOTH_HALF_MS either side — Wialon's "processed fuel level".
 * A median, not a mean: slosh on a rough road is spikes either way, and a
 * median drops them where a mean smears them into the line; a filling or a
 * drain is a step, and a median keeps a step where it is.
 */
export function smoothFuel(points, halfMs = SMOOTH_HALF_MS) {
  let lo = 0;
  let hi = 0;
  const win = [];
  for (let i = 0; i < points.length; i += 1) {
    const t = points[i].t;
    while (hi < points.length && points[hi].t <= t + halfMs) {
      if (points[hi].fuelL != null) win.push(points[hi]);
      hi += 1;
    }
    while (lo < i && points[lo].t < t - halfMs) {
      if (points[lo].fuelL != null) win.splice(win.indexOf(points[lo]), 1);
      lo += 1;
    }
    if (points[i].fuelL == null || !win.length) { points[i].fuelSmoothL = null; continue; }
    const v = win.map((x) => x.fuelL).sort((a, b) => a - b);
    const m = v.length >> 1;
    points[i].fuelSmoothL = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  return points;
}

/** "2h 05m", "45m", "0m". */
export function durationLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
