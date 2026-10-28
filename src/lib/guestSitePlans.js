/**
 * A site plan belonging to SOMEONE ELSE, drawn because your fleet is standing
 * in it.
 *
 * The surveys are owned per organisation (lib/sitePlans) and that is right for
 * the switch list: Kabras is West Kenya's mill and an operator on Menengai has
 * no business toggling it. But a VEHICLE does not respect the table. A West
 * Kenya lorry spends its afternoon inside Raiply's fence; a Sukari tractor
 * pulls onto a neighbour's weighbridge. The map then shows a marker sitting on
 * blank satellite imagery, when the ground underneath it has been surveyed and
 * the file is already on the server — the operator simply has no switch for it
 * because the survey is filed under another tenant.
 *
 * So a survey that contains one of this fleet's units is offered here for as
 * long as that is true, and withdrawn when it stops being true. It is a GUEST:
 * it is not added to this organisation's stored preferences, it does not take
 * the camera, and it leaves no trace once the unit has gone.
 *
 * ## Why containment is computed here rather than read from the server
 *
 * The same reason lib/zoneContainment gives, and then one more. The server's
 * zone engine cannot answer containment today (measured 2026-09-07: 195 units
 * demonstrably inside a Mufindi fence reported as `inside: []`), and beyond
 * that these surveys are not IN the fence table at all — they are static
 * assets, deliberately, so that a display polygon can never become an enforced
 * geofence. Nothing on the server knows they exist.
 *
 * ## The perimeter only
 *
 * A plan carries a fence and the named places inside it. "In the site" means
 * inside the FENCE; a unit parked between the workshop and the weighbridge is
 * not in two places. A survey with no perimeter (`--no-fence`, which is the
 * Molo river outlines) can contain nothing — a river is not somewhere to be,
 * the same judgement kml-to-site.mjs and zoneContainment both make about a
 * line.
 */

import { fenceContains } from "./zoneContainment";
import { fixAgeMs } from "./fixRecency";
import { DARK_AFTER_MS } from "./vehicleMap";

/**
 * How long a survey stays offered after the last unit leaves it.
 *
 * Not zero, and the reason is the edge of the fence rather than politeness. A
 * yard is 150 m across and a parked unit's fixes wander several metres, so a
 * lorry sitting ON the line crosses it repeatedly without moving — and a layer
 * that appears and disappears every telemetry cycle is worse than one that is
 * never offered. It also covers the ordinary gap where a unit stops reporting
 * for a couple of minutes inside a shed.
 *
 * Three minutes is long enough to swallow both and short enough that "it is
 * still on the map" never outlives the visit in any way an operator notices.
 */
export const LEAVE_GRACE_MS = 3 * 60_000;

/**
 * The fence feature of a site plan, or null if the survey has none.
 *
 * `category: "perimeter"` is what the KML converter stamps on the largest
 * ring, and it is stamped on exactly one feature per file.
 */
export function perimeterOf(featureCollection) {
  return (featureCollection?.features ?? [])
    .find((f) => f?.properties?.category === "perimeter") ?? null;
}

/**
 * The lat/lng box around a fence, for a cheap reject before the ray cast.
 *
 * The sweep runs on every position frame now rather than on a timer, so its
 * cost is worth caring about: measured on the live fleets, one pass over 597
 * units against seven perimeters (12 to 141 vertices) is 1.5-2 ms without
 * this. Four comparisons throw out a unit 300 km from the yard before any of
 * that runs, and on a national fleet that is very nearly all of them.
 *
 * Computed once when the survey is read, not per sweep — see the hook.
 */
export function bboxOf(feature) {
  const rings = feature?.geometry?.coordinates;
  if (!Array.isArray(rings) || !Array.isArray(rings[0])) return null;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
  }
  return Number.isFinite(minLat) ? { minLat, maxLat, minLng, maxLng } : null;
}

/**
 * Which of these units are standing inside that fence, by id.
 *
 * A unit with no position is not anywhere. A DARK unit — past the 24 hours
 * where vehicleMap stops asserting the fix is live — is a MEMORY of a
 * position, and a memory must not hold a layer open: a lorry that reported
 * from Raiply last Tuesday and has been silent since would otherwise pin
 * Raiply to West Kenya's switch list forever.
 *
 * `bbox` is an optional fast path and never an answer: a unit inside the box
 * still goes through the ray cast. Skipping it would call every lorry in the
 * rectangle around a yard "inside" it, which for an L-shaped site is a lot of
 * road.
 */
export function occupantsIn(vehicles, perimeter, now = Date.now(), bbox = null) {
  const out = [];
  if (!perimeter) return out;
  for (const v of vehicles ?? []) {
    const { lat, lng } = v ?? {};
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (bbox && (lat < bbox.minLat || lat > bbox.maxLat
              || lng < bbox.minLng || lng > bbox.maxLng)) continue;
    const age = fixAgeMs(v, now);
    if (age === null || age > DARK_AFTER_MS) continue;
    if (fenceContains({ lat, lng }, perimeter)) out.push(v.id ?? v.vehicleId);
  }
  return out;
}

/**
 * Advance the bookkeeping one sweep.
 *
 * `sightings` is who is inside each foreign survey RIGHT NOW, keyed by plan id.
 * The returned state carries, per plan still offered:
 *
 *   since      when the first unit arrived — the visit, not this sweep, so a
 *              lorry that has been there two hours reads as two hours even
 *              though the page was opened ten minutes ago
 *   lastSeen   the last sweep that found anybody. The grace window measures
 *              from here
 *   occupants  the ids currently inside, which is what the switch row counts
 *
 * Kept as a reducer over the previous state rather than derived fresh each
 * sweep because both of the first two fields are history: nothing in a single
 * point-in-polygon pass can tell you when a visit started or whether the yard
 * was empty a minute ago.
 */
export function nextGuestState(prev, sightings, now = Date.now(), graceMs = LEAVE_GRACE_MS) {
  const next = {};

  for (const [planId, occupants] of Object.entries(sightings ?? {})) {
    if (!occupants?.length) continue;
    next[planId] = {
      since: prev?.[planId]?.since ?? now,
      lastSeen: now,
      occupants,
    };
  }

  // Empty now, but recently occupied: held open for the grace window above.
  // `occupants` is deliberately left at what it was rather than emptied — the
  // row should keep naming the visit it is still showing, not report zero
  // while it is plainly still drawn.
  for (const [planId, entry] of Object.entries(prev ?? {})) {
    if (next[planId]) continue;
    if (now - entry.lastSeen < graceMs) next[planId] = entry;
  }

  return next;
}

/**
 * Do two states describe the same switch list?
 *
 * Identity, not deep equality: the plans offered and how many units are in
 * each. Everything downstream of this rebuilds map layers, so a sweep that
 * found the same trucks in the same yards must produce the same object or the
 * layer is torn down and redrawn every twenty seconds.
 */
export function sameGuestList(a, b) {
  const ka = Object.keys(a ?? {}).sort();
  const kb = Object.keys(b ?? {}).sort();
  if (ka.length !== kb.length) return false;
  return ka.every((k, i) => kb[i] === k
    && (a[k].occupants?.length ?? 0) === (b[k].occupants?.length ?? 0));
}
