// Live traffic for the fleet map: TomTom's flow and incident tiles, and its
// traffic-aware routing for the ETA of a unit on an active trip.
//
// Operator, 2026-10-04: control room cannot tell whether a late truck is stuck
// in traffic or stopped for some other reason, and the trip ETA was a straight
// line divided by the current speed (lib/tripProgress tripEta). This module
// answers both from one provider, over the Leaflet + OpenStreetMap map.
//
// ## The key is in the browser, for now
//
// VITE_MYTOMTOM_API_KEY ships in the bundle. Tiles have to be fetched by the
// browser anyway, so for them that is normal (restrict the key to the site's
// domain in the TomTom dashboard). Routing is the part worth moving behind
// fleet-server once fleet-wide ETAs are wanted: one cached route per unit
// shared by every viewer, instead of one per open card. Until then routing is
// only ever asked for the unit whose card is open, every ROUTE_REFRESH_MS.
//
// ## Quota
//
// Free tier: 2,500 routing calls and 50,000 tiles a day. One open card costs
// 30 routes an hour; the traffic layer costs ~20-40 tiles per screen of map,
// refetched every TILE_REFRESH_MS while it is on.

import { haversineM } from "./tripProgress";

/**
 * TomTom, switched off (operator, 2026-10-09: "we need to disable mytomtom").
 *
 * The one switch for all of it. Every TomTom call in the app is gated on
 * TRAFFIC_AVAILABLE — the map's Live traffic layer and its rail button, the
 * pinned unit's routed line, the unit panel's Arrives row, the delivery card's
 * traffic ETA and the route-covered expected time — so with this false none of
 * them renders and no request reaches api.tomtom.com, key or no key. A stored
 * `traffic: true` map pref is ignored rather than rewritten, so flipping this
 * back restores each viewer's own choice. Nothing below it was removed.
 */
export const TOMTOM_ENABLED = false;

export const TOMTOM_KEY = (import.meta.env.VITE_MYTOMTOM_API_KEY ?? "").trim();
export const TRAFFIC_AVAILABLE = TOMTOM_ENABLED && TOMTOM_KEY.length > 0;

/** TomTom recomputes flow about once a minute; two is plenty for a map. */
export const TILE_REFRESH_MS = 2 * 60_000;
export const ROUTE_REFRESH_MS = 2 * 60_000;

const API = "https://api.tomtom.com";

/** Speed relative to free flow: green free, orange slow, red jammed, dark red
 *  closed. `relative0` draws free-flowing roads too, the look an operator
 *  knows from Google's traffic layer. No cache-buster: TomTom serves tiles
 *  no-store, and `t` is its traffic-model id (a stale one is a 400). */
export const FLOW_TILE_URL =
  `${API}/traffic/map/4/tile/flow/relative0/{z}/{x}/{y}.png?key=${TOMTOM_KEY}&tileSize=256`;
/** Accidents, closures, road works: icons and hatched stretches. */
export const INCIDENT_TILE_URL =
  `${API}/traffic/map/4/tile/incidents/s3/{z}/{x}/{y}.png?key=${TOMTOM_KEY}`;

/** The layer menu's key, in the flow tiles' own colours. */
export const TRAFFIC_LEGEND = [
  { key: "free",   color: "#4ec84e", label: "Free flow" },
  { key: "slow",   color: "#f5a623", label: "Slow" },
  { key: "jam",    color: "#e5322d", label: "Queuing" },
  { key: "closed", color: "#8b1a1a", label: "Stationary / closed" },
];

/** Colour for a traffic section on a routed line, by TomTom's 0-4 magnitude. */
export const JAM_COLOR = ["#f5a623", "#f5a623", "#f07d1a", "#e5322d", "#8b1a1a"];
export const ROUTE_COLOR = "#2563eb";

/** Light vehicles route as cars; everything else here (lorries, tractors,
 *  trailers, canters, loaders) as a truck, so truck-banned roads are avoided.
 *  vehicleType is the provider's free text: "LORRY & TRAILER", "SALOON", … */
const LIGHT = /saloon|pick-?up|lmv|light|car|suv|van|station wagon/i;
export const travelModeFor = (vehicleType) => (LIGHT.test(String(vehicleType ?? "")) ? "car" : "truck");

const CATEGORY_LABEL = {
  JAM: "Queuing traffic",
  ROAD_WORK: "Road works",
  ROAD_CLOSURE: "Road closed",
  OTHER: "Incident",
};

/**
 * Route from where the unit is now to where it is going, with live traffic.
 *
 * @param {{lat:number,lng:number}} from
 * @param {{lat:number,lng:number}} to
 * @param {{travelMode?:'car'|'truck', signal?:AbortSignal}} [opts]
 * @returns {Promise<TrafficRoute>}
 *
 * @typedef {object} TrafficRoute
 * @property {number} lengthM          road distance
 * @property {number} travelS          with live traffic
 * @property {number} noTrafficS       the same road, empty
 * @property {number} delayS           travelS − free flow, as TomTom reports it
 * @property {number} arrivalMs
 * @property {number} fetchedAt
 * @property {{lat:number,lng:number}[]} points
 * @property {Jam[]} jams
 *
 * @typedef {object} Jam
 * @property {{lat:number,lng:number}[]} points
 * @property {number} delayS
 * @property {number|null} speedKmh   effective speed through it
 * @property {number} magnitude       0 unknown … 4 closed
 * @property {string} label
 * @property {number} startM          distance along the route to its start
 */
export async function fetchTrafficRoute(from, to, { travelMode = "truck", signal } = {}) {
  if (!TRAFFIC_AVAILABLE) throw new Error("No TomTom key configured");
  const q = new URLSearchParams({
    key: TOMTOM_KEY,
    traffic: "true",
    departAt: "now",
    travelMode,
    routeType: "fastest",
    sectionType: "traffic",
    computeTravelTimeFor: "all",
  });
  const path = `${from.lat},${from.lng}:${to.lat},${to.lng}`;
  const res = await fetch(`${API}/routing/1/calculateRoute/${path}/json?${q}`, { signal });
  if (!res.ok) {
    let msg = `TomTom routing ${res.status}`;
    try { msg = (await res.json())?.error?.description ?? msg; } catch { /* body not JSON */ }
    throw new Error(msg);
  }
  return parseRoute(await res.json());
}

/** The response, reduced to what the map and the card draw. Exported for tests. */
export function parseRoute(json, now = Date.now()) {
  const r = json?.routes?.[0];
  if (!r) throw new Error("No route found");
  const s = r.summary;
  const points = (r.legs ?? []).flatMap((leg) =>
    (leg.points ?? []).map((p) => ({ lat: p.latitude, lng: p.longitude })));

  // Cumulative distance, so a jam can say how far ahead it is.
  const along = [0];
  for (let i = 1; i < points.length; i++) along[i] = along[i - 1] + haversineM(points[i - 1], points[i]);

  const jams = (r.sections ?? [])
    .filter((x) => x.sectionType === "TRAFFIC")
    .map((x) => ({
      points: points.slice(x.startPointIndex, x.endPointIndex + 1),
      delayS: x.delayInSeconds ?? 0,
      speedKmh: x.effectiveSpeedInKmh ?? null,
      magnitude: x.magnitudeOfDelay ?? 0,
      label: CATEGORY_LABEL[x.simpleCategory] ?? "Slow traffic",
      startM: along[x.startPointIndex] ?? 0,
    }))
    .filter((j) => j.points.length >= 2);

  return {
    lengthM: s.lengthInMeters,
    travelS: s.travelTimeInSeconds,
    noTrafficS: s.noTrafficTravelTimeInSeconds ?? s.travelTimeInSeconds - (s.trafficDelayInSeconds ?? 0),
    delayS: Math.max(0, s.trafficDelayInSeconds ?? 0),
    arrivalMs: Date.parse(s.arrivalTime) || now + s.travelTimeInSeconds * 1000,
    fetchedAt: now,
    points,
    jams,
  };
}

/** Within this of a jam's start (or inside it), a stopped unit is in it. */
const IN_JAM_M = 400;
/** Below this a unit is stopped — the same floor tripProgress uses. */
const MOVING_KMH = 5;
/** Under a minute of delay is noise in TomTom's own model. */
const DELAY_FLOOR_S = 60;

/**
 * Why the unit is (or is not) losing time, in the operator's words.
 *
 * Traffic can only be blamed where there is traffic AT the unit: a truck
 * standing still with the road ahead of it flowing is stopped for some other
 * reason — loading, a breakdown, the driver — and saying "traffic" there would
 * hide exactly the delay the control room needs to chase.
 *
 * @param {TrafficRoute|null} route
 * @param {number|null} speedKmh
 * @returns {{kind:'traffic-here'|'stopped-clear'|'traffic-ahead'|'clear', text:string}|null}
 */
export function delayCause(route, speedKmh) {
  if (!route) return null;
  const moving = Number.isFinite(speedKmh) && speedKmh >= MOVING_KMH;
  // No traffic sections (Google's basic route, jams === null): the delay is
  // known for the route as a whole but not WHERE it is, so nothing can be said
  // about traffic at the unit, and a stopped unit gets no verdict at all.
  if (route.jams == null) {
    if (!moving) return null;
    return route.delayS >= DELAY_FLOOR_S
      ? { kind: "traffic-ahead", text: `Traffic on the route · +${Math.max(1, Math.round(route.delayS / 60))} m` }
      : { kind: "clear", text: "No traffic delay on the route" };
  }
  const first = route.jams[0] ?? null;
  const atJam = first != null && first.startM <= IN_JAM_M;
  const mins = (s) => Math.max(1, Math.round(s / 60));

  if (!moving && atJam) {
    return { kind: "traffic-here", text: `Stopped in traffic · ${first.label.toLowerCase()}` };
  }
  if (!moving) {
    return { kind: "stopped-clear", text: "Stopped · no traffic at its position" };
  }
  if (route.delayS >= DELAY_FLOOR_S && first) {
    const km = first.startM < 1000 ? "here" : `in ${(first.startM / 1000).toFixed(first.startM < 10_000 ? 1 : 0)} km`;
    return { kind: "traffic-ahead", text: `${first.label} ${km} · +${mins(route.delayS)} m` };
  }
  return { kind: "clear", text: "No traffic delay on the route" };
}


// ── Route covered: how long it took vs how long it should have taken ──────────
//
// Operator, 2026-10-04: when "Show the route covered" is clicked, "compute and
// get the time that should have been covered based on the data available".
// The unit's own fixes give the path, the distance and the real time; TomTom
// rebuilds the SAME path on the road network (supportingPoints) and says how
// long it takes at that time of day from its historic speeds.

/** A pair of fixes further apart than this is a reporting gap, not a stop. */
const GAP_S = 15 * 60;
/** m/s — 5 km/h, the same moving floor as everywhere else. */
const MOVING_MPS = 5 / 3.6;

/**
 * Split a track into driving, stopped and silent time, over the stretch from
 * the first fix it moved at to the last one (parked hours either side are not
 * part of the journey).
 *
 * @param {{t:number,lat:number,lng:number,spd?:number,gapBefore?:boolean}[]} points  oldest first
 * @returns {null | {startMs:number, endMs:number, spanS:number, drivingS:number,
 *   stoppedS:number, silentS:number, km:number, path:{lat:number,lng:number,t:number}[]}}
 */
export function trackJourney(points) {
  if (!points || points.length < 2) return null;
  const moved = (a, b) => {
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) return false;
    return (b.spd ?? 0) >= 5 || haversineM(a, b) / dt >= MOVING_MPS;
  };
  let first = -1, last = -1;
  for (let i = 1; i < points.length; i++) {
    if (!points[i].gapBefore && (points[i].t - points[i - 1].t) / 1000 <= GAP_S && moved(points[i - 1], points[i])) {
      if (first < 0) first = i - 1;
      last = i;
    }
  }
  if (first < 0) return null;

  const path = points.slice(first, last + 1);
  let drivingS = 0, stoppedS = 0, silentS = 0, m = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const dt = (b.t - a.t) / 1000;
    const d = haversineM(a, b);
    if (b.gapBefore || dt > GAP_S) { silentS += dt; m += d; continue; }
    if (moved(a, b)) drivingS += dt; else stoppedS += dt;
    m += d;
  }
  return {
    startMs: path[0].t,
    endMs: path[path.length - 1].t,
    spanS: (path[path.length - 1].t - path[0].t) / 1000,
    drivingS, stoppedS, silentS,
    km: m / 1000,
    path,
  };
}

/** The path thinned to points at least `minM` apart, at most `max` of them —
 *  enough for TomTom to follow the same roads, without GPS scatter. */
export function thinPath(path, max = 400) {
  let minM = 150;
  for (;;) {
    const out = [path[0]];
    for (const p of path) if (haversineM(out[out.length - 1], p) >= minM) out.push(p);
    const end = path[path.length - 1];
    if (out[out.length - 1] !== end) out.push(end);
    if (out.length <= max) return out;
    minM *= 1.6;
  }
}

/** The next moment, from now, on the same weekday and clock time as `ms` —
 *  TomTom will not price a departure in the past, and its historic speeds are
 *  by weekday and time, so a week-on departure asks the same question. */
export function sameSlotAhead(ms, now = Date.now()) {
  let t = ms;
  while (t < now + 5 * 60_000) t += 7 * 86_400_000;
  return t;
}

/** A stop at least this long ends a leg. */
const LEG_STOP_S = 120;
/** A change of direction sharper than this (degrees) is a turnaround. */
const TURNAROUND_DEG = 135;
/** At most this many legs go to TomTom; the rest are scaled from them. */
const MAX_ROUTED_LEGS = 15;

const bearing = (a, b) => {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
};
const turn = (b1, b2) => { const d = Math.abs(b1 - b2) % 360; return d > 180 ? 360 - d : d; };
const pathM = (path) => { let m = 0; for (let i = 1; i < path.length; i++) m += haversineM(path[i - 1], path[i]); return m; };

/**
 * The journey cut into legs: at every stop of LEG_STOP_S or more, every
 * reporting gap, and every turnaround.
 *
 * Operator, 2026-10-04: "route could be covered back and forth". One
 * start-to-end route over an out-and-back path made TomTom invent U-turn
 * detours (KCJ 050H: 120.8 km by road for 46.9 km driven). Each leg is a
 * one-way drive, which is what a routing engine can time.
 *
 * @returns {{path:{lat:number,lng:number,t:number}[], m:number}[]}
 */
export function journeyLegs(journey) {
  const pts = journey.path;
  // 1. Split at stops and gaps.
  const runs = [];
  let run = [pts[0]], still = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dt = (b.t - a.t) / 1000;
    const moving = dt > 0 && ((b.spd ?? 0) >= 5 || haversineM(a, b) / dt >= MOVING_MPS);
    if (b.gapBefore || dt > GAP_S) { runs.push(run); run = [b]; still = 0; continue; }
    if (moving) {
      if (still >= LEG_STOP_S) { runs.push(run); run = [a]; }
      still = 0;
      run.push(b);
    } else {
      still += dt;
    }
  }
  runs.push(run);

  // 2. Split each run at turnarounds, judged on the thinned path so GPS
  //    scatter at walking pace cannot fake one.
  const legs = [];
  for (const r of runs) {
    if (r.length < 2) continue;
    const thin = thinPath(r, 1e6);
    let leg = [thin[0]];
    for (let i = 1; i < thin.length; i++) {
      leg.push(thin[i]);
      if (i < thin.length - 1 && turn(bearing(thin[i - 1], thin[i]), bearing(thin[i], thin[i + 1])) > TURNAROUND_DEG) {
        legs.push(leg);
        leg = [thin[i]];
      }
    }
    legs.push(leg);
  }
  return legs.filter((l) => l.length >= 2).map((path) => ({ path, m: pathM(path) }));
}

async function routeLeg(path, { travelMode, departMs, signal }) {
  const pts = thinPath(path);
  const a = pts[0], b = pts[pts.length - 1];
  const q = new URLSearchParams({
    key: TOMTOM_KEY,
    travelMode,
    traffic: "false",
    computeTravelTimeFor: "all",
    routeRepresentation: "summaryOnly",
    departAt: new Date(sameSlotAhead(departMs)).toISOString().replace(/\.\d{3}Z$/, "Z"),
  });
  const body = pts.length > 2
    ? { supportingPoints: pts.map((p) => ({ latitude: p.lat, longitude: p.lng })) }
    : null;
  if (body) { q.set("minDeviationDistance", "0"); q.set("minDeviationTime", "0"); }
  const url = `${API}/routing/1/calculateRoute/${a.lat},${a.lng}:${b.lat},${b.lng}/json?${q}`;
  const init = body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }
    : { signal };
  // TomTom's free tier allows a few routing calls a second; a burst of legs
  // gets 429s, which are a reason to wait, not a failure.
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, init);
    if (res.status !== 429 || attempt >= 4) break;
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!res.ok) {
    let msg = `TomTom routing ${res.status}`;
    try { msg = (await res.json())?.error?.description ?? msg; } catch { /* body not JSON */ }
    throw new Error(msg);
  }
  const s = (await res.json())?.routes?.[0]?.summary;
  if (!s) throw new Error("No route found");
  return { lengthM: s.lengthInMeters, expectedS: s.historicTrafficTravelTimeInSeconds ?? s.travelTimeInSeconds };
}

/**
 * How long the driven path takes on the road network, at the time of day it
 * was driven, from TomTom's historic speeds (no live traffic — the drive is in
 * the past). Each leg (journeyLegs) is timed on its own, two at a time; legs
 * beyond MAX_ROUTED_LEGS, and any TomTom could not route, are timed at the
 * average expected speed of the ones it did.
 *
 * @returns {Promise<{expectedS:number, lengthM:number, legs:number, routed:number, approx:boolean}>}
 */
export async function fetchExpectedTime(journey, { travelMode = "truck", signal } = {}) {
  if (!TRAFFIC_AVAILABLE) throw new Error("No TomTom key configured");
  const legs = journeyLegs(journey).filter((l) => l.m >= 50);
  if (!legs.length) throw new Error("No drivable legs in this track");
  const order = legs.map((l, i) => i).sort((x, y) => legs[y].m - legs[x].m);
  const toRoute = new Set(order.slice(0, MAX_ROUTED_LEGS));

  const results = new Array(legs.length).fill(null);
  const queue = [...toRoute];
  const worker = async () => {
    while (queue.length) {
      const i = queue.shift();
      try {
        results[i] = await routeLeg(legs[i].path, { travelMode, departMs: legs[i].path[0].t ?? journey.startMs, signal });
      } catch (e) {
        if (e.name === "AbortError") throw e;
      }
    }
  };
  await Promise.all([worker(), worker()]);

  // A leg whose TomTom route is less than half or more than twice the ground
  // driven is not the same drive at all — a field track snapped to one road
  // point (46 m by road for 898 m driven), or a long way round to reach it.
  // Those are timed with the unrouted legs, at the matched legs' speed.
  for (let i = 0; i < legs.length; i++) {
    const r = results[i];
    if (!r) continue;
    const ratio = r.lengthM / legs[i].m;
    if (!(ratio >= 0.5 && ratio <= 2)) results[i] = null;
  }

  let expectedS = 0, lengthM = 0, approx = false, routedM = 0, routedS = 0, routed = 0;
  for (let i = 0; i < legs.length; i++) {
    const r = results[i];
    if (!r) continue;
    const x = expectedFor({ km: legs[i].m / 1000 }, r);
    if (!x.matched) approx = true;
    expectedS += x.expectedS;
    lengthM += r.lengthM;
    routedM += legs[i].m;
    routedS += x.expectedS;
    routed++;
  }
  if (!routed) throw new Error("this drive is off TomTom's road network (estate or field tracks), so there is nothing to time it against");
  // The legs not routed, at the routed legs' expected speed.
  const rest = legs.reduce((m, l, i) => (results[i] ? m : m + l.m), 0);
  if (rest > 0) { expectedS += rest * (routedS / routedM); approx = approx || rest > 0.2 * (rest + routedM); }
  return { expectedS, lengthM, legs: legs.length, routed, approx };
}

/**
 * The expected time to hold the drive against.
 *
 * Where TomTom's rebuilt path is the driven one (road distance within −15% /
 * +20% of the GPS distance) its time stands as is. Where it is not, the unit
 * left TomTom's road network — estate and field tracks are not on it, so it
 * routes AROUND them (Sukari, 4 Oct: 76.7 km by road for 40.7 km driven) — and
 * the time is scaled to the distance actually driven at TomTom's average
 * speed for that route, and marked approximate.
 *
 * @returns {{expectedS:number, matched:boolean, ratio:number}}
 */
export function expectedFor(journey, expected) {
  const gpsM = journey.km * 1000;
  const ratio = gpsM > 0 ? expected.lengthM / gpsM : 1;
  const matched = ratio >= 0.85 && ratio <= 1.2;
  return {
    expectedS: matched || !(ratio > 0) ? expected.expectedS : expected.expectedS / ratio,
    matched,
    ratio,
  };
}
