import { apiFetch } from '../services/api'

/** A fuel alert's investigation map — see fleet-server fuel-investigation. */
export async function getTheftInvestigation(orgId, theftId, { signal } = {}) {
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/fuel/thefts/${encodeURIComponent(theftId)}/investigation`,
    { signal },
  )
  return res.data
}

/** A halted unit's investigation — its stop and route. */
export async function getHaltInvestigation(orgId, dbVehicleId, sinceMs, { signal } = {}) {
  const since = new Date(sinceMs).toISOString()
  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/vehicles/${encodeURIComponent(dbVehicleId)}/halt-investigation?since=${encodeURIComponent(since)}`,
    { signal },
  )
  return res.data
}
