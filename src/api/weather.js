// Current weather over the map's view: Google Weather API conditions on a grid
// of points, fetched and cached by fleet-server (providers/google-weather).

import { apiFetch } from "../services/api";

/**
 * @param {{ orgId: string, south: number, west: number, north: number, east: number }} p
 * @returns {Promise<{ enabled: boolean, step: number|null, points: object[] }>}
 */
export async function getWeatherGrid({ orgId, south, west, north, east }) {
  const q = new URLSearchParams({
    south: south.toFixed(4), west: west.toFixed(4), north: north.toFixed(4), east: east.toFixed(4),
  });
  const res = await apiFetch(`/api/v1/organisations/${orgId}/weather/grid?${q}`);
  return res.data ?? { enabled: false, step: null, points: [] };
}
