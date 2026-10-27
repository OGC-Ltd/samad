/**
 * The pure half of tools/kml-to-site.mjs — everything that turns KML text into
 * features, with no filesystem and no argv, so it can be tested.
 *
 * Split out after the camera-suffix regex shipped broken: it was built with a
 * plain template literal, where `\s` is not a recognised escape and collapses
 * to a bare "s", so the pattern compiled to `s*(s*d+s*...` — a valid regex
 * matching nothing. Every camera count sailed straight through onto the map and
 * the script reported success. Reading the source did not catch it; asserting
 * on the output does.
 */

/** Camera codes used by this survey. */
// G6B before G6, or the alternation eats the "G6" and leaves a stray "B"
// inside the parenthetical, which then fails the whole-suffix test and every
// count on that placemark ships onto the map.
const CODE = "(?:PTZ|LPR|G6B|G6|BULLET|B|D)";
export const CAMERA_SUFFIX = new RegExp(
  // String.raw, NOT a plain template literal. In a template literal `\s` is not
  // a recognised escape and collapses to a bare "s", so the pattern compiled to
  // `s*(s*d+s*...` — valid regex, matching nothing, and every camera count
  // sailed through onto the map. Caught by asserting on the output rather than
  // by reading the source.
  String.raw`\s*\(\s*\d+\s*` + CODE + String.raw`\s*(?:,\s*\d+\s*` + CODE + String.raw`\s*)*\)\s*$`,
  "i",
);
export const cleanName = (n) => n.replace(CAMERA_SUFFIX, "").trim();

/**
 * Name -> category. Matched on the CLEANED name, longest rule first, so
 * "Distillery Main Gate" is a gate and not the distillery.
 */
const RULES = [
  // An entrance is a gate. Nzoia's survey calls three of its own that.
  [/\b(gate|entrance)\b/i,              "gate"],
  [/\bweighbridge\b/i,                  "weighing"],
  // "WB" is what a sugar mill's survey writes for one — Nzoia records a
  // Commerical WB and a Cane WB and no "weighbridge" anywhere. Anchored on
  // word boundaries so it cannot reach inside another word.
  [/\bw\/?b\b/i,                        "weighing"],
  [/\b(garage|workshop)\b/i,            "workshop"],
  // Was `scrap yard` exactly. Nzoia's yard is surveyed in four pieces — Scrap
  // yard, Scrap CNTR, Scrap LS, Scrap CNTR — and only one of them says "yard",
  // so the other three were landing in the generic facility white.
  [/\b(scrap|trailler|trailer)\b/i,     "yard"],
  [/\bparking\b/i,                      "parking"],
  // "Fuel Station", "Diesel Depot", "Filling Station". Above the `store` rule
  // below so that a "Fuel Store" is read as the pump it is.
  [/\b(fuel|diesel|petrol|filling\s*station)\b/i, "fuel"],
  // The bagasse houses: the fibre left after crushing, stacked and kept. Any
  // spelling — the surveys write Bagasse, Bagasee and Bagase.
  [/\bbagas\w*\b/i,                     "storage"],
  [/\b(storage|store|inner square)\b/i, "storage"],
  [/\b(distillery|etp)\b/i,             "process"],
  [/\b(river|stream)\b/i,                "water"],
  [/\b(dam|reservoir)\b/i,               "water"],
  [/\b(quaters|quarters|houses)\b/i,    "facility"],
];
export const categoryFor = (name) => RULES.find(([re]) => re.test(name))?.[1] ?? "facility";

/**
 * Metres from a [lng,lat] point to the nearest EDGE of a ring.
 *
 * An equirectangular approximation, which over a 1 km site is exact to well
 * under the metre this is asked to resolve. It exists to answer one question:
 * is this placemark outside the fence, or ON it?
 */
export function metresToRing([x, y], ring) {
  const R = 111320, cy = Math.cos((y * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    const ax = (x - x1) * cy * R, ay = (y - y1) * R;
    const bx = (x2 - x1) * cy * R, by = (y2 - y1) * R;
    const L = bx * bx + by * by;
    const t = L ? Math.max(0, Math.min(1, (ax * bx + ay * by) / L)) : 0;
    best = Math.min(best, Math.hypot(ax - t * bx, ay - t * by));
  }
  return best;
}

/**
 * How far off the fence a placemark has to be before "outside" is a fact about
 * the SITE rather than about the survey.
 *
 * A gate is a hole in the perimeter, so it is drawn on the line and lands a
 * few metres either side of it depending on which way the surveyor's hand
 * went. Sukari's Main Gate is 7.5 m from the fence and ray casting calls it
 * outside; footnoting the site's own front gate "Outside the mill fence" is
 * the map correcting the reader with something false. Kabras' two distillery
 * gates are hundreds of metres out and inside a DIFFERENT fence, which is the
 * case the flag was built for and which this tolerance leaves untouched.
 */
export const ON_FENCE_M = 15;

/** Ray casting on a [lng,lat] ring. */
export const inside = ([x, y], ring) => {
  let ins = false;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1) ins = !ins;
  }
  return ins;
};

/**
 * Is this placemark genuinely outside the fence? Outside AND far enough off the
 * line that it cannot be a point drawn ON it — see ON_FENCE_M.
 */
/**
 * Signed-area magnitude of a [lng,lat] ring, in square metres.
 *
 * The site fence used to be picked as the polygon with the most VERTICES,
 * which is a proxy for size and not always the same one: Menengai's Big Farm
 * ring has 10 points and the two river outlines have 9 each, so a survey drawn
 * slightly differently would have handed the fence to a river. Area is the
 * thing actually being asked about.
 */
export function ringAreaM2(ring) {
  const R = 111320, cy = Math.cos((ring[0]?.[1] ?? 0) * Math.PI / 180);
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a / 2) * cy * R * R;
}

export const outsideRing = (pts, ring) =>
  pts.some((p) => !inside(p, ring) && metresToRing(p, ring) > ON_FENCE_M);

export function parseKml(xml) {
  const out = [];
  for (const [, block] of xml.matchAll(/<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/g)) {
    const rawName = (block.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, "$1").trim();
    const coords = block.match(/<coordinates>([\s\S]*?)<\/coordinates>/)?.[1];
    if (!rawName || !coords || isPlaceholderName(rawName)) continue;

    const pts = coords.trim().split(/\s+/)
      .map((t) => t.split(",").slice(0, 2).map(Number))
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
      .map(([a, b]) => [+a.toFixed(7), +b.toFixed(7)]);
    if (!pts.length) continue;

    const isPoly = /<Polygon\b/.test(block);
    const isLine = /<LineString\b/.test(block);
    out.push({
      name: cleanName(rawName), rawName,
      kind: isPoly ? "area" : isLine ? "line" : "point",
      geometry: isPoly ? { type: "Polygon", coordinates: [pts] }
              : isLine ? { type: "LineString", coordinates: pts }
              :          { type: "Point", coordinates: pts[0] },
    });
  }
  return out;
}

/**
 * A name Google Earth wrote for the surveyor, which is to say no name at all.
 *
 * "Untitled placemark", "Untitled polygon", "Untitled Image Overlay" — the
 * default label on anything drawn and never named. They are the same thing as
 * the unnamed points the parser already drops: geometry someone put down while
 * working, which would draw as an anonymous shape an operator cannot act on.
 * Dropped, and REPORTED by the caller, so naming it in Earth and re-running is
 * the fix rather than an edit to the generated file.
 */
export const isPlaceholderName = (n) => /^untitled\b/i.test(n.trim());

/** First pin wins; a later one under the same cleaned name is the same place. */
export function dedupe(items) {
  const seen = new Map();
  const merged = [];
  for (const it of items) {
    const key = `${it.kind}:${it.name.toLowerCase()}`;
    if (seen.has(key)) { seen.get(key).aliases.push(it.rawName); continue; }
    const kept = { ...it, aliases: [] };
    seen.set(key, kept); merged.push(kept);
  }
  return merged;
}

