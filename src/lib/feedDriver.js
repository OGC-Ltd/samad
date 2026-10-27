/**
 * Who is on the unit, for a feed line that does not say.
 *
 * The zone crossings and the gate lines are published off telemetry and never
 * look a driver up, so most of the feed names a plate and nobody — on Sukari,
 * 233 of 597 units carry an assignment the panel already knows about and was
 * not showing. This resolves it from the live fleet, which is in the browser
 * anyway, rather than asking the server for something it has on hand.
 *
 * Indexed by BOTH keys because the feed uses both: every emitter that knows
 * its vehicle sets the backend cuid, and the ones that published before the
 * org-attribution pass linked a plate to a vehicle carry only the plate.
 *
 * "Unassigned" is the fleet table's own placeholder for no driver (see
 * lib/vehicleMap) and is dropped here rather than rendered — the same word the
 * feed's own placeholder rule cuts.
 */
export function driverIndex(vehicles) {
  const byId = new Map();
  for (const v of vehicles ?? []) {
    const name = v?.driver && v.driver !== "Unassigned" ? v.driver : null;
    if (!name) continue;
    if (v.vehicleId) byId.set(v.vehicleId, name);
    if (v.id) byId.set(v.id, name);
  }
  return byId;
}

/** The driver for one feed item, or null. */
export const driverFor = (index, item) =>
  (item?.vehicleId && index.get(item.vehicleId)) ||
  (item?.plate && index.get(item.plate)) ||
  null;
