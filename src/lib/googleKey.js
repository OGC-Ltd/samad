/**
 * The browser's Google Maps key, held at runtime.
 *
 * Not in the bundle: the server hands it over after sign-in, in /auth/me
 * (context/AuthContext calls setGoogleKey), from its GOOGLE_MAPS_API_KEY, which
 * the production deploy writes from the GitHub production environment.
 *
 * The exports are live bindings: set before the map mounts, every reader
 * (lib/googleBase and the map through it) sees them. Kept apart from
 * googleBase so signing in does not load Leaflet.
 */

export let GOOGLE_KEY = "";
/** Offered only once the server has handed over a key. */
export let GOOGLE_BASE_AVAILABLE = false;
/** Google's traffic layer rides on the same key. */
export let LIVE_TRAFFIC_AVAILABLE = false;

/** The key from /auth/me, or "" (signed out, or none configured). */
export function setGoogleKey(key) {
  const next = String(key ?? "").trim();
  if (next === GOOGLE_KEY) return;
  GOOGLE_KEY = next;
  GOOGLE_BASE_AVAILABLE = LIVE_TRAFFIC_AVAILABLE = next.length > 0;
}
