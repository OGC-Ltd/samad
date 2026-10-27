/**
 * The map's ruler: the length of a clicked path, and how to say it.
 *
 * Great-circle per leg (haversine), summed. Over the distances anyone measures
 * on a fleet map — a yard, a haul road, a run between two mills — that is
 * within a metre or two of the ellipsoid, which is far below what a click on a
 * screen pixel can place.
 */
import { haversineM } from "./tripProgress";

/** A point in either shape the map hands out: {lat,lng} numbers or lat()/lng(). */
export const plainPoint = (p) => ({
  lat: typeof p.lat === "function" ? p.lat() : p.lat,
  lng: typeof p.lng === "function" ? p.lng() : p.lng,
});

/** Total length in metres; 0 for fewer than two points. */
export function pathLengthM(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += haversineM(plainPoint(points[i - 1]), plainPoint(points[i]));
  return m;
}

/** "640 m", "1.24 km", "38.6 km", "412 km". */
export function formatDistance(m) {
  if (!Number.isFinite(m) || m <= 0) return "0 m";
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  if (km < 10) return `${km.toFixed(2)} km`;
  if (km < 100) return `${km.toFixed(1)} km`;
  return `${Math.round(km)} km`;
}
