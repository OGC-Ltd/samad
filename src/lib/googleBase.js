/**
 * Google's satellite imagery as a base map, beside OpenStreetMap.
 *
 * "hybrid", not "satellite": the imagery with Google's road and place labels
 * over it, which is what Google Maps itself shows under "Satellite". Bare
 * imagery has no names, and a fleet map is read by road and town.
 *
 * Drawn by Google's own Maps JavaScript API (GoogleMutant mounts a real Google
 * map inside the Leaflet one and keeps them in step) rather than by fetching
 * Google's tile URLs, which their terms forbid. The official tile service, the
 * Map Tiles API, is switched off on this key's Google Cloud project; the Maps
 * JavaScript API is the one the key has always served, so this needs no
 * console change.
 *
 * Loaded on first use only: nobody who stays on OpenStreetMap downloads the
 * Google API or the plugin.
 *
 * The key is not in the bundle: lib/googleKey holds it, set after sign-in
 * from /auth/me. Restrict it by HTTP referrer in the Google Cloud console.
 */
import L from "leaflet";
import { GOOGLE_KEY, GOOGLE_BASE_AVAILABLE, LIVE_TRAFFIC_AVAILABLE } from "./googleKey";

export { GOOGLE_KEY, GOOGLE_BASE_AVAILABLE, LIVE_TRAFFIC_AVAILABLE, setGoogleKey } from "./googleKey";

export const GOOGLE_TYPE_ID = "google";

/**
 * Google's base maps, by our id → Google's map type. "google" stays the
 * hybrid it has always been, so a stored choice keeps its look; bare imagery
 * and terrain were added 2026-10-27 (operator: "add google terrain map and
 * google hybrid map").
 */
export const GOOGLE_BASES = {
  google: "hybrid",
  "google-satellite": "satellite",
  "google-terrain": "terrain",
};
export const isGoogleBase = (id) => Object.prototype.hasOwnProperty.call(GOOGLE_BASES, id);
const GOOGLE_NAMES = { google: "Google Hybrid", "google-satellite": "Google Satellite", "google-terrain": "Google Terrain" };


let apiPromise = null;

/** The Maps JavaScript API, once per page. Rejects on a refused key. */
export function loadGoogleApi() {
  if (window.google?.maps?.Map) return Promise.resolve();
  apiPromise ??= new Promise((resolve, reject) => {
    const cb = "__ftGoogleMapsReady";
    window[cb] = () => resolve();
    // Google calls this, not an error event, when the key or referrer is refused.
    window.gm_authFailure = () => reject(new Error("Google refused the Maps key on this site"));
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_KEY)}&v=weekly&loading=async&callback=${cb}`;
    s.async = true;
    s.onerror = () => reject(new Error("Could not load Google Maps"));
    document.head.appendChild(s);
  }).catch((e) => { apiPromise = null; throw e; });
  return apiPromise;
}

let mutantPromise = null;

/** The plugin reads Leaflet from `window.L` as it loads, so that is set first. */
function loadMutant() {
  window.L ??= L;
  mutantPromise ??= import("leaflet.gridlayer.googlemutant").then((m) => m.default);
  return mutantPromise;
}

/**
 * Register one of GOOGLE_BASES on `map` (lib/mapEngine), "google" (hybrid)
 * unless told otherwise. Resolves once it can be selected with
 * `map.setMapTypeId(id)`.
 */
export async function installGoogleBase(map, id = GOOGLE_TYPE_ID) {
  if (!GOOGLE_BASE_AVAILABLE) throw new Error("No Google Maps key from the server");
  if (!isGoogleBase(id)) throw new Error(`Not a Google base map: ${id}`);
  if (map.mapTypes.get(id)) return;
  const [GoogleMutant] = await Promise.all([loadMutant(), loadGoogleApi()]);
  map.mapTypes.set(id, {
    name: GOOGLE_NAMES[id],
    // Where Google has no deeper imagery (terrain stops sooner than the
    // rest), the plugin finds that out and scales its last level up.
    leafletLayer: () => new GoogleMutant({ type: GOOGLE_BASES[id], maxZoom: 21 }),
  });
}

/** Google draws its own logo and terms on the map; nothing to add below it. */
export const GOOGLE_ATTRIBUTION = [];

/* ── Live traffic ──────────────────────────────────────────────────────────
 * Google's own TrafficLayer (operator, 2026-10-27: "use the google map api for
 * fetching live traffic data on the map"), drawn by a second GoogleMutant
 * whose map has every feature styled away, so only the traffic colours are
 * left: a transparent overlay that sits on OpenStreetMap and on the satellite
 * base alike, in the engine's g-tiles pane (over the base, under everything
 * drawn). The same Maps JavaScript API as the satellite base, the same key.
 *
 * Google's layer refreshes itself inside the hidden map; the Leaflet copy is
 * redrawn every TRAFFIC_REDRAW_MS to pick that up, without a new map load.
 */

export const TRAFFIC_REDRAW_MS = 2 * 60_000;

/** Google's traffic colours, for the layer's legend. */
export const GOOGLE_TRAFFIC_LEGEND = [
  { key: "free",   color: "#16e0a1", label: "Free flow" },
  { key: "slow",   color: "#ffcf43", label: "Slow" },
  { key: "jam",    color: "#f23c32", label: "Heavy" },
  { key: "closed", color: "#811f1f", label: "Standstill" },
];

/**
 * A traffic overlay for `map` (lib/mapEngine). Resolves to `{ refresh, remove }`.
 * Rejects when the key is refused on this site (localhost, see above).
 */
export async function addGoogleTraffic(map) {
  if (!LIVE_TRAFFIC_AVAILABLE) throw new Error("No Google Maps key from the server");
  const [GoogleMutant] = await Promise.all([loadMutant(), loadGoogleApi()]);
  const layer = new GoogleMutant({
    type: "roadmap",
    styles: [{ stylers: [{ visibility: "off" }] }],
    pane: "g-tiles",
    maxZoom: 21,
    opacity: 0.9,
  }).addGoogleLayer("TrafficLayer");
  layer.addTo(map._l);
  return {
    refresh: () => layer.redraw(),
    remove: () => layer.remove(),
  };
}
