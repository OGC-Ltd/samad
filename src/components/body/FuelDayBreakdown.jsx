// The day, in the fuel incident window: a tank ledger and the day's events.
//
// The ledger is built from the SAME `Tile` as the incident figures above it
// and the vehicle card beside it, so its labels, figures, units and notes are
// the window's type by construction rather than a copy that can drift.
//
// Replaces the "Record / Movement / Came back / Rule" rows, which said how the
// verdict was reached and left the reader to reconstruct the day. The ledger
// is lib/fuelDay's arithmetic; the event list is what happened, in order,
// with the incident being looked at marked.

import { Tile } from "../cards/VehicleStatsCard";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { useFuelDay } from "../../hooks/useFuelDay";
import { dayAssessment, dayBreakdown, engineBasisLabel, eventLabel, fleetDayOf, isTheftEvent } from "../../lib/fuelDay";
import "./FuelDayBreakdown.css";

const TZ = "Africa/Nairobi";
const CLOCK = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" });
const WEEKDAY = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" });

const at = (day) => new Date(`${day}T12:00:00Z`);
const prevDay = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 86_400_000);
// Rounded before the sign is read, so -0.04 prints "0.0", not "-0.0".
const l1 = (v) => (v == null ? "-" : (Math.round(v * 10) / 10 || 0).toFixed(1));

/**
 * `cardShowsLevel`: the vehicle card beside this already shows the tank now
 * (FUEL LEVEL), so today's "Level now" would say the same figure twice and is
 * left out (operator, 2026-09-30). A past day's closing level is not what the
 * card shows, so it always stays.
 */
export default function FuelDayBreakdown({ incident, vehicleId, cardShowsLevel = false }) {
  const { orgId } = useFleetLiveShared();
  const day = incident?.beganAt ? fleetDayOf(incident.beganAt) : null;
  const { tank, fillings, drops, loading, error } = useFuelDay(orgId, vehicleId, day);
  if (!day) return null;

  const today = day >= fleetDayOf(new Date().toISOString());
  const showClosing = !(today && cardShowsLevel);
  const b = dayBreakdown({ tank, fillings, drops });
  // The case read in words, in place of the "Not explained" figure that left
  // the reader to do it (operator, 2026-09-27) — see lib/fuelDay.
  const assessment = tank ? dayAssessment(b, incident, today) : [];

  return (
    <section className="fd" aria-label="The day">
      <div className="fd-hdr">
        <span className="fd-title">The day</span>
        <span className="fd-day">
          {DAY.format(at(day))}{today ? ` · so far, to ${CLOCK.format(new Date())}` : ""}
        </span>
      </div>

      {loading && !tank && <p className="fd-note">Loading the day{"…"}</p>}
      {error && <p className="fd-note">Could not load the day: {error}</p>}

      {tank && (
        <>
          <div className="vt-tiles">
            <Tile label="Opening level" value={l1(b.opening)} unit={b.opening != null ? " L" : ""}
                  sub={`${WEEKDAY.format(prevDay(day))}'s close`} />
            <Tile label="Refuelled"
                  value={b.refuelCount === 0 ? "0.0" : `+${l1(b.refuelled)}`} unit=" L"
                  sub={b.refuelCount === 0 ? "none" : `${b.refuelCount} refuel${b.refuelCount === 1 ? "" : "s"}`}
                  valColor={b.refuelCount ? "var(--accent-ok)" : undefined} />
            {showClosing && (
              <Tile label={today ? "Level now" : "Closing level"} value={l1(b.closing)} unit={b.closing != null ? " L" : ""}
                    sub={today ? CLOCK.format(new Date()) : "end of day"} />
            )}
          </div>

          <div className="vt-divider" />

          <div className="vt-tiles">
            <Tile label="Fuel used" value={l1(b.used)} unit={b.used != null ? " L" : ""}
                  sub={showClosing ? "opening + refuelled \u2212 closing" : "opening + refuelled \u2212 fuel level"} />
            <Tile label="Engine should use" value={l1(b.engine)} unit={b.engine != null ? " L" : ""}
                  sub={`${engineBasisLabel(b)}${b.engineRateBasis === "register" ? " · std rate" : ""}`} />
            {b.distanceKm != null && (
              <Tile label="Distance" value={b.distanceKm.toFixed(1)} unit=" km" />
            )}
          </div>

          {assessment.length > 0 && (
            <div className="fd-assess" aria-label="What the day shows">
              <div className="fd-title">What the day shows</div>
              {assessment.map((line, i) => (
                <p key={i} className={"fd-assess-line" + (i === 0 ? " fd-assess-line--lead" : "")}>{line}</p>
              ))}
            </div>
          )}
        </>
      )}

      {b.events.length > 0 && (
        <>
          <div className="fd-events-hdr">
            <span className="fd-title">Events</span>
            <span className="fd-day">{b.events.length}</span>
          </div>
          <ol className="fd-events">
            {b.events.map((e) => {
              // Only a theft case is highlighted (operator, 2026-09-27): a
              // burn finding, a dip that came back or a probe fault is part of
              // the day, not the case, and is drawn plain.
              const theft = isTheftEvent(e);
              const mine = e.id === incident.id && theft;
              const kind = e.type === "refuel"
                ? (e.verdict === "REDISTRIBUTION" ? "muted" : "ok")
                : theft ? "theft" : "muted";
              return (
                <li key={e.id} className={"fd-ev" + (mine ? " fd-ev--mine" : "")}>
                  <span className="fd-ev-time">{CLOCK.format(new Date(e.at))}</span>
                  <span className={`fd-ev-dot fd-ev-dot--${kind}`} aria-hidden="true" />
                  <span className="fd-ev-lbl">
                    {eventLabel(e)}
                    {mine && <span className="fd-ev-this">this one</span>}
                  </span>
                  {/* The tiles' own figure classes, so an event's litres read
                      exactly like the litres in the ledger above. */}
                  <span className={`vt-tile-val fd-ev-val fd-val--${kind}`}>
                    {e.type === "refuel" ? "+" : "−"}{l1(e.litres)}<span className="vt-tile-unit"> L</span>
                  </span>
                </li>
              );
            })}
          </ol>
          {b.events.length > 1 && (
            <p className="fd-note">
              Events overlap and re-measure the same fall, so they are not added up: the tank figures above are the day{"’"}s total.
            </p>
          )}
        </>
      )}
    </section>
  );
}
