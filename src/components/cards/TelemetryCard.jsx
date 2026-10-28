// Vehicle telemetry readout card — live vitals off the SSE stream.
//
// Engine temperature and oil level used to occupy two of these four cells.
// Neither is reported by the fleet's trackers: the Wialon adapter sets
// engineTempC and oilLevelPct to null on every frame because the position
// payload has no such channels, so both cells read "—" for every vehicle,
// forever. They are replaced by two counters the units DO report — engine
// hours and total mileage. A null still renders as "—", which now means a
// specific unit is not reporting that counter rather than that the channel
// does not exist at all.

import "./TelemetryCard.scss";

const dash = (v, fmt) => (v == null ? "-" : fmt(v));

const CELLS = [
  { key: "mileageKm",   label: "MILEAGE",      icon: "🛣", iconCls: "amber", format: v => dash(v, x => `${Math.round(x).toLocaleString()} km`) },
  { key: "fuelLevel",   label: "FUEL LEVEL",   icon: "⛽", iconCls: "green", format: v => dash(v, x => `${x}%`), hi: true },
  { key: "engineHours", label: "ENGINE HOURS", icon: "⏱", iconCls: "green", format: v => dash(v, x => `${Math.round(x).toLocaleString()} h`) },
  { key: "gpsStatus",   label: "GPS STATUS",   icon: "📡", iconCls: "blue",  format: v => dash(v, x => x) },
];

export default function TelemetryCard({ telemetry, siteId, title = "Asset Telemetry" }) {
  return (
    <div className="tc-card">
      <div className="tc-header">
        <span className="tc-title">{title}</span>
        <span className="tc-tag">{siteId}</span>
      </div>
      <div className="tc-grid">
        {CELLS.map(cell => (
          <div className="tc-cell" key={cell.key}>
            <span className={`tc-icon ${cell.iconCls}`}>{cell.icon}</span>
            <div>
              <div className="tc-label">{cell.label}</div>
              <div className={`tc-value${cell.hi ? " hi" : ""}`}>
                {cell.format(telemetry[cell.key])}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
