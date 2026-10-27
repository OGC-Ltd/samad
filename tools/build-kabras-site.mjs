/**
 * Builds public/kabras-site.geojson — the Kabras mill site layer.
 *
 * ## What is in the file, and what is deliberately not
 *
 * The SITE BOUNDARY only, and it is exact: the "Kabras Sugar Factory (West
 * Kenya)" polygon already in the geofence table and already served by
 * /geofences/geojson. 37 vertices, 1105 x 737 m, lng 34.830213-34.840144,
 * lat 0.376015-0.382677. Fetched live by this script at full precision rather
 * than transcribed, so it cannot drift from the fence the alert engine uses.
 *
 * The NAMED INTERIOR AREAS — Inner Square, Vehicle Parking, Garage, Scrap Yard,
 * the cane and bagasse yards, and the gates — are not here yet, on purpose.
 *
 * They were digitised once by fitting the operations screenshots' blue boundary
 * line to the polygon above and reading each area off the fitted frame. That
 * fit is not good enough: its residual is 6.3 % on aspect ratio alone, and when
 * the result was tested with a point-in-polygon pass against the real boundary,
 * five of seven areas had vertices OUTSIDE the site — Scrap Yard had four of
 * five. Areas that land in a neighbour's field would have drawn convincingly
 * and been wrong, which is the worst way for a map to fail.
 *
 * ## How to fill it in
 *
 * The screenshots came from a Google Earth / My Maps project which HOLDS the
 * real coordinates. Export it (My Maps: three-dot menu > Export to KML/KMZ,
 * tick "Export as KML instead of KMZ"; Google Earth Pro: right-click the folder
 * > Save Place As > .kml), drop it at tools/kabras-site.kml, and re-run:
 *
 *     node tools/build-kabras-site.mjs
 *
 * Each placemark becomes a feature. Give it a `category` by naming it in
 * CATEGORY_BY_NAME below, or it lands in the unclassified grey, which is a
 * visible prompt rather than a silent default. Categories key into FleetMap's
 * ZONE_STYLE, so the site layer and the geofence overlay cannot disagree about
 * what a yard looks like.
 *
 * ## Why a static asset and not a geofence
 *
 * Two reasons, both about not breaking things that work:
 *
 *   1. rows in `geofences` are ENFORCED. is_active gates that, but a display
 *      area sitting in the same table is one flag away from raising violations
 *      for trucks parked exactly where they belong;
 *   2. the Wialon sync owns that table by `external_id`, so hand-added rows are
 *      at the mercy of whatever the next sync decides is no longer present.
 *
 * The Kasulu estate PLAN overlay is already this pattern, for the same reasons.
 * It also keeps this OUT of the browser's zone-containment pass, which reads
 * the geofence collection — a sketched boundary must never decide whether a
 * unit counts as stranded.
 *
 * Usage: node tools/build-kabras-site.mjs [--api http://host] [--kml path]
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";

const ORG_ID   = "cmth0avgf0000ukuhkx53kztd";      // WESTSUGAR
const FENCE    = "Kabras Sugar Factory (West Kenya)";
const arg      = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const API      = arg("--api", process.env.FLEET_API ?? "http://13.247.178.217");
const KML      = arg("--kml", new URL("./kabras-site.kml", import.meta.url).pathname);

/** Placemark name -> ZONE_STYLE category. Anything unlisted draws grey. */
const CATEGORY_BY_NAME = {
  "inner square": "storage",
  "vehicle parking": "parking",
  "garage": "workshop",
  "scrap yard": "yard",
  "weighbridge": "weighing",
  "fuel pump": "facility",
  "main gate": "gate",
  "main gate tractor": "gate",
  "main gate trailer": "gate",
  "staff gate": "gate",
  "shamberere gate": "gate",
  "emergency gate": "gate",
  "etp gate": "gate",
  "kushwa gate": "gate",
};

async function boundary() {
  const login = await fetch(`${API}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email:    process.env.FLEET_EMAIL    ?? "sadmin@raioperations.com",
      password: process.env.FLEET_PASSWORD ?? "",
    }),
  });
  if (!login.ok) throw new Error(`login failed (${login.status}) — set FLEET_PASSWORD`);
  const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");

  const res = await fetch(`${API}/api/v1/organisations/${ORG_ID}/geofences/geojson`, {
    headers: { cookie },
  });
  if (!res.ok) throw new Error(`geofences failed (${res.status})`);
  const body = await res.json();
  const fc   = body.data ?? body;
  const f    = fc.features.find((x) => x.properties?.name === FENCE);
  if (!f) throw new Error(`geofence "${FENCE}" not found for ${ORG_ID}`);
  return f.geometry.coordinates[0];
}

/**
 * Enough KML to read placemarks. Not a general parser: it wants <Placemark>
 * with a <name> and one of <Point>/<Polygon>/<LineString>, which is what both
 * My Maps and Earth Pro emit for hand-drawn features.
 */
function readKml(xml) {
  const out = [];
  for (const [, block] of xml.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g)) {
    const name = (block.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
    const raw = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/)?.[1];
    if (!name || !raw) continue;
    const pts = raw.trim().split(/\s+/).map((t) => {
      const [lng, lat] = t.split(",").map(Number);
      return [lng, lat];
    }).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
    if (!pts.length) continue;

    const isPoly = /<Polygon\b/.test(block);
    const isLine = /<LineString\b/.test(block);
    out.push({
      name,
      category: CATEGORY_BY_NAME[name.toLowerCase()] ?? "other",
      kind: isPoly ? "area" : isLine ? "line" : "point",
      geometry: isPoly ? { type: "Polygon", coordinates: [pts] }
              : isLine ? { type: "LineString", coordinates: pts }
              :          { type: "Point", coordinates: pts[0] },
    });
  }
  return out;
}

/** Ray casting. Reported, never enforced — a real area may legitimately straddle. */
const inside = ([x, y], ring) => {
  let ins = false;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) ins = !ins;
  }
  return ins;
};

const bound = await boundary();

const features = [{
  type: "Feature",
  properties: {
    name: "Kabras Factory", category: "factory", kind: "boundary",
    source: "geofence", note: "Site perimeter",
  },
  geometry: { type: "Polygon", coordinates: [bound] },
}];

if (existsSync(KML)) {
  for (const p of readKml(readFileSync(KML, "utf8"))) {
    const pts = p.geometry.type === "Point" ? [p.geometry.coordinates]
              : p.geometry.type === "Polygon" ? p.geometry.coordinates[0]
              : p.geometry.coordinates;
    const out = pts.filter((pt) => !inside(pt, bound)).length;
    if (out) console.warn(`  ! ${p.name}: ${out}/${pts.length} vertices outside the site boundary`);
    features.push({
      type: "Feature",
      properties: { name: p.name, category: p.category, kind: p.kind, source: "kml" },
      geometry: p.geometry,
    });
  }
} else {
  console.warn(`no KML at ${KML} — writing the boundary only.`);
  console.warn("Export the Google Earth / My Maps project and re-run to add the named areas.");
}

writeFileSync(
  new URL("../public/kabras-site.geojson", import.meta.url),
  JSON.stringify({ type: "FeatureCollection", features }, null, 1) + "\n",
);
console.log(`wrote ${features.length} feature(s): 1 boundary from the geofence, ${features.length - 1} from KML`);
