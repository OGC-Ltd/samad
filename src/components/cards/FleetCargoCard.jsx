// Cargo/stock card for the map side panel. Both cells are stock — what is on a
// bed right now, and what is in a store right now — and both are real.
//
// ## "In Warehouse" is the silo table, and used to be a haulage total
//
// It read `/analytics/deliveries` over a trailing week: tonnage DELIVERED, a
// flow, offered as a proxy for a stock on the reasoning that received goods are
// the nearest thing the backend tracks. That proxy only holds when the fleet is
// delivering into its OWN stores, and on the route this fleet actually runs it
// is not: Menengai's trucks collect processed sugar at Naitiri — West Kenya
// Sugar's factory — and drop it at Raiply, a customer. None of it is ever
// Menengai's stock. The card read "145 t In Warehouse" for an organisation with
// no warehouse in the flow at all, which is five runs of somebody else's sugar
// delivered to somebody else's site.
//
// It now reads `storage.totalTonnes` from /dashboard/summary, which is the sum
// of this organisation's own `silos` rows. That is the only figure in the
// system that means "in warehouse". No organisation currently has a silo, so it
// reads 0 — and 0 is the honest answer, with `siloCount` there to say whether
// that means "measured empty" or "nothing recorded".

import "./FleetCargoCard.css";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { useDashboardSummary } from "../../hooks/useDashboardSummary";
import { iconForCargo } from "../../utils/cargoIcons";
import { isInTransit } from "../../lib/vehicleMap";

const t1 = (n) => Math.round(n * 10) / 10;

export default function FleetCargoCard({ companyId }) {
  // In-transit stock: cargo on MOVING vehicles, grouped by product. This used
  // to accept any vehicle whose status was not "parked" — but "parked" means
  // offline, so that counted every idling and stationary-but-reporting vehicle
  // as in transit, which is not what the header above claims this cell shows.
  const { vehicles } = useFleetLiveShared();
  const groups = {};
  for (const v of vehicles) {
    if (!isInTransit(v) || !(v.weight > 0)) continue;
    const g = (groups[v.cargo] ??= { cargoName: v.cargo, tonnage: 0, vehicleCount: 0 });
    g.tonnage += v.weight;
    g.vehicleCount += 1;
  }
  const transit = Object.values(groups).sort((a, b) => b.tonnage - a.tonnage);
  const transitTotal = t1(transit.reduce((sum, t) => sum + t.tonnage, 0));

  // Stock in this organisation's own stores. Same hook the header KPIs use, so
  // the two cannot quote different figures, and it SWR-caches per company so a
  // warm visit paints instantly.
  const summary = useDashboardSummary(companyId);
  const storage = summary?.storage ?? null;
  const warehouseTotal = storage?.totalTonnes ?? null;
  const siloCount = storage?.siloCount ?? null;

  return (
    <div className="fleet-cargo-card">
      <div className="fcc-title">Current Stock</div>

      <div className="fcc-totals">
        {/* The tooltip has to distinguish the two ways this is zero. An
            organisation with silos that are empty and one with no silos on
            record both read 0 t, and only the second means "this system has
            nothing to tell you". */}
        <div
          className="fcc-total-cell"
          title={siloCount === 0
            ? "No storage recorded for this organisation, cargo hauled for other sites is not stock"
            : `Stock held across ${siloCount ?? "this organisation's"} silo${siloCount === 1 ? "" : "s"}`}
        >
          <span className="fcc-total-value">
            {warehouseTotal != null ? warehouseTotal : "…"}
          </span>
          <span className="fcc-total-unit">t</span>
          <span className="fcc-total-label">In Warehouse</span>
        </div>
        <div className="fcc-total-cell" title="Cargo currently on moving vehicles">
          <span className="fcc-total-value" style={{ color: "#f59e0b" }}>{transitTotal}</span>
          <span className="fcc-total-unit">t</span>
          <span className="fcc-total-label">In Transit</span>
        </div>
      </div>

      <div className="fcc-breakdown">
        {transit.map((t) => (
          <div className="fcc-row" key={t.cargoName}>
            <span className="fcc-icon">{iconForCargo(t.cargoName)}</span>
            <div className="fcc-info">
              <div className="fcc-name">{t.cargoName}</div>
              <div className="fcc-sub">{t.vehicleCount} vehicle{t.vehicleCount === 1 ? "" : "s"} en route</div>
            </div>
            <span className="fcc-tonnage">{t1(t.tonnage)}t</span>
          </div>
        ))}
        {transit.length === 0 && (
          <div className="fcc-loading">No cargo in transit right now.</div>
        )}
      </div>
    </div>
  );
}
