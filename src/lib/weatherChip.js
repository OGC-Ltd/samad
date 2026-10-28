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

/** Steady wind or gusts from this many km/h make the cell read "Windy". */
export const WINDY_KMH = 25;

/**
 * The one word for a cell's weather, the way the map draws it (operator,
 * 2026-10-28: "should be crystal clear, its windy, cloudy, sunny or
 * temperature"). Rain and storms first, then wind, then the sky.
 */
export function weatherKind(p) {
  const tone = weatherTone(p);
  if (tone === "storm") return { kind: "storm", label: "Storm", icon: "ti-cloud-storm" };
  if (tone === "rain") return { kind: "rain", label: "Rain", icon: "ti-cloud-rain" };
  const gust = Math.max(p?.windKmh ?? 0, (p?.gustKmh ?? 0) * 0.7);
  if (gust >= WINDY_KMH || p?.type?.startsWith("WIND")) return { kind: "windy", label: "Windy", icon: "ti-wind" };
  const cloud = cloudCover(p);
  if (cloud >= 0.65) return { kind: "cloudy", label: "Cloudy", icon: "ti-cloud" };
  const night = p?.isDay === false;
  if (cloud > 0) return { kind: "partly", label: "Partly cloudy", icon: night ? "ti-cloud" : "ti-sun-low" }; // no ti-cloud-sun in Tabler 3.19
  return night
    ? { kind: "clear", label: "Clear", icon: "ti-moon" }
    : { kind: "sunny", label: "Sunny", icon: "ti-sun" };
}

/** Where the wind blows FROM, as a compass point ("NE"), from Google's degrees. */
export function compass(deg) {
  if (deg == null || !Number.isFinite(deg)) return null;
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
