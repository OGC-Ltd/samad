// Which weather a grid cell has (lib/weatherEffects), kept apart from Leaflet
// so it can be tested without a DOM.

const RAINY = new Set([
  "LIGHT_RAIN", "RAIN", "MODERATE_RAIN", "HEAVY_RAIN", "RAIN_PERIODICALLY_HEAVY",
  "LIGHT_RAIN_SHOWERS", "CHANCE_OF_SHOWERS", "SCATTERED_SHOWERS", "RAIN_SHOWERS",
  "HEAVY_RAIN_SHOWERS", "LIGHT_TO_MODERATE_RAIN", "MODERATE_TO_HEAVY_RAIN", "DRIZZLE",
]);

/** "rain" | "storm" | null: how loud the chip's edge is. */
export function weatherTone(p) {
  const t = p?.type ?? "";
  if (t.includes("THUNDER") || (p?.thunderPct ?? 0) >= 50) return "storm";
  if (RAINY.has(t) || (p?.rainPct ?? 0) >= 60) return "rain";
  return null;
}
