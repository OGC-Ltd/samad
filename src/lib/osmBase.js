// OpenStreetMap: the app's only base map.
//
// Operator, 2026-10-03: "lets integrate an openstreetmap"; 2026-10-04: "the
// openstreetmap the default", then "we are openstreetmap now". Written as a
// Google-style MapType (getTile / releaseTile) while Google's engine still
// drew the map; the engine is Leaflet now (lib/mapEngine), which runs the same
// MapType as a GridLayer, so this file kept its shape.
//
// Tiles come from the OSM Foundation's standard server. Its usage policy
// (operations.osmfoundation.org/policies/tiles) allows light interactive use
// like this with attribution shown; heavy traffic, prefetching or offline use
// would need our own tile server or a commercial OSM provider — change
// OSM_TILE_URL then, nothing else.

/** One place to take OSM away from both maps (Google road map becomes the default). */
export const OSM_ENABLED = true;

/** Google's road map offered beside OSM in each map's type switcher.
 *  Off for good since the engine became Leaflet (operator, 2026-10-04:
 *  "remove the Google from there, we are openstreetmap now") — there is no
 *  Google road map to offer. Kept so the switcher code reads as switched off
 *  rather than half-deleted; turning it on shows a Map button with no tiles. */
export const SHOW_GOOGLE_TYPES = false;

export const OSM_TYPE_ID = "osm";

const OSM_TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

/** The deepest zoom tile.openstreetmap.org serves. Past it the z19 tile is
 *  stretched, so the yard-level zoom the live map allows (21) is not grey. */
const OSM_MAX_NATIVE = 19;

/** The attribution the OSM licence requires wherever its tiles are shown. */
export const OSM_ATTRIBUTION = [
  { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
];

// ── Colouring ───────────────────────────────────────────────────────────────
// Operator, 2026-10-04: the map should look like their reference (a political
// map: each country one of four pastels, a clear blue sea). OSM's raster tiles
// carry neither, so each tile is recoloured as it arrives: every pixel of OSM's
// plain land colour takes the pastel of the country under it, every pixel of
// OSM's water colour takes the sea blue, and coastline pixels that blend the
// two get the same blend of the new pair. Roads, borders, labels, forests and
// towns keep OSM's own colours. Country shapes: public/data/countries.json,
// Natural Earth admin-0 (public domain), four-coloured so no neighbours share.
//
// Colours sampled from the operator's screenshots.

/** The four country pastels, indexed by countries.json's `c`. */
const COUNTRY_COLORS = [
  [0xe1, 0xee, 0xcd], // green
  [0xda, 0xd4, 0xe7], // lavender
  [0xe6, 0xf9, 0xfa], // pale cyan
  [0xff, 0xfc, 0xdb], // cream
];
const SEA = [0xa8, 0xcf, 0xff];

/** Zoomed in, land is one neutral grey and the countries' pastels go — the
 *  operator's reference does the same (2026-10-04: "when I zoom into the land
 *  the color should change to this"). Sampled from their screenshot. */
const LAND_ZOOMED = [0xee, 0xf0, 0xed];
/** From this zoom in, land is LAND_ZOOMED; below it, the country pastels. */
const LAND_GREY_FROM_ZOOM = 8;

/** OSM Carto's plain land and water colours. */
const OSM_LAND = [0xf2, 0xef, 0xe9];
const OSM_WATER = [0xaa, 0xd3, 0xdf];

/** How far (RGB distance) a pixel may sit off the land–water line and still
 *  count as land, water or a blend of the two. */
const MATCH = 8;

let countriesPromise = null;

/** countries.json, projected once to Web Mercator world units (0..1). */
function loadCountries() {
  countriesPromise ??= fetch("/data/countries.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`countries.json ${r.status}`))))
    .then(({ countries }) => countries.map((c) => ({
      color: COUNTRY_COLORS[c.c] ?? COUNTRY_COLORS[0],
      rings: c.p.map((flat) => {
        const pts = new Float64Array(flat.length);
        let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
        for (let i = 0; i < flat.length; i += 2) {
          const x = (flat[i] + 180) / 360;
          const lat = Math.max(-85.0511, Math.min(85.0511, flat[i + 1])) * Math.PI / 180;
          const y = (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2;
          pts[i] = x; pts[i + 1] = y;
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
        return { pts, box: [x0, y0, x1, y1] };
      }),
    })))
    .catch((e) => { console.warn("[osmBase] country colours off:", e.message); return null; });
  return countriesPromise;
}

/** Paint the country pastels for tile (z, x, y) into a 256 px canvas. */
function paintCountries(doc, countries, z, x, y) {
  const cv = doc.createElement("canvas");
  cv.width = cv.height = 256;
  const ctx = cv.getContext("2d");
  const n = 1 << z;
  const tx0 = x / n, ty0 = y / n, tx1 = (x + 1) / n, ty1 = (y + 1) / n;
  const k = 256 * n;
  for (const c of countries) {
    let path = null;
    for (const { pts, box } of c.rings) {
      if (box[2] < tx0 || box[0] > tx1 || box[3] < ty0 || box[1] > ty1) continue;
      path ??= new Path2D();
      path.moveTo((pts[0] - tx0) * k, (pts[1] - ty0) * k);
      for (let i = 2; i < pts.length; i += 2) path.lineTo((pts[i] - tx0) * k, (pts[i + 1] - ty0) * k);
      path.closePath();
    }
    if (!path) continue;
    ctx.fillStyle = `rgb(${c.color.join(",")})`;
    ctx.fill(path, "evenodd");
  }
  return ctx.getImageData(0, 0, 256, 256).data;
}

/** Recolour OSM's land and water in place, using the painted pastels. */
function recolour(px, fill, land = OSM_LAND) {
  const [lr, lg, lb] = OSM_LAND;
  const dr = OSM_WATER[0] - lr, dg = OSM_WATER[1] - lg, db = OSM_WATER[2] - lb;
  const dd = dr * dr + dg * dg + db * db;
  const max = MATCH * MATCH;
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] - lr, g = px[i + 1] - lg, b = px[i + 2] - lb;
    let t = (r * dr + g * dg + b * db) / dd;
    if (t < -0.1 || t > 1.1) continue;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const er = r - t * dr, eg = g - t * dg, eb = b - t * db;
    if (er * er + eg * eg + eb * eb > max) continue;
    // Without pastels every land pixel takes `land`. With them, land under no
    // country shape (a shape simplified off the coast) stays OSM's.
    const a = fill ? fill[i + 3] / 255 : 0;
    const cr = fill ? fill[i] * a + lr * (1 - a) : land[0];
    const cg = fill ? fill[i + 1] * a + lg * (1 - a) : land[1];
    const cb = fill ? fill[i + 2] * a + lb * (1 - a) : land[2];
    px[i]     = cr + (SEA[0] - cr) * t;
    px[i + 1] = cg + (SEA[1] - cg) * t;
    px[i + 2] = cb + (SEA[2] - cb) * t;
  }
}

function makeType(maps) {
  loadCountries();
  return {
    tileSize: new maps.Size(256, 256),
    minZoom: 0,
    maxZoom: 21,
    name: "OSM",
    alt: "OpenStreetMap",
    getTile(coord, zoom, doc) {
      const tile = doc.createElement("div");
      const bg = zoom >= LAND_GREY_FROM_ZOOM ? LAND_ZOOMED : OSM_LAND;
      tile.style.cssText = `width:256px;height:256px;overflow:hidden;position:absolute;background:rgb(${bg.join(",")})`;
      const n = 1 << zoom;
      if (coord.y < 0 || coord.y >= n) return tile; // above / below the world
      const x = ((coord.x % n) + n) % n; // wrap across the antimeridian

      // Over-zoom: draw the matching quarter (or sixteenth) of the z19 tile.
      const d = Math.max(0, zoom - OSM_MAX_NATIVE);
      const scale = 1 << d;
      const size = 256 * scale;
      const tz = zoom - d, tx = x >> d, ty = coord.y >> d;

      const cv = doc.createElement("canvas");
      cv.width = cv.height = 256;
      cv.style.cssText = `position:absolute;width:${size}px;height:${size}px;` +
        `left:${-(x & (scale - 1)) * 256}px;top:${-(coord.y & (scale - 1)) * 256}px`;
      tile.appendChild(cv);

      const img = new Image();
      img.crossOrigin = "anonymous"; // the tile server sends CORS, so the canvas stays readable
      img.onload = async () => {
        const countries = await loadCountries();
        if (tile.dataset.released) return;
        const ctx = cv.getContext("2d");
        ctx.drawImage(img, 0, 0, 256, 256);
        try {
          const data = ctx.getImageData(0, 0, 256, 256);
          if (tz >= LAND_GREY_FROM_ZOOM) recolour(data.data, null, LAND_ZOOMED);
          else recolour(data.data, countries ? paintCountries(doc, countries, tz, tx, ty) : null);
          ctx.putImageData(data, 0, 0);
        } catch {
          // A tainted canvas (no CORS) — OSM's own colours are already drawn.
        }
      };
      img.src = OSM_TILE_URL(tz, tx, ty);
      tile._img = img;
      return tile;
    },
    releaseTile(tile) {
      if (!tile) return;
      tile.dataset.released = "1";
      if (tile._img) { tile._img.onload = null; tile._img.src = ""; }
    },
  };
}

/** Register the OSM type on `map`. Returns whether it was registered. */
export function installOsmBase(maps, map) {
  if (!OSM_ENABLED) return false;
  map.mapTypes.set(OSM_TYPE_ID, makeType(maps));
  return true;
}
