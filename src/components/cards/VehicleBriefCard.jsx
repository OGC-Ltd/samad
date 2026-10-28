// "What has this unit done today" — the first thing an operator should read
// after clicking a vehicle.
//
// It replaces the org-wide fleet brief that used to sit in this panel, which
// said the same thing about the whole fleet no matter which truck you had
// open. Everything in the sentence is measured server-side; the model only
// phrases it, and when there is no model the server writes the same brief from
// the same numbers — so this never has nothing to show.
//
// The key figures are repeated underneath as chips. Prose is quick to read but
// slow to scan, and an operator checking one number should not have to parse a
// sentence to find it.

import "./VehicleBriefCard.scss";
import { useApiData } from "../../hooks/useApiData";
import LoadError from "../shared/LoadError";
import { getVehicleBrief } from "../../api/vehicleBrief";

function Chip({ label, value }) {
  // A missing figure is omitted, never shown as a zero — "no fixes today" and
  // "has not moved" are different facts.
  if (value == null) return null;
  return (
    <span className="vb-chip">
      <span className="vb-chip-lbl">{label}</span>
      <span className="vb-chip-val">{value}</span>
    </span>
  );
}

export default function VehicleBriefCard({ orgId, vehicleId, plate, distanceTodayKm }) {
  // Re-read whenever the DISTANCE ON THE CARDS BELOW moves.
  //
  // The brief is generated on demand and cached server-side; the trip figure on
  // the Active Trip card comes off the snapshot, which this browser re-reads on
  // its own minute timer. Left alone, the two clocks put the same truck at 0.4
  // km in one card and 0.7 km in another on the same screen. Keying the fetch
  // on the live figure makes the brief follow the card: the moment the card's
  // number changes, this asks for a brief written against that number, and the
  // server drops its cache for exactly the same reason (see distanceStillAgrees).
  const { data: brief, loading, error, retry } = useApiData(
    () => getVehicleBrief({ orgId, vehicleId }),
    [orgId, vehicleId, distanceTodayKm]
  );

  if (error) {
    return (
      <div className="vb-card">
        <LoadError label={`${plate ?? "Vehicle"} brief`} onRetry={retry} />
      </div>
    );
  }

  if (loading || !brief) {
    return (
      <div className="vb-card">
        <div className="vb-header">
          <span className="vb-spark" aria-hidden="true">✦</span>
          <span className="vb-title">Today</span>
        </div>
        <div className="vb-skeleton" aria-label="Loading brief">
          <span /><span /><span />
        </div>
      </div>
    );
  }

  const f = brief.facts ?? {};

  return (
    <div className="vb-card">
      <div className="vb-header">
        <span className="vb-spark" aria-hidden="true">✦</span>
        <span className="vb-title">Today</span>
        {/* Says which wrote it. A brief the model phrased and one the server
            assembled carry the same facts, but the operator is entitled to
            know which they are reading. */}
        <span className="vb-source">{brief.source === "model" ? "AI summary" : "from readings"}</span>
      </div>

      <p className="vb-msg">{brief.msg}</p>

      <div className="vb-chips">
        {/* "Drove today" when the run has closed — the name is still the answer
            to who took this vehicle out, but nobody is in it now and a bare
            "Driver" chip beside a parked unit reads as if somebody is. */}
        <Chip
          label={f.driverSource === "last-dispatch" ? "Drove today" : "Driver"}
          value={f.driver}
        />
        <Chip label="Since"    value={f.startedAt} />
        <Chip label="Distance" value={f.distanceTodayKm != null ? `${f.distanceTodayKm} km` : null} />
        <Chip label="Refuelled" value={f.refuelledLitres != null ? `${f.refuelledLitres} L` : null} />
        {/* Where it was refuelled, shortened server-side to the parts that
            identify the place — the provider records the full administrative
            address and it does not fit on a chip, or in a sentence. */}
        <Chip label="Fuelled at" value={f.refuelLocations?.[0] ?? null} />
        <Chip label="Sent to"  value={f.destination} />
        {/* The finished run's own fields. They never appear alongside the open
            ones — a vehicle is either out or it is not. */}
        <Chip label="Ran to"   value={f.lastRunDestination} />
        <Chip label="Back at"  value={f.lastRunReturnedAtLocal} />
        {/* The two halves of the dispatch, kept apart. When the run was raised
            and when the unit actually cleared the yard are different facts and
            on this fleet they are routinely hours apart. */}
        <Chip label="Dispatched" value={f.dispatchedAtLocal} />
        <Chip
          label="Left yard"
          value={f.leftYardLocal
            ? f.leftYardLocal + (f.yardWaitHours != null ? ` (+${f.yardWaitHours} h)` : "")
            : null}
        />
        {/* No "Due back" chip, deliberately. The sales office sets no return
            commitment, so the value was this fleet's median for the same
            destination — an estimate sitting in a row of facts, indistinguishable
            from the dispatch clocks above it, and carrying a grey note beneath
            the chips to explain itself. A brief that has to apologise for one of
            its own figures should not be carrying that figure. */}
      </div>
    </div>
  );
}
