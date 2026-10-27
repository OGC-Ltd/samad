// One unit's fleet day of readings, for the vehicle panel's fuel & overspeed
// chart and the figures beside it.
//
// ## Why this is not the telemetry list any more
//
// The panel used to walk GET …/telemetry 500 full rows at a time, one page
// after another: a busy unit was six sequential round trips and ~1.5 MB of JSON
// before anything drew, and it did it again every time the panel opened.
//
// Now:
//   1. GET …/telemetry/day returns the day as columns in ONE request (~20× less
//      JSON). Where the server does not have that route yet, the old list is
//      read as parallel time slices instead of one page after another.
//   2. Every day read is kept for the session. A finished day never changes, so
//      reopening it costs nothing; for today only the rows after the last one
//      held are fetched.
//   3. Two readers of the same day (Overview and the Fuel tab) share one request.

import { apiFetch } from '../services/api';

const PAGE = 500;       // the list route's maximum page
const SLICE_MS = 2 * 3600_000; // fallback window: ~370 rows at a 20 s cadence, one page
const MAX_SLICES = 12;
const SLICE_PAGES = 6;  // pages per window before giving up on it

const cache = new Map();     // key -> { pings, complete }
const inflight = new Map();  // key -> Promise
let dayRoute = null;         // null = not tried, true / false once known

const keyOf = (orgId, vehicleId, dayKey) => `${orgId}|${vehicleId}|${dayKey}`;

/** Fleet days run on Nairobi time (UTC+3). */
export function dayBounds(dayKey) {
  const start = Date.parse(`${dayKey}T00:00:00.000Z`) - 3 * 3600_000;
  return { start, end: start + 86_400_000 };
}

/** What is already held for a day, or null. Synchronous, for first paint. */
export function cachedDay(orgId, vehicleId, dayKey) {
  return cache.get(keyOf(orgId, vehicleId, dayKey)) ?? null;
}

/** The server's columns, back into the ping objects the panel works with. */
export function decodeColumns(d) {
  const out = [];
  const n = d?.t?.length ?? 0;
  for (let i = 0; i < n; i++) {
    const eng = d.eng?.[i];
    out.push({
      t: d.from + d.t[i] * 1000,
      lat: d.lat?.[i] ?? null,
      lng: d.lng?.[i] ?? null,
      speedKmh: d.spd?.[i] ?? null,
      engineOn: eng == null ? null : eng === 1,
      fuelLevelMl: d.fuelMl?.[i] ?? null,
      engineHoursMeter: d.hrs?.[i] ?? null,
      altitudeM: d.alt?.[i] ?? null,
      extVoltageV: d.vext?.[i] ?? null,
      intVoltageV: d.vint?.[i] ?? null,
      // Only for an org whose limit depends on place (Kasulu: 60 in the
      // factory, 100 on the roads); null means the unit's one limit applies.
      limitKmh: d.lim?.[i] ?? null,
    });
  }
  return out;
}

/** Appends rows newer than the last one held; the result stays time-ordered. */
export function mergeNewer(held, incoming) {
  const last = held.length ? held[held.length - 1].t : -Infinity;
  const fresh = incoming.filter((p) => p.t > last);
  return fresh.length ? [...held, ...fresh] : held;
}

async function readDayRoute(orgId, vehicleId, dayKey, since, signal) {
  const q = `day=${dayKey}${since != null ? `&since=${since}` : ''}`;
  const res = await apiFetch(`/api/v1/organisations/${orgId}/vehicles/${vehicleId}/telemetry/day?${q}`, { signal });
  const d = res.data ?? {};
  return { pings: decodeColumns(d), complete: Boolean(d.complete) };
}

/** The old list route, but its windows read side by side. */
async function readSlices(orgId, vehicleId, dayKey, since, signal) {
  const { start, end } = dayBounds(dayKey);
  const from = since != null ? since + 1 : start;
  const until = Math.min(end, Date.now() + 60_000);
  // One page per window where possible: a second page is another round trip,
  // and the browser only runs six requests to one host at a time.
  const n = since != null ? 1 : Math.min(MAX_SLICES, Math.max(1, Math.ceil((until - from) / SLICE_MS)));
  const width = Math.max(1, Math.ceil((until - from) / n));
  const base = `/api/v1/organisations/${orgId}/vehicles/${vehicleId}/telemetry?limit=${PAGE}`;

  const slice = async (a, b) => {
    const rows = [];
    let cursor = null;
    for (let page = 0; page < SLICE_PAGES; page++) {
      const url = `${base}&from=${new Date(a).toISOString()}&to=${new Date(b).toISOString()}${cursor ? `&cursor=${cursor}` : ''}`;
      const res = await apiFetch(url, { signal });
      rows.push(...(res.data ?? []));
      cursor = res.meta?.hasNextPage ? res.meta.cursor : null;
      if (!cursor) break;
    }
    return rows;
  };

  const windows = [];
  // `to` is inclusive on this route, so each window stops 1 ms short of the next.
  for (let a = from; a < until; a += width) windows.push(slice(a, Math.min(until, a + width) - 1));
  const rows = (await Promise.all(windows)).flat();

  const seen = new Set();
  const pings = [];
  for (const p of rows) {
    const t = Date.parse(p.capturedAt);
    if (!Number.isFinite(t) || t < from || t >= end || seen.has(t)) continue;
    seen.add(t);
    pings.push({ ...p, t });
  }
  pings.sort((x, y) => x.t - y.t);
  return { pings, complete: end <= Date.now() };
}

async function read(orgId, vehicleId, dayKey, since, signal) {
  if (dayRoute !== false) {
    try {
      const r = await readDayRoute(orgId, vehicleId, dayKey, since, signal);
      dayRoute = true;
      return r;
    } catch (err) {
      // A server without the route answers 404; anything else is a real failure.
      if (dayRoute === true || err?.status !== 404) throw err;
      dayRoute = false;
    }
  }
  return readSlices(orgId, vehicleId, dayKey, since, signal);
}

/**
 * The day's pings, from the session cache where possible. Resolves to
 * `{ pings, complete }`. Concurrent calls for the same day share one request.
 */
export function loadDay(orgId, vehicleId, dayKey) {
  const key = keyOf(orgId, vehicleId, dayKey);
  const held = cache.get(key);
  if (held?.complete) return Promise.resolve(held);
  if (inflight.has(key)) return inflight.get(key);

  const since = held?.pings.length ? held.pings[held.pings.length - 1].t : null;
  const p = read(orgId, vehicleId, dayKey, since, undefined)
    .then((r) => {
      const next = { pings: held ? mergeNewer(held.pings, r.pings) : r.pings, complete: r.complete };
      cache.set(key, next);
      return next;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Tests only. */
export function _resetVehicleDay() {
  cache.clear();
  inflight.clear();
  dayRoute = null;
}

// ── What a day of pings says ────────────────────────────────────────────────

const IDLE_SPEED_KMH = 3;            // engine on and slower than this = idling
const MOVING_KMH     = 3;
const MAX_GAP_MS     = 10 * 60_000;  // no evidence across a longer silence
const MAX_KMH        = 200;          // a hop implying more than this is a GPS jump
const REFILL_WINDOW_MS = 20 * 60_000;

function metresBetween(a, b) {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad * Math.cos(((a.lat + b.lat) / 2) * toRad);
  return R * Math.sqrt(dLat * dLat + dLng * dLng);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : null;
}

/**
 * Litres used and litres added, read off the tank level when the unit has no
 * consumption counter (none in this fleet does).
 *
 * Used = start level − end level + everything added. Adding up every small
 * drop instead would count probe slosh as consumption many times over; taking
 * the ends cancels it. The ends are medians of five readings for the same
 * reason. A refill is a rise of at least `minRefillL` within 20 minutes.
 */
export function fuelFromLevel(pings, tankL) {
  const lv = pings.filter((p) => Number.isFinite(p.fuelLevelMl)).map((p) => ({ t: p.t, l: p.fuelLevelMl / 1000 }));
  if (lv.length < 10) return { usedL: null, refilledL: null };
  const minRefillL = Math.max(10, (tankL ?? 0) * 0.05);

  // Rolling median of 5 to take the slosh out before looking for rises.
  const smooth = lv.map((_, i) => ({ t: lv[i].t, l: median(lv.slice(Math.max(0, i - 2), i + 3).map((x) => x.l)) }));

  let refilledL = 0;
  let i = 0;
  while (i < smooth.length) {
    let j = i;
    let k = i + 1;
    // Walk forward while the level keeps rising inside the window.
    while (k < smooth.length && smooth[k].t - smooth[i].t <= REFILL_WINDOW_MS) {
      if (smooth[k].l > smooth[j].l) j = k;
      k++;
    }
    const rise = smooth[j].l - smooth[i].l;
    if (rise >= minRefillL) { refilledL += rise; i = j + 1; } else { i++; }
  }

  const startL = median(lv.slice(0, 5).map((x) => x.l));
  const endL = median(lv.slice(-5).map((x) => x.l));
  const usedL = startL - endL + refilledL;
  return { usedL: usedL >= 0 ? usedL : null, refilledL };
}

/**
 * Where and when a unit set off today, and how far it has gone since — the
 * unit card's start row (operator, 28 Sep: "the start and the current
 * location, departed will be the time they start, outbound will be the
 * distance covered since start"). The start is the day's first moving
 * reading with a position, the same one the vehicle panel's "Departed" names,
 * so the card and the panel cannot give two different times. Nothing before
 * it moved, so the distance since it is the day's distance. `start` is null
 * on a day the unit has not moved.
 */
export function journeySoFar(pings, tankL = null) {
  const s = summariseDay(pings, tankL);
  const start = s.firstMove ? { t: s.firstMove.t, lat: s.firstMove.lat, lng: s.firstMove.lng } : null;
  return { start, km: start ? s.distanceKm ?? 0 : 0, burn: burnRate(s) };
}

const MIN_BURN_HOURS = 0.5;   // less engine time than this gives a noisy rate
const MIN_BURN_KM    = 5;
const MIN_BURN_L     = 1;

/**
 * How fast the unit is burning fuel, from a day's summary (summariseDay):
 * litres per engine hour and litres per kilometre — always litres first
 * (operator 2026-10-19: "always state L/h or L/km"). The unit card and the
 * vehicle panel both show it, so they read the same figures.
 *
 * Engine time is the engine-hours meter where it ticked, else the time the
 * readings say the engine was on. Used litres come from the tank level, so a
 * theft that day shows as a higher burn. Each rate is null when the day is too
 * thin to support it, and the whole is null when neither is.
 */
export function burnRate(sum) {
  if (!sum || sum.usedL == null || sum.usedL < MIN_BURN_L) return null;
  const meter = sum.engineHoursToday != null && sum.engineHoursToday >= MIN_BURN_HOURS ? sum.engineHoursToday : null;
  const hours = meter ?? (sum.engineOnMin != null ? sum.engineOnMin / 60 : null);
  const lPerH = hours != null && hours >= MIN_BURN_HOURS ? sum.usedL / hours : null;
  const lPerKm = sum.distanceKm != null && sum.distanceKm >= MIN_BURN_KM ? sum.usedL / sum.distanceKm : null;
  if (lPerH == null && lPerKm == null) return null;
  return { lPerH, lPerKm, usedL: sum.usedL, hours: lPerH != null ? hours : null, hoursFrom: lPerH == null ? null : meter != null ? 'meter' : 'engine' };
}

/**
 * When the unit was moving, as [{ start, end }] spans — the same rule as
 * summariseDay's movingMin (a reading at walking pace or faster, up to the
 * next reading, across no silence longer than MAX_GAP_MS), so the Safety tab's
 * day strip and its "moving" figure agree. Spans that touch are one.
 */
export function movingSpans(pings) {
  const spans = [];
  for (let i = 1; i < pings.length; i++) {
    const prev = pings[i - 1];
    const p = pings[i];
    const gap = p.t - prev.t;
    if (gap <= 0 || gap > MAX_GAP_MS || (prev.speedKmh ?? 0) < MOVING_KMH) continue;
    const last = spans[spans.length - 1];
    if (last && last.end === prev.t) last.end = p.t;
    else spans.push({ start: prev.t, end: p.t });
  }
  return spans;
}

/**
 * Everything the panel shows about one day, from its pings. Each figure is null
 * when the pings cannot support it — never zero by default.
 */
export function summariseDay(pings, tankL) {
  const empty = {
    series: [], unit: tankL ? '%' : 'L', usedL: null, usedSource: null, refilledL: null,
    idleMin: null, movingMin: null, engineOnMin: null, distanceKm: null, engineHoursToday: null, topSpeed: null, firstMove: null,
  };
  if (!pings.length) return empty;

  // Fuel line: % of tank where the tank size is known, else litres. Menengai
  // records a tank size for 8 of 244 units, so % alone left the chart empty
  // for nearly the whole fleet while the probe was reporting fine. `l` is the
  // litres either way, for the chart's crosshair.
  const withFuel = pings.filter((p) => Number.isFinite(p.fuelLevelMl));
  const series = tankL
    ? withFuel.map((p) => ({ t: p.t, v: (p.fuelLevelMl / 1000 / tankL) * 100, l: p.fuelLevelMl / 1000 })).filter((p) => p.v >= 0 && p.v <= 110)
    : withFuel.map((p) => ({ t: p.t, v: p.fuelLevelMl / 1000, l: p.fuelLevelMl / 1000 })).filter((p) => p.v >= 0);

  // Fuel used: the device's counter where it has one, else the tank level.
  const counter = pings.filter((p) => Number.isFinite(p.fuelUsedMl));
  let usedL = null;
  let usedSource = null;
  let refilledL = null;
  if (counter.length >= 2 && counter[counter.length - 1].fuelUsedMl >= counter[0].fuelUsedMl) {
    usedL = (counter[counter.length - 1].fuelUsedMl - counter[0].fuelUsedMl) / 1000;
    usedSource = 'counter';
  }
  const lvl = fuelFromLevel(pings, tankL);
  if (usedL == null && lvl.usedL != null) { usedL = lvl.usedL; usedSource = 'level'; }
  refilledL = lvl.refilledL;

  let idleMs = 0, movingMs = 0, onMs = 0, metres = 0;
  let sawEngine = false, sawPosition = false, topSpeed = null, firstMove = null;
  for (let i = 0; i < pings.length; i++) {
    const p = pings[i];
    if (Number.isFinite(p.speedKmh)) topSpeed = Math.max(topSpeed ?? 0, p.speedKmh);
    if (!firstMove && (p.speedKmh ?? 0) >= MOVING_KMH && Number.isFinite(p.lat)) firstMove = p;
    if (i === 0) continue;
    const prev = pings[i - 1];
    if (prev.engineOn != null) sawEngine = true;
    const gap = p.t - prev.t;
    if (gap <= 0 || gap > MAX_GAP_MS) continue;
    const moving = (prev.speedKmh ?? 0) >= MOVING_KMH || (p.speedKmh ?? 0) >= MOVING_KMH;
    if (prev.engineOn) onMs += gap;
    if (prev.engineOn && (prev.speedKmh ?? 0) < IDLE_SPEED_KMH) idleMs += gap;
    if ((prev.speedKmh ?? 0) >= MOVING_KMH) movingMs += gap;
    if (moving && Number.isFinite(prev.lat) && Number.isFinite(p.lat)) {
      sawPosition = true;
      const m = metresBetween(prev, p);
      if (m / (gap / 3_600_000) / 1000 <= MAX_KMH) metres += m;
    }
  }

  const hrs = pings.filter((p) => Number.isFinite(p.engineHoursMeter));
  const engineHoursToday = hrs.length >= 2 && hrs[hrs.length - 1].engineHoursMeter >= hrs[0].engineHoursMeter
    ? hrs[hrs.length - 1].engineHoursMeter - hrs[0].engineHoursMeter
    : null;
  const anySpeed = pings.some((p) => Number.isFinite(p.speedKmh));

  return {
    series,
    unit: tankL ? '%' : 'L',
    usedL,
    usedSource,
    refilledL,
    idleMin: sawEngine ? idleMs / 60_000 : null,
    movingMin: anySpeed ? movingMs / 60_000 : null,
    engineOnMin: sawEngine ? onMs / 60_000 : null,
    distanceKm: sawPosition || anySpeed ? metres / 1000 : null,
    engineHoursToday,
    topSpeed,
    firstMove,
  };
}

/** Over the standard by more than this reads as burning too much. */
export const BURN_OVER_SHARE = 0.15;

/**
 * Today's burn against the unit's standard from the FactorySuite register
 * (vehicleMap `ratedBurn`, KASULU only). On an HOURS basis it compares L/h;
 * on DISTANCE, L/km — the register states km/L, turned round here so the
 * card always reads litres first. `over` is how much more fuel the unit used
 * than the standard allows, as a share (0.2 = 20% more; negative = less).
 * `digits` is how many decimals the rate is shown to (L/km sits near 0.4). Null when the unit is unrated; `today` and `over`
 * null when today's rate in that unit cannot be measured yet.
 */
export function burnAgainst(burn, ratedBurn) {
  if (!ratedBurn || !(ratedBurn.value > 0)) return null;
  const hours = ratedBurn.basis === 'HOURS';
  const unit = hours ? 'L/h' : 'L/km';
  const std = hours ? ratedBurn.value : 1 / ratedBurn.value;
  const today = (hours ? burn?.lPerH : burn?.lPerKm) ?? null;
  const over = today == null || !(today > 0) ? null : today / std - 1;
  return { unit, digits: hours ? 1 : 2, std, today, over, high: over != null && over > BURN_OVER_SHARE };
}

/** "18% over standard" / "6% under standard" / "on standard". */
export function overWords(over) {
  const pct = Math.round(Math.abs(over) * 100);
  if (pct === 0) return 'on standard';
  return `${pct}% ${over > 0 ? 'over' : 'under'} standard`;
}
