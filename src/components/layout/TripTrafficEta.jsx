// The unit panel's "Arrives" stop: road distance and arrival with live traffic
// (TomTom, or Google through the server), and whether traffic explains the delay. Rendered inside the
// Departed → Destination list, so it reads as the third stop of the same trip.
// Nothing renders unless the unit is on the road between the two ends of an
// open dispatch — see hooks/useTrafficRoute routeTarget.

import { useTrafficRoute, routeTarget, positionFresh, useRoutingAvailable } from "../../hooks/useTrafficRoute";
import { delayCause, travelModeFor } from "../../lib/tomtomTraffic";
import { liveTrip, fmtDuration } from "../../lib/tripProgress";

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export default function TripTrafficEta({ vehicle }) {
  const trip = liveTrip(vehicle?.trip ?? null, vehicle?.lat, vehicle?.lng);
  const routing = useRoutingAvailable();
  const target = routing && positionFresh(vehicle) ? routeTarget(trip) : null;
  const { data, isPending, isError } = useTrafficRoute({
    vehicleId: vehicle?.id ?? null,
    lat: vehicle?.lat,
    lng: vehicle?.lng,
    to: target?.to ?? null,
    travelMode: travelModeFor(vehicle?.vehicleType),
    enabled: target != null,
  });
  if (!target) return null;

  const label = target.towards === "yard" ? "Back at yard" : "Arrives";
  if (isPending || isError || !data) {
    return (
      <li className="vh-stop vh-stop--eta vh-stop--none">
        <span className="vh-stop-lbl">{label}</span>
        <span className="vh-stop-val">{isPending ? "Routing with live traffic…" : "Live traffic unavailable"}</span>
      </li>
    );
  }

  const cause = delayCause(data, Number.isFinite(vehicle.speed) ? vehicle.speed : null);
  const ago = Math.round((Date.now() - data.fetchedAt) / 60_000);
  return (
    <li className="vh-stop vh-stop--eta">
      <span className="vh-stop-lbl">{label}</span>
      <span className="vh-stop-val">
        {clock(data.arrivalMs)} · {fmtDuration(Math.round(data.travelS / 60))} · {(data.lengthM / 1000).toFixed(1)} km by road
      </span>
      {cause && <span className={`vh-eta-cause vh-eta-cause--${cause.kind}`}>{cause.text}</span>}
      <span className="vh-eta-src">
        Free flow {fmtDuration(Math.round(data.noTrafficS / 60))} · {data.source ?? "TomTom"} live traffic · {ago < 1 ? "just now" : `${ago} m ago`}
      </span>
    </li>
  );
}
