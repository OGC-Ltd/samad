// Geofences drawn in Samad: server/fences.go. The map's Draw geofence tool
// creates, edits and removes them; the bodies come from lib/fenceShape
// toPayload, which already has [lng, lat] rings, closed.

import { apiFetch } from '../services/api'

const base = (orgId) => `/api/v1/organisations/${orgId}/geofences`

export async function createFence(orgId, body) {
  const res = await apiFetch(base(orgId), { method: 'POST', body: JSON.stringify(body) })
  return res.data
}

/** A change: any of name, purpose, colour, or the whole shape with its type. */
export async function updateFence(orgId, id, body) {
  const res = await apiFetch(`${base(orgId)}/${id}`, { method: 'PATCH', body: JSON.stringify(body) })
  return res.data
}

export async function deleteFence(orgId, id) {
  try {
    await apiFetch(`${base(orgId)}/${id}`, { method: 'DELETE' })
  } catch (e) {
    // The server answers 204 with no body, which apiFetch's res.json() cannot
    // read. That is the success case, not a failure.
    if (!(e instanceof SyntaxError)) throw e
  }
}
