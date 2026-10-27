/**
 * Is this point inside any geofence the estate knows about?
 *
 * ## Why this is computed in the browser
 *
 * The server already has a containment engine (fleet-server lib/zone-presence),
 * and every vehicle in the snapshot carries a `zones` field from it. It cannot
 * answer this question today. Measured against the live fleets on 2026-09-07:
 *
 *   · Sukari, West Kenya and Menengai have NO geofences at all, so `zones.known`
 *     is false for all 1,327 of their units — correctly, there is nothing to be
 *     inside of.
 *   · Mufindi has 107 fences and 210 evaluated units, and the server reported
 *     `inside: []` for every single one — while a point-in-polygon over the very
 *     same geometry, in this file, puts 195 of them inside a named zone and 46
 *     inside a circle. "MUFINDI: 012" sits in FARM #215, Nursery A, Staff
 *     residence2 and Workshop A simultaneously, and was reported as nowhere.
 *
 * So the server's answer cannot be the basis of a rule that decides whether to
 * raise a flag about a machine. The GEOMETRY, though, is fine — it is the same
 * FeatureCollection the map already draws (useEstateZones), and it carries both
 * the fences imported from Wialon and the ones configured in our own system,
 * because they are one table.
 *
 * When the server's engine is fixed, its answer is honoured first (see
 * `zoneTestFor`): it knows about per-vehicle assignment, which this does not.
 * This is the floor, not the replacement.
 *
 * ## Areas only: polygons and circles, never corridors
 *
 * Of Mufindi's 107 fences: 29 polygons, 67 circles, 11 corridors. Polygons and
 * circles are PLACES — the factory site, the yards, the workshops, the
 * weighbridges — and standing in one is accounted for. A version that handled
 * only polygons, as the playback path's `zonesAt` does correctly for its own
 * purpose, would miss the 46 units standing inside a circle.
 *
 * Corridors are roads, and a road is not a place to be. "Sukari to Rapogii
 * road (Tarmac)" and "Sukari-Factory to Ndiwa Marram Road" are fences too, and
 * a unit that has stood on one for ten minutes is precisely what the operator
 * needs told — so corridors are excluded from containment and a stop on one
 * flags like a stop anywhere else outside a zone.
 */

import { haversineM } from "./tripProgress";

/**
 * Even-odd ray casting, with holes.
 *
 * A GeoJSON polygon is an outer ring followed by any number of hole rings, and
 * XOR-ing the per-ring result is what makes a point in a hole come out FALSE.
 */
function inRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat)) {
      const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (lng < x) inside = !inside;
    }
  }
  return inside;
}

const inPolygon = (lat, lng, rings) =>
  rings.reduce((acc, ring) => acc !== inRing(lat, lng, ring), false);

/**
 * Does one GeoJSON fence contain this point?
 *
 * Areas only — a polygon (with its holes) or a circle within its radius, the
 * same meaning fleet-server's lib/geofence.isInsideFence gives them. Corridors
 * and unknown geometry are not inside anything, rather than throwing: one
 * malformed fence must not take the whole rule down.
 */
export function fenceContains(point, feature) {
  const g = feature?.geometry;
  if (!g || !point) return false;
  const { lat, lng } = point;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

  if (g.type === "Polygon") return inPolygon(lat, lng, g.coordinates ?? []);
  if (g.type === "MultiPolygon") return (g.coordinates ?? []).some((rings) => inPolygon(lat, lng, rings));

  if (g.type === "Point") {
    const r = feature.properties?.radiusM;
    if (!Number.isFinite(r) || r <= 0) return false;
    const [zlng, zlat] = g.coordinates ?? [];
    if (!Number.isFinite(zlat) || !Number.isFinite(zlng)) return false;
    return haversineM({ lat, lng }, { lat: zlat, lng: zlng }) <= r;
  }

  /**
   * CORRIDORS ARE NOT PLACES. A LineString fence is a road — "Sukari to
   * Rapogii road (Tarmac)", "Sukari-Factory to Ndiwa Marram Road", the drains
   * and rivers on the Kasulu estate. Being on one is being ON THE WAY
   * somewhere, which is the opposite of the areas this function exists to
   * recognise, and a truck that has stood on a haulage road for forty minutes
   * is the single most important thing this list can surface.
   *
   * So they are deliberately not containment. Falling through to `false` means
   * a unit stopped on a corridor and inside nothing else counts as stopped
   * outside every known zone — and gets flagged, which is the point.
   */
  return false;
}

/** Every fence containing the point, by name. */
export function containingFences(point, features) {
  const out = [];
  for (const f of features ?? []) {
    if (fenceContains(point, f)) out.push(f.properties?.name ?? f.properties?.id ?? "zone");
  }
  return out;
}

/** Is the point inside at least one fence? Stops at the first hit. */
export function insideAnyFence(point, features) {
  for (const f of features ?? []) if (fenceContains(point, f)) return true;
  return false;
}

/**
 * Fences that can contain something — polygons and circles with a radius.
 *
 * Used to decide whether containment was DECIDABLE at all. An org whose only
 * geometry is haulage roads has no areas to be inside of, so answering "not in
 * any zone" for it would be the same false certainty as answering for an org
 * with no fences at all.
 */
const isAreaFence = (f) => {
  const t = f?.geometry?.type;
  if (t === "Polygon" || t === "MultiPolygon") return true;
  return t === "Point" && Number.isFinite(f?.properties?.radiusM) && f.properties.radiusM > 0;
};

/**
 * A containment test bound to one org's geometry.
 *
 * Returns a function of a VEHICLE answering a deliberate THREE states:
 *
 *   true  — inside a fence we know about. Standing here is accounted for.
 *   false — outside every fence we know about.
 *   null  — we cannot say. The org has no geometry loaded, or this unit has no
 *           fix. Not the same as `false`, and collapsing the two is what would
 *           let "we never checked" be reported to an operator as "it is not
 *           anywhere it should be".
 *
 * The server's own verdict wins when it has one: `zones.inside` is computed
 * against per-vehicle ASSIGNMENT, which this geometry cannot see, so a unit the
 * server places inside a zone is inside it whatever the raw geometry says.
 */
export function zoneTestFor(featureCollection) {
  // Filtered ONCE per org, not per vehicle per tick: Menengai carries
  // thousands of zones and the corridors among them can never match.
  const features = (featureCollection?.features ?? []).filter(isAreaFence);
  return function insideZone(vehicle) {
    // The server's verdict, but only for AREAS. Its `inside` list covers every
    // containing zone including the corridors — drains, rivers, haulage roads —
    // and a unit stopped on one of those is the case this whole rule exists to
    // surface, so a road must never suppress a flag here either.
    //
    // `area === true` rather than `!== false` deliberately: a server that
    // predates the field says nothing about shape, and silently trusting it
    // would reintroduce corridor suppression on the day of a partial deploy.
    // Falling through to the geometry below is correct in that case.
    if (vehicle?.zones?.inside?.some((z) => z?.area === true)) return true;
    if (features.length === 0) return null;
    const lat = vehicle?.lat;
    const lng = vehicle?.lng;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return insideAnyFence({ lat, lng }, features);
  };
}
