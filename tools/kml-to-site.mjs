/**
 * Turns a Google Earth / My Maps KML export into a site-plan overlay.
 *
 * Run:  node tools/kml-to-site.mjs <in.kml> <out.geojson> [options]
 *
 *   --name "Site"   rename the site fence (see below)
 *   --pick  <re>    keep only placemarks whose name matches this regex
 *   --drop  <re>    drop placemarks whose name matches this regex
 *   --no-fence      this survey has no perimeter (see below)
 *
 * ## One KML can hold more than one layer
 *
 * Menengai's export carries the Big Farm estate AND two Molo River outlines
 * 7 km north of it, and they are two different things to look at: a toggle
 * that framed both would sit at a zoom where neither is legible. `--pick` and
 * `--drop` split one export into the layers it actually contains, so the
 * source file stays exactly as the surveyor sent it.
 *
 * ## Not every survey has a fence
 *
 * The largest polygon is normally the site boundary, and everything else is
 * placed relative to it. A river is not a site: its biggest outline is water,
 * not a perimeter, and drawing it white with a "Site perimeter" swatch would
 * be a category error the map states confidently. `--no-fence` says there is
 * no boundary here — every feature is then categorised by name alone and the
 * outside-the-fence check does not run.
 *
 * `--name` renames the SITE FENCE, for a survey that left its outer ring
 * generic. Nzoia's is called "boundary", which on a hover card reads as an
 * unfinished feature rather than as the name of a mill. It renames only the
 * fence, and only when asked — a placemark the surveyor named is never
 * second-guessed.
 *
 * ## What it keeps
 *
 * Polygons become areas, named points become zone markers. Both carry a
 * `category` that keys into lib/zoneLegend's ZONE_STYLE, so the site plan and
 * the geofence overlay cannot disagree about what a yard looks like.
 *
 * ## What it drops, and why
 *
 * CAMERA COUNTS. The survey labels carry the CCTV fit-out — "Weighbridge
 * (2 G6B, 1 B, 1 LPR)", "Admin (3B)" — and asked for, those come off. They are
 * a map of the camera estate, not of the site, and a count that nothing keeps
 * current is a number that goes stale in public. Dropping them also MERGES the
 * pairs the survey carries twice, once as a place and once as a camera
 * position: Safety Office, Civil Office, Procurement and Admin Tractor Auto
 * each appear under both spellings, 0-5 m apart. The first pin wins; the second
 * is the same doorway.
 *
 * The suffix must be entirely counts — `(\d+ CODE, ...)` — so a real
 * parenthetical in a place name survives. `Mufindi Paper Mills Ltd (Kasulu)`
 * is exactly the shape that a looser rule would have eaten.
 *
 * UNNAMED POINTS. The export carries seven. A marker with no name is a pin
 * dropped while drawing, and it would render as an anonymous dot an operator
 * cannot act on.
 *
 * ## What it checks
 *
 * Every feature is tested against the largest polygon in the file. Anything
 * outside — by more than the width of the fence line itself, see ON_FENCE_M,
 * because a gate is drawn ON the perimeter and lands either side of it — is
 * REPORTED, never dropped — the two Distillery gates are genuinely
 * outside the Kabras fence and inside the Distillery one, which is how you can
 * tell the check is reading real geometry rather than agreeing with itself.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { parseKml, dedupe, categoryFor, outsideRing, ringAreaM2 } from "./kml-site.lib.mjs";

const [, , IN, OUT, ...rest] = process.argv;
if (!IN || !OUT) {
  console.error('usage: node tools/kml-to-site.mjs <in.kml> <out.geojson> [--name "Site"]');
  process.exit(2);
}
const opt = (flag) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] ?? null : null);
const SITE_NAME = opt("--name");
const PICK      = opt("--pick") ? new RegExp(opt("--pick"), "i") : null;
const DROP      = opt("--drop") ? new RegExp(opt("--drop"), "i") : null;
const NO_FENCE  = rest.includes("--no-fence");

const xml = readFileSync(IN, "utf8");
const all = dedupe(parseKml(xml));
const parsed = all.filter((f) => (!PICK || PICK.test(f.name)) && !(DROP && DROP.test(f.name)));

// A placemark that carried no geometry, or no name, is dropped by the parser.
// Reported rather than dropped quietly: Nzoia's export carries an "Untitled
// slide" with nothing in it, and telling the two cases apart — leftover, or a
// place this script failed to read — should not need a hand check of the KML.
const seen = (xml.match(/<Placemark\b/g) ?? []).length;
if (seen > all.length) {
  console.log(`  ${seen - all.length} placemark(s) skipped: unnamed, "Untitled…", no coordinates, or a duplicate`);
}
if (PICK || DROP) console.log(`  ${all.length - parsed.length} placemark(s) filtered out by --pick/--drop`);

// A raster the surveyor traced over. We cannot draw it: the href is a Google
// hosted-image URL that is not ours to serve and does not outlive the export,
// and Maps has no rotated ground overlay to put it in anyway (Big Farm's is
// turned 25 degrees). Said out loud, because a grid drawing silently missing
// from a layer built off its own file is the kind of gap nobody goes looking
// for. The VECTORS traced from it are what this file carries.
const overlays = (xml.match(/<GroundOverlay\b/g) ?? []).length;
if (overlays) console.log(`  ${overlays} ground overlay(s) present and NOT converted — raster, not geometry`);

// The site fence: the biggest ring in the file. Everything else is placed
// relative to it, and it is what the layer's camera fits to.
const areas = parsed.filter((f) => f.kind === "area");
// By AREA, not by vertex count — see ringAreaM2.
const site  = NO_FENCE ? null : areas.reduce((a, b) =>
  (ringAreaM2(b.geometry.coordinates[0]) > (a ? ringAreaM2(a.geometry.coordinates[0]) : 0) ? b : a), null);

const features = parsed.map((f) => {
  const pts = f.geometry.type === "Point" ? [f.geometry.coordinates]
            : f.geometry.type === "Polygon" ? f.geometry.coordinates[0]
            : f.geometry.coordinates;
  const outside = site && f !== site && outsideRing(pts, site.geometry.coordinates[0]);
  return {
    type: "Feature",
    properties: {
      name: f === site && SITE_NAME ? SITE_NAME : f.name,
      category: f === site ? "perimeter" : categoryFor(f.name),
      kind: f === site ? "boundary" : f.kind,
      ...(f.aliases.length ? { aliases: f.aliases } : {}),
      ...(outside ? { outsideSite: true } : {}),
    },
    geometry: f.geometry,
  };
});

writeFileSync(OUT, JSON.stringify({ type: "FeatureCollection", features }, null, 1) + "\n");

const by = features.reduce((m, f) => ((m[f.properties.category] = (m[f.properties.category] ?? 0) + 1), m), {});
console.log(`${features.length} features -> ${OUT}`);
const fence = features.find((f) => f.properties.category === "perimeter");
if (fence) {
  console.log(`  site fence: ${fence.properties.name}${SITE_NAME ? ` (renamed from "${site?.name}")` : ""}`
            + ` (${site.geometry.coordinates[0].length} vertices,`
            + ` ${(ringAreaM2(site.geometry.coordinates[0]) / 1e6).toFixed(2)} km2)`);
} else {
  console.log("  no site fence (--no-fence)");
}
console.log(`  by category: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ")}`);
const merged = features.filter((f) => f.properties.aliases);
if (merged.length) console.log(`  merged camera pins: ${merged.map((f) => f.properties.name).join(", ")}`);
const out = features.filter((f) => f.properties.outsideSite);
if (out.length) console.log(`  outside the site fence (kept, flagged): ${out.map((f) => f.properties.name).join(", ")}`);
