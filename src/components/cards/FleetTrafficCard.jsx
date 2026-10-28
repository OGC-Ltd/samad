// Fleet-wide traffic summary card — computed from the LIVE fleet's journey
// legs (real sim places: mill, farms, depots), not the old mock route list.

import { useMemo } from "react";
import "./FleetTrafficCard.scss";
import { summarizeFleetTraffic } from "../../api/traffic";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import LoadError from "../shared/LoadError";

const CONDITION_STYLE = {
  clear:    { color: "#22c55e" },
  moderate: { color: "#f59e0b" },
  heavy:    { color: "#ef4444" },
};

export default function FleetTrafficCard() {
  const { vehicles, loading, error, retry } = useFleetLiveShared();

  // Conditions are deterministic per vehicle+leg, so only recompute when the
  // set of active journeys changes — not on every position frame.
  const legsKey = useMemo(
    () => vehicles.map((v) => `${v.id}:${v.phase}:${v.departure}>${v.destination}`).join("|"),
    [vehicles]
  );
  const summary = useMemo(
    () => summarizeFleetTraffic(vehicles),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [legsKey]
  );

  return (
    <div className="fleet-traffic-card">
      <div className="ftc-header">
        <span className="ftc-title">Route Traffic</span>
        <span className="ftc-scope">All active routes</span>
      </div>

      {error && vehicles.length === 0 && (
        <LoadError label="Traffic conditions" onRetry={retry} />
      )}

      {loading && vehicles.length === 0 && !error && (
        <div className="ftc-loading">
          <span className="ftc-spinner" />
          <span>Checking route conditions…</span>
        </div>
      )}

      {vehicles.length > 0 && (
        <>
          <div className="ftc-summary">
            <span className="ftc-count">
              <strong>{summary.delayedRoutes}</strong> of {summary.activeRoutes} routes delayed
            </span>
          </div>

          {summary.highlights.length > 0 ? (
            <div className="ftc-highlights">
              {summary.highlights.map((h, i) => (
                <div className="ftc-highlight" key={i}>
                  <span
                    className="ftc-highlight-dot"
                    style={{ background: CONDITION_STYLE[h.severity]?.color || "#f59e0b" }}
                  />
                  <span className="ftc-highlight-text">{h.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
