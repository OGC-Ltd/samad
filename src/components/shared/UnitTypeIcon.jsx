/**
 * A unit's own picture in a list (operator, 2026-10-20: "on every search bar
 * for vehicle each vehicle should get its icon, if a lorry the lorry icon").
 *
 * Drawn from the same truck atlas the map markers use (every Samad unit is a
 * truck); its label comes from `spriteKind` (lib/vehicleMap). A row in a
 * search and the marker it jumps to are therefore the same picture.
 * The atlas row is the unit's status, as on the map: green on the move, grey
 * parked, sky blue idling, red speeding.
 *
 * FleetMap.scss owns `.lf-truck` and the atlas URL; the sizing maths there is
 * driven off `--lf-marker`, so setting it here is all a list needs.
 */

import { fleetType, fleetTypeLabel, spriteKind } from "../../lib/vehicleMap";
import { spriteColumn } from "../../lib/fleetSprite";
import "../body/FleetMap.scss";
import "./UnitTypeIcon.scss";

// The atlas's rows, as FleetMap.jsx's TRUCK_STATUS_ROWS / TRUCK_ROW_FOR and
// UnitsMenu's copy; change all three if the atlas is re-baked.
const ATLAS_ROWS = ["ok", "speeding", "theft", "parked", "idling"];
const ATLAS_ROW_FOR = { stationary: "parked", "signal-lost": "ok", offline: "parked" };
const atlasRow = (status) => Math.max(0, ATLAS_ROWS.indexOf(ATLAS_ROW_FOR[status] ?? status));
/**
 * The heading drawn: side-on, facing right (90°, column 6 of 24). Column 0
 * is nose-up, which at list size is a sliver every machine shares; side-on,
 * a lorry, a tractor, a pickup, a bus and a dozer each read at a glance.
 */
const SIDE_ON = spriteColumn(90);

/**
 * `vehicle` is anything spriteKind reads ({id, name, vehicleType}); `status`
 * defaults to the vehicle's own, and a unit with none draws parked grey.
 */
export default function UnitTypeIcon({ vehicle, size = 22, status, className = "" }) {
  if (!vehicle) return null;
  const kind = spriteKind(vehicle);
  const label = fleetTypeLabel(fleetType(vehicle));
  const row = atlasRow(status ?? vehicle.status ?? "parked");
  return (
    <span
      className={`unit-type-icon lf-truck lf-truck--${kind}${className ? ` ${className}` : ""}`}
      style={{ "--lf-marker": `${size}px`, backgroundPosition: `-${SIDE_ON * size}px -${row * size}px` }}
      title={label}
      role="img"
      aria-label={label}
    />
  );
}
