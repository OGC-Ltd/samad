// Per-vehicle operator brief — "what has this unit done today", in a sentence
// or three, for the panel that opens when a vehicle is clicked.
//
// Generated on the server from MEASURED facts (distance from the vehicle's own
// fixes, fuel from recorded fillings, driver and destination from the open
// dispatch) and phrased by the model. When no model is configured, or it fails,
// the server writes the same brief deterministically from the same facts — so
// this endpoint always answers and there is no client-side fallback to keep in
// step with it.

import { apiFetch } from "../services/api";

/** @returns {Promise<{msg: string, source: 'model'|'facts', generatedAt: string, facts: object}|null>} */
/** `fresh`: measure and phrase it anew, past the server's ten-minute cache (one per click). */
export async function getVehicleBrief({ orgId, vehicleId, fresh = false }) {
  if (!orgId || !vehicleId) return null;
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/vehicles/${encodeURIComponent(vehicleId)}/brief${fresh ? "?fresh=1" : ""}`
  );
  return res.data ?? null;
}

/**
 * The unit's insight — headline, findings, one action, risk — written in the
 * background by the server from fourteen days of the unit's records and its
 * own earlier insights (fleet-server vehicles/vehicle-insight). Stored, so it
 * answers at once.
 *
 * @returns {Promise<{headline: string, findings: {kind: string, text: string}[], action: string|null, risk: 'low'|'medium'|'high', source: 'model'|'facts', generatedAt: string}|null>}
 */
export async function getVehicleInsight({ orgId, vehicleId }) {
  if (!orgId || !vehicleId) return null;
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/vehicles/${encodeURIComponent(vehicleId)}/insight`
  );
  return res.data ?? null;
}
