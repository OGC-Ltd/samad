// Deduplicated fleet-snapshot fetch.
//
// The /vehicles/snapshot read is slow (several seconds on the remote pooler),
// and several places load it at once — FleetMap and the Maintenance page (both
// via useFleetLive) plus the header's useFleetCount, doubled again by React
// StrictMode in dev. Firing all of those as separate queries piles concurrent
// load onto the slowest endpoint and makes the cold start worse. This shares a
// single in-flight request per org, and briefly holds the resolved promise so
// near-simultaneous mounts reuse the same result instead of re-querying.

import { apiFetch } from './api'

const inflight = new Map() // orgId -> Promise
const HOLD_MS = 1500       // keep a resolved result reusable for late mounters

export function fetchSnapshot(orgId) {
  const existing = inflight.get(orgId)
  if (existing) return existing

  const p = apiFetch(`/api/v1/organisations/${orgId}/vehicles/snapshot`)
  inflight.set(orgId, p)
  // Clear a little after settling (success or failure) so the next real reload
  // re-queries, but a burst of mounts within the window shares this one.
  p.then(
    () => setTimeout(() => { if (inflight.get(orgId) === p) inflight.delete(orgId) }, HOLD_MS),
    () => { inflight.delete(orgId) },
  )
  return p
}
