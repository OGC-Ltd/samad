// Driver analytics straight from the fleet-server DB — the /analytics/drivers
// endpoints. Turns the fleettrack company slug into a backend orgId (via
// /bootstrap, see api/org.js) and pulls the driver roster + per-driver deep
// analytics. Real persisted Trip + CargoManifest + FuelTheft + VehicleAlert
// rows — an unseeded company resolves to no org and returns empty, so the
// screen renders empty rather than fabricated numbers.

import { apiFetch } from "../services/api";
import { resolveOrgId } from "./org";

const EMPTY_OVERVIEW = { drivers: [], details: {} };

/**
 * Batched driver analytics: the roster (sorted by tonnes, highest first) PLUS
 * every driver's deep analytics keyed by id, in one request. The server keeps
 * this payload warm in memory, so it returns instantly and selecting a driver
 * on the page is a pure in-memory lookup — no per-selection fetch.
 */
export async function getDriversOverview({ companyId, days = 90 } = {}) {
  const orgId = await resolveOrgId(companyId);
  if (!orgId) return EMPTY_OVERVIEW;
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/analytics/drivers/overview?days=${days}`
  );
  return res.data ?? EMPTY_OVERVIEW;
}
