/**
 * The map's weather layer (operator, 2026-10-27: "use the google map apis to
 * show weather on the map in real time").
 *
 * Google sells weather by point, not as tiles, so the server sends a grid of
 * points over the view (snapped to fixed cells and cached for everyone), and
 * each cell is animated with its weather: rain, wind, storms
 * (lib/weatherEffects). Nothing else is drawn: no chips or labels (operator,
 * 2026-10-27: "we never want them to render on the map").
 */
import { createWeatherEffects } from "./weatherEffects";

/** Re-read while on: Google refreshes current conditions about this often. */
export const WEATHER_REFRESH_MS = 10 * 60_000;
/** Wait for the map to settle before asking for a new view. */
const SETTLE_MS = 600;

/**
 * Draw on `map` (lib/mapEngine). `fetchGrid(bounds)` resolves to the server's
 * `{ points, step }`. Returns a function that removes the layer.
 */
export function addWeatherLayer(map, fetchGrid, { onError } = {}) {
  const l = map._l;
  if (!l.getPane("g-weather")) {
    const pane = l.createPane("g-weather");
    pane.style.zIndex = "415"; // over zones and tracks, under the units
  }
  const fx = createWeatherEffects(l, "g-weather");
  let seq = 0;
  let settle = null;

  const load = async () => {
    const mine = ++seq;
    const b = l.getBounds();
    try {
      const { points, step } = await fetchGrid({
        south: Math.max(-90, b.getSouth()), west: Math.max(-180, b.getWest()),
        north: Math.min(90, b.getNorth()),  east: Math.min(180, b.getEast()),
      });
      if (mine !== seq) return; // a newer view answered, or the layer is gone
      fx.set(points, step);
    } catch (err) {
      if (mine === seq) onError?.(err);
    }
  };
  const onMove = () => { clearTimeout(settle); settle = setTimeout(load, SETTLE_MS); };

  l.on("moveend", onMove);
  load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, WEATHER_REFRESH_MS);
  return () => {
    seq++;
    clearTimeout(settle);
    clearInterval(timer);
    l.off("moveend", onMove);
    fx.remove();
  };
}
