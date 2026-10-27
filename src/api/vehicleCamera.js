// A unit's dashcam on Control Tech's VSS platform (fleet-server modules/camera).
// The VSS account and token stay on the server; what comes back is the
// device, its channels, whether it is connected, and the media server the
// player (lib/vssPlayer) streams from.

import { apiFetch } from "../services/api";

/**
 * @returns {Promise<{
 *   state: 'not_configured'|'no_camera'|'offline'|'live'|'unavailable',
 *   deviceId: string|null, deviceName: string|null,
 *   channels: {no: number, name: string}[],
 *   streamUrl: string|null, message: string|null,
 * }>}
 */
export async function getVehicleCamera(orgId, dbVehicleId, { signal } = {}) {
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/vehicles/${encodeURIComponent(dbVehicleId)}/camera`,
    { signal },
  );
  return res.data;
}

/** "ROAD", "IN CABIN", "CH1" → "Road", "In cabin", "CH1". Installer names are shouted. */
export function channelLabel(name) {
  const s = String(name ?? "").trim();
  if (!s) return "Camera";
  if (/^CH\s*\d+$/i.test(s)) return s.toUpperCase().replace(/\s+/g, "");
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
