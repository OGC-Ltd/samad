// Per-vehicle maintenance card — worst wear item + braking-system stats.

import "./MaintenanceCard.css";

export default function MaintenanceCard({ maintenance }) {
  const isGood = maintenance.status === "Good";
  return (
    <div className="mc-card">
      <div className="mc-header">
        <span className="mc-title">Maintenance</span>
        <span className="mc-due">{maintenance.dueIn}</span>
      </div>
      <div className="mc-row">
        <span className="mc-name">{maintenance.item}</span>
        <div className="mc-right">
          <div className="mc-track">
            <div
              className={`mc-fill ${isGood ? "good" : "warn"}`}
              style={{ width: `${maintenance.pct}%` }}
            />
          </div>
          <span className={`mc-status ${isGood ? "good" : "warn"}`}>
            {maintenance.status}
          </span>
        </div>
      </div>

      {/* Braking system — pads/rotors + fluid off the same real service-cycle
          checklist the Maintenance page renders (wear advances with the live
          odometer; a garage visit resets the cycle). */}
      {maintenance.brakes?.length > 0 && (
        <div className="mc-brakes">
          <div className="mc-brakes__heading">Braking system</div>
          {maintenance.brakes.map((b) => (
            <div className="mc-brakes__row" key={b.name}>
              <div className="mc-brakes__toprow">
                <span className="mc-brakes__name">{b.name}</span>
                <span className="mc-brakes__badge" style={{ color: b.color, background: `${b.color}1a`, border: `1px solid ${b.color}44` }}>
                  {b.status}
                </span>
              </div>
              <div className="mc-track">
                <div className="mc-fill" style={{ width: `${b.pctDone}%`, background: b.color }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
