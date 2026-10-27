// Sensor-coverage card for the map side panel, off the shared live fleet
// stream. It reports which units are reporting and which channels are
// arriving — NOT a maintenance grade. It previously showed ok / due-soon /
// overdue counts derived from a hardcoded service catalogue against a reset
// point that is 0 for every vehicle in production; see lib/vehicleReadings.

import "./FleetMaintenanceCard.css";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { readingCoverage, vehicleReadings, formatKm, formatSince } from "../../lib/vehicleReadings";
import LoadError from "../shared/LoadError";

export default function FleetMaintenanceCard() {
  const { vehicles, loading, error, retry } = useFleetLiveShared();

  // This card used to show ok / due-soon / overdue counts and name the "worst
  // item" per vehicle. Every one of those was graded against invented service
  // intervals — see lib/vehicleReadings. It now reports what the trackers
  // actually send, which is both true and more actionable: a unit that has
  // stopped reporting its odometer is a real fault worth chasing.
  const coverage = readingCoverage(vehicles);
  // Measured against tracked units, never the registry total — a vehicle with
  // no unit bound is not a silent tracker, and counting it as one put 314
  // unfixable rows into a number an operator is meant to act on.
  const summary = {
    ok:      coverage.reporting,
    dueSoon: coverage.tracked - coverage.odometer,
    overdue: coverage.tracked - coverage.reporting,
  };

  // Units silent longest first — the ones actually worth looking at. Scoped to
  // vehicles that HAVE a tracker: an unbound row has never reported, so it
  // sorts to the very top on `lastReportedAt` and would otherwise fill this
  // list permanently with vehicles no one can bring back.
  const urgent = vehicles
    .map((v) => ({ v, r: vehicleReadings(v) }))
    .filter(({ r }) => r.hasTracker && !r.isReporting)
    .sort((a, b) => (a.r.lastReportedAt ?? 0) - (b.r.lastReportedAt ?? 0))
    .slice(0, 3)
    .map(({ v, r }) => ({
      vehicleId: v.id,
      status: r.lastReportedAt == null ? "overdue" : "due-soon",
      task: r.lastReportedAt == null
        ? "never reported"
        : `silent ${formatSince(r.lastReportedAt)} · ${formatKm(r.odometerKm)}`,
    }));

  return (
    <div className="fleet-maint-card">
      <div className="fmc-header">
        <span className="fmc-title">Sensor Coverage</span>
        <span className="fmc-scope">All vehicles</span>
      </div>

      {error ? (
        <LoadError label="Maintenance status" onRetry={retry} />
      ) : loading && vehicles.length === 0 ? (
        <div className="fmc-loading">Loading maintenance status…</div>
      ) : (
        <>
          <div className="fmc-counts">
            <div className="fmc-count-cell">
              <span className="fmc-count-value" style={{ color: "var(--accent-ok)" }}>{summary.ok}</span>
              <span className="fmc-count-label">Reporting</span>
            </div>
            <div className="fmc-count-cell">
              <span className="fmc-count-value" style={{ color: "var(--accent-warn)" }}>{summary.dueSoon}</span>
              <span className="fmc-count-label">No odometer</span>
            </div>
            <div className="fmc-count-cell">
              <span className="fmc-count-value" style={{ color: "var(--accent-crit)" }}>{summary.overdue}</span>
              <span className="fmc-count-label">Silent</span>
            </div>
          </div>

          {urgent.length > 0 && (
            <div className="fmc-urgent-list">
              {urgent.map((r) => (
                <div className="fmc-urgent-row" key={r.vehicleId}>
                  <span className={`fmc-urgent-dot fmc-urgent-dot--${r.status}`} />
                  {/* Both carry a title: once either can be truncated, the
                      full text has to stay reachable, and an operator chasing
                      a silent tracker needs the whole provider id. */}
                  <span className="fmc-urgent-vehicle" title={r.vehicleId}>{r.vehicleId}</span>
                  <span className="fmc-urgent-task" title={r.task}>{r.task}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
