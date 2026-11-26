/**
 * The geometry behind drawing a geofence, on turf.js: what a drawn shape
 * looks like, how big it is, what is wrong with it, what it sits inside, and
 * what the server is sent. Pure: points in, answers out, so it is tested
 * without a map.
 *
 * A draft is what the person has drawn so far:
 *
 *   { kind: "polygon",   points: [corner, …] }
 *   { kind: "rectangle", points: [corner, opposite corner] }
 *   { kind: "circle",    points: [centre], radiusM }
 *   { kind: "corridor",  points: [along the road, …], widthM }
 *
 * Points are { lat, lng }, the map's order. Turf and the server want
 * [lng, lat]; the swap happens here and nowhere else.
 */

import {
  area, bbox, bboxPolygon, booleanIntersects, booleanPointInPolygon, booleanWithin,
  buffer, circle, cleanCoords, distance, kinks, length, lineString, point, polygon,
  polygonToLine,
} from "@turf/turf";

export const KINDS = ["polygon", "rectangle", "circle", "corridor"];

/** The server's limits (server/fences.go). From Rai Track's draw tool. */
export const RADIUS_MIN_M = 10;
export const RADIUS_MAX_M = 100_000;
export const WIDTH_MIN_M = 2;
export const WIDTH_MAX_M = 2_000;
/** Smaller than this is a slip of the mouse, not a place: 10 m × 10 m. */
const AREA_MIN_M2 = 100;
/** Big enough that it is worth saying so before it is saved. */
const AREA_LARGE_HA = 50_000;
const CIRCLE_STEPS = 64;

const ll = (p) => [p.lng, p.lat];
/** ~1 cm: enough for a fence, and keeps the stored ring readable. */
const round = (v) => Math.round(v * 1e7) / 1e7;

/** How many points each kind needs before it is a shape. */
export function pointsNeeded(kind) {
  return kind === "polygon" ? 3 : kind === "circle" ? 1 : 2;
}

/**
 * The drawn shape as a GeoJSON Polygon feature, or null while there is not
 * enough of it yet. A circle is a 64-sided ring and a corridor is its line
 * buffered to half the width each side: what the map previews, and what
 * area and containment are measured on.
 */
export function shapeOf(draft) {
  const pts = draft?.points ?? [];
  if (pts.length < pointsNeeded(draft?.kind)) return null;
  try {
    if (draft.kind === "polygon") {
      const ring = pts.map(ll);
      return cleanCoords(polygon([[...ring, ring[0]]]));
    }
    if (draft.kind === "rectangle") {
      const [a, b] = pts;
      if (a.lat === b.lat || a.lng === b.lng) return null;
      return bboxPolygon([Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)]);
    }
    if (draft.kind === "circle") {
      if (!(draft.radiusM > 0)) return null;
      return circle(ll(pts[0]), draft.radiusM, { units: "meters", steps: CIRCLE_STEPS });
    }
    if (draft.kind === "corridor") {
      if (!(draft.widthM > 0)) return null;
      const out = buffer(lineString(pts.map(ll)), draft.widthM / 2, { units: "meters", steps: 8 });
      return out?.geometry?.type === "Polygon" ? out : null;
    }
  } catch {
    // Turf throws on degenerate input (two identical corners, say). That is
    // "not a shape yet", which the problems list explains.
  }
  return null;
}

/** The shape's outline as { lat, lng } points, open, for the map to draw. */
export function outlineOf(feature) {
  const ring = feature?.geometry?.coordinates?.[0] ?? [];
  const out = ring.map(([lng, lat]) => ({ lat, lng }));
  if (out.length > 1) out.pop();
  return out;
}

/** Area, perimeter and (for a corridor) the length of its centre-line. */
export function measure(draft) {
  const shape = shapeOf(draft);
  const lineM = draft?.kind === "corridor" && (draft.points?.length ?? 0) >= 2
    ? length(lineString(draft.points.map(ll)), { units: "meters" })
    : null;
  if (!shape) return { areaHa: 0, perimeterM: 0, lengthM: lineM };
  return {
    areaHa: area(shape) / 10_000,
    perimeterM: length(polygonToLine(shape), { units: "meters" }),
    lengthM: lineM,
  };
}

/** Distance in metres between two { lat, lng } points: a circle's radius from a drag. */
export function metresBetween(a, b) {
  return distance(ll(a), ll(b), { units: "meters" });
}

/**
 * What stops this draft from being saved, in words for the person drawing.
 * Empty means it can be saved.
 */
export function problemsOf(draft) {
  const out = [];
  const pts = draft?.points ?? [];
  const need = pointsNeeded(draft?.kind);
  if (pts.length < need) {
    out.push(draft?.kind === "polygon" ? `Place at least 3 corners (${pts.length} so far).`
      : draft?.kind === "circle" ? "Click the centre of the circle."
      : draft?.kind === "rectangle" ? "Click two opposite corners."
      : "Click at least two points along the road.");
    return out;
  }
  if (draft.kind === "circle") {
    const r = draft.radiusM;
    if (!(r >= RADIUS_MIN_M)) out.push(`The radius must be at least ${RADIUS_MIN_M} m.`);
    else if (r > RADIUS_MAX_M) out.push(`The radius can be at most ${RADIUS_MAX_M / 1000} km.`);
  }
  if (draft.kind === "corridor") {
    const w = draft.widthM;
    if (!(w >= WIDTH_MIN_M)) out.push(`The width must be at least ${WIDTH_MIN_M} m.`);
    else if (w > WIDTH_MAX_M) out.push(`The width can be at most ${WIDTH_MAX_M.toLocaleString()} m.`);
    const { lengthM } = measure(draft);
    if (lengthM != null && lengthM < 10) out.push("The road is shorter than 10 m.");
  }
  const shape = shapeOf(draft);
  if (!shape) {
    if (!out.length) out.push("These points do not make a shape. Move one of them.");
    return out;
  }
  if (draft.kind === "polygon") {
    if (shape.geometry.coordinates[0].length < 4) out.push("Some corners sit on top of each other. Place at least 3 different corners.");
    else if (kinks(shape).features.length) out.push("The edges cross each other. Move or remove a corner so the outline does not cross itself.");
  }
  if (!out.length && area(shape) < AREA_MIN_M2) out.push("The shape is smaller than 10 m by 10 m.");
  return out;
}

/** Notes that do not stop a save but are worth reading first. */
export function notesOf(draft, fences = [], skipId = null) {
  const notes = [];
  const shape = shapeOf(draft);
  if (!shape) return notes;
  const { areaHa } = measure(draft);
  if (areaHa > AREA_LARGE_HA) notes.push(`This is very large: ${fmtArea(areaHa)}.`);
  const parent = parentOf(shape, fences, skipId);
  if (parent) notes.push(`Sits inside ${parent.properties.name}.`);
  const over = overlapping(shape, fences, parent, skipId);
  if (over.length) {
    const names = over.slice(0, 3).map((f) => f.properties.name).join(", ");
    notes.push(`Overlaps ${names}${over.length > 3 ? ` and ${over.length - 3} more` : ""}.`);
  }
  return notes;
}

/* ── existing fences ────────────────────────────────────────────────────── */

/** An existing fence (the map's GeoJSON) as a turf Polygon, or null for a line. */
function areaOf(f) {
  const g = f?.geometry;
  if (g?.type === "Polygon") return f;
  if (g?.type === "Point" && f.properties?.radiusM > 0) {
    return circle(g.coordinates, f.properties.radiusM, { units: "meters", steps: 32 });
  }
  return null;
}

/**
 * The fences with each one's box worked out once, for notesOf and parentOf to
 * be called on every change of a drawing without measuring 6,000 fences again.
 */
export function withBoxes(fences = []) {
  return fences.filter((f) => f?.geometry).map((f) => ({ ...f, bbox: bbox(areaOf(f) ?? f) }));
}

/** Fences whose box meets the shape's box: the cheap pass before the exact one.
 *  Menengai has 6,169 fences, and the exact tests are not cheap. */
function nearby(shape, fences) {
  const [w, s, e, n] = bbox(shape);
  return fences.filter((f) => {
    if (!f?.geometry) return false;
    const [fw, fs, fe, fn] = f.bbox ?? bbox(areaOf(f) ?? f);
    return fw <= e && fe >= w && fs <= n && fn >= s;
  });
}

/** The smallest existing fence the whole shape sits inside, or null. */
export function parentOf(shape, fences = [], skipId = null) {
  let best = null, bestHa = Infinity;
  for (const f of nearby(shape, fences)) {
    if (skipId != null && f.properties?.id === skipId) continue;
    const a = areaOf(f);
    if (!a) continue;
    let inside = false;
    try { inside = booleanWithin(shape, a); } catch { inside = false; }
    if (!inside) continue;
    const ha = area(a) / 10_000;
    if (ha < bestHa) { best = f; bestHa = ha; }
  }
  return best;
}

/** Existing fences the shape crosses into, other than the one it sits inside. */
export function overlapping(shape, fences = [], parent = null, skipId = null) {
  const out = [];
  for (const f of nearby(shape, fences)) {
    if (f === parent || (skipId != null && f.properties?.id === skipId)) continue;
    const a = areaOf(f);
    if (!a) continue;
    try { if (booleanIntersects(shape, a)) out.push(f); } catch { /* skip a broken fence */ }
  }
  return out;
}

/** Is a { lat, lng } point inside an existing fence? */
export function pointInFence(p, f) {
  const a = areaOf(f);
  return a ? booleanPointInPolygon(point(ll(p)), a) : false;
}

/* ── to and from the server ─────────────────────────────────────────────── */

/**
 * The POST/PATCH body for a draft and what was typed about it. A rectangle is
 * saved as the polygon it is. The ring is closed: the server stores it as
 * given, and PostGIS wants it closed.
 */
export function toPayload(draft, { name, purpose, color } = {}) {
  const meta = {
    name: (name ?? "").trim(),
    ...(purpose ? { purpose } : {}),
    ...(color ? { color } : {}),
    // A keep-out is the one purpose whose meaning is enforcement.
    mode: purpose === "restricted" ? "BLOCKLIST" : "ALLOWLIST",
  };
  if (draft.kind === "circle") {
    const [c] = draft.points;
    return { ...meta, type: "CIRCLE", centerLat: round(c.lat), centerLng: round(c.lng), radiusM: Math.round(draft.radiusM) };
  }
  if (draft.kind === "corridor") {
    return { ...meta, type: "LINE", polygonCoords: draft.points.map((p) => [round(p.lng), round(p.lat)]), widthM: Math.round(draft.widthM) };
  }
  const shape = shapeOf(draft);
  const ring = shape.geometry.coordinates[0].map(([lng, lat]) => [round(lng), round(lat)]);
  return { ...meta, type: "POLYGON", polygonCoords: ring };
}

/** An existing fence (the map's GeoJSON feature) as a draft, for editing. */
export function draftOf(feature) {
  const g = feature?.geometry;
  const p = feature?.properties ?? {};
  if (g?.type === "Point") {
    const [lng, lat] = g.coordinates;
    return { kind: "circle", points: [{ lat, lng }], radiusM: p.radiusM ?? 100 };
  }
  if (g?.type === "LineString") {
    return { kind: "corridor", points: g.coordinates.map(([lng, lat]) => ({ lat, lng })), widthM: p.widthM ?? 20 };
  }
  if (g?.type === "Polygon") {
    const pts = (g.coordinates[0] ?? []).map(([lng, lat]) => ({ lat, lng }));
    const a = pts[0], z = pts[pts.length - 1];
    if (pts.length > 1 && a.lat === z.lat && a.lng === z.lng) pts.pop();
    return { kind: "polygon", points: pts };
  }
  return null;
}

/* ── typed coordinates ──────────────────────────────────────────────────── */

/** The draft's points as text, one "lat, lng" per line. */
export function formatPoints(points = []) {
  return points.map((p) => `${round(p.lat).toFixed(6)}, ${round(p.lng).toFixed(6)}`).join("\n");
}

/**
 * Points typed or pasted in. Takes, one point per line:
 *   -0.823400, 34.384490      (latitude, longitude: the order Google Maps copies)
 *   -0.8234 34.38449
 * or a pasted GeoJSON Polygon, LineString, Point or Feature, which is
 * [longitude, latitude] by definition. A line whose first number cannot be a
 * latitude (beyond ±90) is read the other way round.
 *
 * @returns {{ points: Array<{lat:number,lng:number}>, error: string|null }}
 */
export function parsePoints(text) {
  const t = (text ?? "").trim();
  if (!t) return { points: [], error: null };
  if (t.startsWith("{") || t.startsWith("[")) return parseGeoJson(t);
  const points = [];
  const lines = t.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < lines.length; i++) {
    const nums = lines[i].match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
    if (nums.length !== 2) return { points, error: `Line ${i + 1} needs two numbers: latitude, longitude.` };
    let [lat, lng] = nums;
    if (Math.abs(lat) > 90 && Math.abs(lng) <= 90) [lat, lng] = [lng, lat];
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return { points, error: `Line ${i + 1} is not a place on Earth.` };
    points.push({ lat, lng });
  }
  // A ring pasted closed repeats its first corner at the end; drawn, it does not.
  const a = points[0], z = points[points.length - 1];
  if (points.length > 3 && a.lat === z.lat && a.lng === z.lng) points.pop();
  return { points, error: null };
}

function parseGeoJson(t) {
  let j;
  try { j = JSON.parse(t); } catch { return { points: [], error: "That is not valid GeoJSON." }; }
  const g = j?.type === "Feature" ? j.geometry
    : j?.type === "FeatureCollection" ? j.features?.[0]?.geometry
    : Array.isArray(j) ? { type: "LineString", coordinates: j } : j;
  const coords = g?.type === "Polygon" ? g.coordinates?.[0]
    : g?.type === "LineString" ? g.coordinates
    : g?.type === "Point" ? [g.coordinates]
    : null;
  if (!Array.isArray(coords)) return { points: [], error: "Paste a Polygon, LineString or Point." };
  const points = coords.map(([lng, lat]) => ({ lat, lng }));
  if (points.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lng))) return { points: [], error: "Some coordinates are not numbers." };
  const a = points[0], z = points[points.length - 1];
  if (g.type === "Polygon" && points.length > 1 && a.lat === z.lat && a.lng === z.lng) points.pop();
  return { points, error: null };
}

/* ── words ───────────────────────────────────────────────────────────────── */

export function fmtArea(ha) {
  if (!(ha > 0)) return "0 ha";
  if (ha < 1) return `${Math.round(ha * 10_000).toLocaleString()} m²`;
  if (ha < 100) return `${ha.toFixed(2)} ha`;
  return `${Math.round(ha).toLocaleString()} ha`;
}

export function fmtLength(m) {
  if (!(m > 0)) return "0 m";
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}
