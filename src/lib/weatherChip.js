// Which weather a grid cell has (lib/weatherEffects), kept apart from Leaflet
// so it can be tested without a DOM.

const RAINY = new Set([
  "LIGHT_RAIN", "RAIN", "MODERATE_RAIN", "HEAVY_RAIN", "RAIN_PERIODICALLY_HEAVY",
  "LIGHT_RAIN_SHOWERS", "CHANCE_OF_SHOWERS", "SCATTERED_SHOWERS", "RAIN_SHOWERS",
  "HEAVY_RAIN_SHOWERS", "LIGHT_TO_MODERATE_RAIN", "MODERATE_TO_HEAVY_RAIN", "DRIZZLE",
  "WIND_AND_RAIN", "HAIL", "HAIL_SHOWERS",
]);

/** Google's fair-sky types: what is happening now outranks a chance of rain. */
const FAIR = new Set(["CLEAR", "MOSTLY_CLEAR"]);

/** Whether the sky is fair right now (no rain or storm drawn from chances). */
export const isFair = (p) => FAIR.has(p?.type ?? "");

/**
 * "rain" | "storm" | null. Google's condition type first; the chance of rain
 * or thunder only counts under a sky that is not fair, so a clear afternoon
 * with a 60% chance later is drawn as clear (operator, 2026-10-28: "not
 * showing the weather accurately").
 */
export function weatherTone(p) {
  const t = p?.type ?? "";
  if (t.includes("THUNDER")) return "storm";
  if (RAINY.has(t)) return "rain";
  if (isFair(p)) return null;
  if ((p?.thunderPct ?? 0) >= 50) return "storm";
  if ((p?.rainPct ?? 0) >= 60) return "rain";
  return null;
}

/** How cloudy, 0–1, from Google's type: drawn as a soft grey wash. */
export function cloudCover(p) {
  switch (p?.type) {
    case "PARTLY_CLOUDY": return 0.35;
    case "MOSTLY_CLOUDY": return 0.65;
    case "CLOUDY": return 1;
    default: return weatherTone(p) ? 0.8 : 0; // rain and storms come with cloud
  }
}
