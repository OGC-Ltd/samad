// Route ahead, from the server's Google Routes proxy (fleet-server
// modules/route-ahead). Computed from the unit's own Wialon fix on the
// server, so nothing here sends a position. (Reach rings, from Google
// Isochrones, were removed on request, 2026-10-19.)
//
// Two switches, like every other map provider here: GOOGLE_ROUTING_ENABLED
// below turns the client side off outright, and the server's
// GOOGLE_ROUTING_ENABLED (read through /routing/status) decides whether it is
// actually available. TomTom, when its own flag is on, still wins — see
// hooks/useTrafficRoute.

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../services/api";
import { useFleetLiveShared } from "../context/FleetLiveContext";

/** Client kill switch. False hides route ahead whatever the server says. */
export const GOOGLE_ROUTING_ENABLED = true;

/** Is the server's Google routing on for this organisation? False while unknown. */
export function useGoogleRoutingOn() {
  const { orgId } = useFleetLiveShared();
  const { data } = useQuery({
    queryKey: ["routing-status", orgId],
    queryFn: ({ signal }) => apiFetch(`/api/v1/organisations/${orgId}/routing/status`, { signal }).then((r) => r.data),
    enabled: GOOGLE_ROUTING_ENABLED && Boolean(orgId),
    staleTime: 10 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
  return GOOGLE_ROUTING_ENABLED && data?.enabled === true;
}

/**
 * The road from the unit to `to`, in the same shape tomtomTraffic.parseRoute
 * returns, so every consumer of useTrafficRoute reads it unchanged.
 *
 * `jams` is null rather than empty: Google's basic route carries no traffic
 * sections, and an empty list would read as "no traffic anywhere on it" — see
 * tomtomTraffic delayCause.
 */
export async function fetchRouteAhead(orgId, dbVehicleId, to, { signal } = {}) {
  const q = new URLSearchParams({ destLat: String(to.lat), destLng: String(to.lng) });
  if (to.name) q.set("destName", to.name);
  const res = await apiFetch(`/api/v1/organisations/${orgId}/vehicles/${dbVehicleId}/route-ahead?${q}`, { signal });
  return toTrafficRoute(res.data);
}

/** Server answer → TrafficRoute. Exported for tests. */
export function toTrafficRoute(d) {
  if (!d?.enabled) throw new Error("Route ahead is switched off");
  if (!d.route) throw new Error(d.reason ?? "No route");
  const r = d.route;
  const fetchedAt = Date.parse(d.computedAt) || Date.now();
  return {
    lengthM: r.distanceM,
    travelS: r.durationS,
    noTrafficS: r.staticDurationS,
    delayS: Math.max(0, r.durationS - r.staticDurationS),
    arrivalMs: Date.parse(d.etaAt) || fetchedAt + r.durationS * 1000,
    fetchedAt,
    points: r.path.map(([lat, lng]) => ({ lat, lng })),
    jams: null,
    source: "Google",
    fixAt: d.origin?.fixAt ?? null,
  };
}
