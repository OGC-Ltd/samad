// Per-vehicle traffic conditions card.

import "./TrafficCard.css";
import { getTrafficHighlights } from "../../api/traffic";
import { useApiData } from "../../hooks/useApiData";
import LoadError from "../shared/LoadError";

const CONDITION_STYLE = {
  clear:    { label: "Clear",           color: "#22c55e", icon: "✓" },
  moderate: { label: "Moderate traffic", color: "#f59e0b", icon: "⚠" },
  heavy:    { label: "Heavy traffic",    color: "#ef4444", icon: "⛔" },
};

export default function TrafficCard({ vehicle }) {
  const { data: traffic, loading, error, retry } = useApiData(
    () => vehicle
      ? getTrafficHighlights({ vehicleId: vehicle.id, departure: vehicle.departure, destination: vehicle.destination })
      : Promise.resolve(null),
    [vehicle?.id]
  );

  const style = traffic ? CONDITION_STYLE[traffic.condition] : null;

  return (
    <div className="traffic-card">
      <div className="trf-header">
        <span className="trf-title">Route Traffic</span>
        {vehicle?.destination && <span className="trf-destination">→ {vehicle.destination}</span>}
      </div>

      {error && (
        <LoadError label="Traffic conditions" onRetry={retry} />
      )}

      {loading && !error && (
        <div className="trf-loading">
          <span className="trf-spinner" />
          <span>Checking route conditions…</span>
        </div>
      )}

      {traffic && !loading && (
        <>
          <div className="trf-summary">
            <span className="trf-condition" style={{ color: style.color }}>
              <span className="trf-condition-icon">{style.icon}</span>
              {style.label}
            </span>
            {traffic.delayMin > 0 && (
              <span className="trf-delay">+{traffic.delayMin} min delay</span>
            )}
          </div>

          {traffic.highlights.length > 0 ? (
            <div className="trf-highlights">
              {traffic.highlights.map((h, i) => (
                <div className="trf-highlight" key={i}>
                  <span
                    className="trf-highlight-dot"
                    style={{ background: CONDITION_STYLE[h.severity]?.color || "#f59e0b" }}
                  />
                  <span className="trf-highlight-text">{h.text}</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
