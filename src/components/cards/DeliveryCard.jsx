// Active trip card — the open dispatch as a ROUND TRIP: yard → destination →
// yard. `delivery` is null when the vehicle is not out on one.
//
// A dispatch is not finished when the unit reaches the cane zone, it is
// finished when it is back at the plant, so the card shows three stops rather
// than two and the bar covers the whole run: 0% in the yard, 50% at the
// destination, 100% back. It is filled from the vehicle's POSITION, never from
// elapsed time — an earlier version of this bar ran on time and showed a
// tractor 90% done while it sat in the yard having never left.
//
// Where a figure cannot be measured it is absent rather than zero. A dispatch
// whose destination the fleet has never completed a trip to has no coordinates
// and therefore no distances; a unit that has not reported since it was
// dispatched has no position at all. Both are common (20 of 52 open runs are
// silent) and both say so.

import "./DeliveryCard.scss";
import { LEG_LABEL, fmtDuration } from "../../lib/tripProgress";
import ShieldIcon from "../shared/ShieldIcon";
import { useTrafficRoute, routeTarget, useRoutingAvailable } from "../../hooks/useTrafficRoute";
import { delayCause } from "../../lib/tomtomTraffic";

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/**
 * Road distance and arrival with live traffic, and why it is late if it is.
 *
 * Replaces the straight-line ETA where a route provider is on (TomTom, or Google through the server): road
 * distance instead of great-circle, travel time from the provider's live
 * speeds instead of this second's km/h, and the traffic delay kept apart from
 * a stop that traffic does not explain. See lib/tomtomTraffic delayCause.
 */
function TrafficEta({ traffic }) {
  const target = routeTarget(traffic.trip);
  const { data, isPending, isError } = useTrafficRoute({
    vehicleId: traffic.vehicleId,
    lat: traffic.lat,
    lng: traffic.lng,
    to: target?.to ?? null,
    travelMode: traffic.travelMode,
    enabled: target != null,
  });
  if (!target) return null;
  const where = target.towards === "yard" ? "the yard" : "destination";
  if (isPending) return <div className="dc-eta dc-eta--muted">Routing to {where} with live traffic…</div>;
  if (isError || !data) return <div className="dc-eta dc-eta--muted">Live traffic unavailable</div>;

  const minutes = Math.round(data.travelS / 60);
  const cause = delayCause(data, traffic.speedKmh);
  const ago = Math.round((Date.now() - data.fetchedAt) / 60_000);
  return (
    <div className="dc-traffic">
      <div className="dc-eta">
        <span className="dc-eta-val">{(data.lengthM / 1000).toFixed(1)} km</span> by road to {where}
        {" · "}arrives <span className="dc-eta-val">{clock(data.arrivalMs)}</span>
        {" "}<span className="dc-eta-in">({fmtDuration(minutes)})</span>
      </div>
      {cause && <div className={`dc-cause dc-cause--${cause.kind}`}>{cause.text}</div>}
      <div className="dc-eta-src">
        Free flow {fmtDuration(Math.round(data.noTrafficS / 60))}
        {" · "}{data.source ?? "TomTom"} live traffic · {ago < 1 ? "just now" : `${ago} m ago`}
      </div>
    </div>
  );
}

const LEG_CLASS = {
  "no-fix":         "dc-leg--silent",
  "at-yard":        "dc-leg--yard",
  "outbound":       "dc-leg--outbound",
  "at-destination": "dc-leg--dest",
  "returning":      "dc-leg--returning",
  "back":           "dc-leg--back",
};

export default function DeliveryCard({ delivery, pending }) {
  const routing = useRoutingAvailable();
  if (!delivery) {
    return (
      <div className="dc-card">
        <div className="dc-title">Active Trip</div>
        <div className="dc-row">
          <span className="dc-dot" style={{ background: pending ? "#f59e0b" : "#94a3b8" }} />
          <span className="dc-place" style={{ color: "var(--text-secondary, #8b949e)" }}>
            {/* A dispatch raised today that has not become a journey yet is a
                different state from "at rest", and the reason it has not is
                the useful part — the paperwork goes up well before the wheels
                turn, and a unit can go silent the moment it does. */}
            {pending
              ? `Dispatched${pending.destination ? ` to ${pending.destination}` : ""} - ${pending.reason}`
              : "No active trip, vehicle at rest"}
          </span>
        </div>
        {pending?.driver && <div className="dc-driver dc-driver--pending">{pending.driver}</div>}
      </div>
    );
  }

  const { leg, legText, percent, from, to, departedAt, arrivedAt, arrived,
          serialNumber, eta, totalKm, distanceTodayKm, driver, status,
          destinationPlaced, awaitingSignIn, traffic } = delivery;
  const routed = routing && traffic && traffic.fresh && routeTarget(traffic.trip) != null;

  // Home, which is NOT the same as finished. A trip is completed by the
  // sign-in: once the guard signs the unit back in the run leaves the open set,
  // so a completed run never reaches this card and nothing on it is ever done.
  // `back` means the truck is standing at the gate with the paperwork
  // outstanding — worth a tick for the journey, never for the run.
  const home = leg === "back";

  return (
    <div className="dc-card">
      <div className="dc-title">
        Active Trip
        <span className={`dc-leg ${LEG_CLASS[leg] ?? ""}`}>{legText ?? LEG_LABEL[leg] ?? leg}</span>
        {status === "OVERDUE" && <span className="dc-overdue">Overdue</span>}
      </div>

      {driver && <div className="dc-driver">{driver}</div>}

      {/* Out and back. The middle stop is the destination; the yard bookends
          it, because the run is only complete once the unit is home. */}
      <div className="dc-row">
        <span className="dc-dot green" />
        <span className="dc-place">{from}</span>
        <span className="dc-time muted">{departedAt}</span>
      </div>

      <div className="dc-row">
        <span className={`dc-dot ${arrived ? "green" : "amber"}`} />
        <span className="dc-place">{to}</span>
        <span className={`dc-time ${arrived ? "muted" : ""}`}>{arrivedAt}</span>
      </div>

      <div className="dc-row">
        {/* Amber, not green, when the truck is home: the journey is over and
            the RUN is not. Green here would be the card ticking off a trip the
            gate has not closed. */}
        <span className={`dc-dot ${home ? "amber" : ""}`} />
        <span className="dc-place dc-place--return">{from}</span>
        {/* Two things can stand here and both are facts.
            Home and unsigned wins: the journey is over, the run is not, and the
            outstanding thing is the signature — a clock would be answering a
            question nobody is asking any more. Otherwise the gate's serial,
            where the run carries one; the shield stands in for the word, see
            shared/ShieldIcon.
            Where neither holds, the row ends after the place name. It used to
            fall back to the due-back, and that fallback was the problem: on a
            sales run the office sets no commitment, so the clock printed there
            was this fleet's own median for the destination — an estimate in the
            slot a fact goes in, on a card whose whole discipline is that an
            unmeasurable figure is blank rather than guessed. The caption under
            the bar admitted as much in nine-point grey, which is a note
            apologising for a number instead of not printing it.
            No serial renders yet: the number is attached when a dispatch is
            raised but is absent from the provider's external API (measured
            against /sales and /dispatches, 2026-09-15). The column and the path
            behind it exist — see the server's `eventSerial`. */}
        {awaitingSignIn ? (
          <span className="dc-time dc-awaiting">Awaiting sign-in</span>
        ) : serialNumber ? (
          <span className="dc-time dc-serial" title="Gate serial for this run">
            <ShieldIcon size={10} /> {serialNumber}
          </span>
        ) : null}
      </div>

      <div className="dc-progress-wrap">
        {percent == null ? (
          // No bar rather than a zero one. The two reasons are different and
          // the operator needs to know which: nothing heard from the unit, or
          // nowhere measured to compare it against.
          <div className="dc-nobar">
            {leg === "no-fix"
              ? "No position reported since dispatch"
              : "Destination not on the map, no distance to measure"}
          </div>
        ) : (
          <>
            <div className="dc-track">
              {/* The halfway mark IS the destination, so the bar reads as a
                  round trip rather than as a single journey. */}
              <div className="dc-midpoint" aria-hidden="true" />
              <div className="dc-fill" style={{ width: `${percent}%` }} />
            </div>
            <div className="dc-meta">
              {/* The bar is a POSITION along the round trip, so the caption
                  says that. It used to read "27.8 / 51.4 km round trip", which
                  states distance travelled — and that is a different number
                  entirely: a unit that reached its destination yesterday sits
                  at half the round trip having driven nothing today. The
                  distance actually driven is its own line below. */}
              <span className="dc-cap">
                {totalKm != null ? `${totalKm} km round trip` : "distance not measured"}
              </span>
              <span className="dc-pct">{percent}% of the way</span>
            </div>
            {/* Still to run, and when it lands at the speed it is doing now.
                Straight line, and only while the unit is actually moving — a
                parked tracker reports a km/h or two, and dividing the distance
                by that produces a confident-looking answer twenty times out.
                See lib/tripProgress. */}
            {routed && <TrafficEta traffic={traffic} />}
            {!routed && eta && (
              <div className="dc-eta">
                <span className="dc-eta-val">{eta.remainingKm} km</span>
                {" "}to go
                {eta.moving
                  ? <> · arrives in <span className="dc-eta-val">{fmtDuration(eta.minutes)}</span></>
                  : <span className="dc-eta-stopped"> · stopped</span>}
              </div>
            )}
            {distanceTodayKm != null && (
              <div className="dc-driven">
                <span className="dc-driven-val">{distanceTodayKm} km</span> driven today
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
