/**
 * The map's weather layer (operator, 2026-10-27: "use the google map apis to
 * show weather on the map in real time").
 *
 * Google sells weather by point, not as tiles, so the server sends a grid of
 * points over the view (snapped to fixed cells and cached for everyone), and
 * each cell is animated with its weather: rain, wind, storms
 * (lib/weatherEffects). Nothing else is drawn: no chips or labels (operator,
 * 2026-10-27: "we never want them to render on the map"). What a cell's
 * weather is in words and numbers (temperature, wind) goes to `onReadout`,
 * for a card at the map's edge: the cell under the cursor, or the one under
 * the map's centre while the cursor is off the map.
 */
import { createWeatherEffects } from "./weatherEffects";

/** Re-read while on: Google refreshes current conditions about this often. */
export const WEATHER_REFRESH_MS = 10 * 60_000;
/** Wait this long after the map stops before asking for the new view. */
const SETTLE_MS = 200;
/**
 * The server answers within about a second with the cells Google has given it
 * and a count of those still `pending` (still being looked up, into its
 * cache). Ask again this soon for the rest, at most FOLLOW_UPS times.
 */
const FOLLOW_UP_MS = 1_500;
const FOLLOW_UPS = 4;

/** The point whose cell (`step` degrees square, centred on it) holds lat/lng. */
export function pointAt(points, step, lat, lng) {
  if (!step) return null;
  return points.find((p) => Math.abs(p.lat - lat) <= step / 2 && Math.abs(p.lng - lng) <= step / 2) ?? null;
}

/**
 * Draw on `map` (lib/mapEngine). `fetchGrid(bounds)` resolves to the server's
 * `{ points, step }`. Returns a function that removes the layer.
 */
export function addWeatherLayer(map, fetchGrid, { onError, onReadout } = {}) {
  const l = map._l;
  if (!l.getPane("g-weather")) {
    const pane = l.createPane("g-weather");
    pane.style.zIndex = "415"; // over zones and tracks, under the units
  }
  const fx = createWeatherEffects(l, "g-weather");
  let seq = 0;
  let settle = null;
  let follow = null;
  let grid = { points: [], step: null };
  let shown;   // the point last handed to onReadout
  let cursor = null;
  const readout = () => {
    const at = cursor ?? l.getCenter();
    const p = pointAt(grid.points, grid.step, at.lat, at.lng);
    if (p !== shown) { shown = p; onReadout?.(p); }
  };
  const onMouse = (e) => { cursor = e.latlng; readout(); };
  const onLeave = () => { cursor = null; readout(); };

  const load = async (round = 0) => {
    clearTimeout(follow);
    const mine = ++seq;
    const b = l.getBounds();
    try {
      const { points, step, pending } = await fetchGrid({
        south: Math.max(-90, b.getSouth()), west: Math.max(-180, b.getWest()),
        north: Math.min(90, b.getNorth()),  east: Math.min(180, b.getEast()),
      });
      if (mine !== seq) return; // a newer view answered, or the layer is gone
      fx.set(points, step);
      grid = { points, step };
      readout();
      if (pending > 0 && round < FOLLOW_UPS) follow = setTimeout(() => load(round + 1), FOLLOW_UP_MS);
    } catch (err) {
      if (mine === seq) onError?.(err);
    }
  };
  const onMove = () => { readout(); clearTimeout(settle); settle = setTimeout(() => load(), SETTLE_MS); };

  l.on("moveend", onMove);
  l.on("mousemove", onMouse);
  l.on("mouseout", onLeave);
  load();
  const timer = setInterval(() => { if (!document.hidden) load(); }, WEATHER_REFRESH_MS);
  return () => {
    seq++;
    clearTimeout(settle);
    clearTimeout(follow);
    clearInterval(timer);
    l.off("moveend", onMove);
    l.off("mousemove", onMouse);
    l.off("mouseout", onLeave);
    onReadout?.(null);
    fx.remove();
  };
}
