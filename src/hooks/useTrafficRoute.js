// The traffic-aware route for a unit on an active trip, from where it is now to
// the end it is heading for. One TanStack Query entry per unit and target, so
// the Active Trip card and the map's route overlay share a single request.
//
// The key deliberately leaves the POSITION out. A moving truck changes position
// every few seconds, and keying on it would re-route on every tick; instead the
// query re-routes every ROUTE_REFRESH_MS from wherever the unit is by then
// (queryFn reads the newest position through a ref).
//
// Two providers. TomTom (lib/tomtomTraffic) when its flag and key are set;
// otherwise Google through the server (lib/googleRouting), which routes from
// the unit's own Wialon fix and so needs no position from here — only the
// unit's database id, looked up from the shared fleet by plate.

import { useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchTrafficRoute, ROUTE_REFRESH_MS, TRAFFIC_AVAILABLE } from "../lib/tomtomTraffic";
import { fetchRouteAhead, useGoogleRoutingOn } from "../lib/googleRouting";
import { useFleetLiveShared } from "../context/FleetLiveContext";

/**
 * Where a trip is heading, or null when it is not on the road between its two
 * ends. Same rule as tripProgress tripEta: the destination while outbound, the
 * yard while returning, nothing while at either end or never heard from.
 *
 * @param {object|null} trip  a trip from liveTrip()
 * @returns {{to:{lat:number,lng:number,name?:string}, towards:'destination'|'yard'|'picked'}|null}
 */
export function routeTarget(trip) {
  if (!trip) return null;
  if (trip.leg === "outbound" && trip.destinationLat != null && trip.destinationLng != null) {
    return { to: { lat: trip.destinationLat, lng: trip.destinationLng, name: trip.destination ?? undefined }, towards: "destination" };
  }
  if (trip.leg === "returning" && trip.yardLat != null && trip.yardLng != null) {
    return { to: { lat: trip.yardLat, lng: trip.yardLng, name: trip.yardName ?? undefined }, towards: "yard" };
  }
  return null;
}

/** Older than this, a position is history and an ETA from it is fiction. */
const FRESH_MS = 30 * 60_000;

/**
 * Is the unit's position current enough to route from? An offline unit's last
 * fix can be weeks old (KBV 789M: 516 h), and "arrives 04:51" from there would
 * be a confident answer about a truck nobody can see.
 */
export function positionFresh(v, now = Date.now()) {
  if (!v || v.online === false) return false;
  return !Number.isFinite(v.capturedAtMs) || now - v.capturedAtMs <= FRESH_MS;
}

/** Is ANY route-ahead provider available? Components gate their routed UI on this. */
export function useRoutingAvailable() {
  const google = useGoogleRoutingOn();
  return TRAFFIC_AVAILABLE || google;
}

/**
 * @param {object} p
 * @param {string|null} p.vehicleId   the plate (v.id)
 * @param {number|null} p.lat
 * @param {number|null} p.lng
 * @param {{lat:number,lng:number,name?:string}|null} p.to
 * @param {'car'|'truck'} [p.travelMode]
 * @param {boolean} [p.enabled]
 */
export function useTrafficRoute({ vehicleId, lat, lng, to, travelMode = "truck", enabled = true }) {
  const here = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  const hereRef = useRef(here);
  hereRef.current = here;

  const { vehicles, orgId } = useFleetLiveShared();
  const google = useGoogleRoutingOn() && !TRAFFIC_AVAILABLE;
  const dbId = google && vehicleId != null
    ? vehicles?.find((v) => v.id === vehicleId)?.vehicleId ?? null
    : null;

  return useQuery({
    queryKey: ["traffic-route", google ? "google" : "tomtom", vehicleId, to?.lat, to?.lng, travelMode],
    queryFn: ({ signal }) => (google
      ? fetchRouteAhead(orgId, dbId, to, { signal })
      : fetchTrafficRoute(hereRef.current, to, { travelMode, signal })),
    enabled: (TRAFFIC_AVAILABLE || (google && dbId != null && orgId != null))
      && enabled && vehicleId != null && here != null && to != null,
    staleTime: ROUTE_REFRESH_MS - 10_000,
    refetchInterval: ROUTE_REFRESH_MS,
    gcTime: 10 * 60_000,
    retry: 1,
    refetchOnWindowFocus: false,
  });
}
