// Maps a fleettrack company to its fleet-server organisation.
//
// fleettrack identifies companies by slug ("sukari"); the backend keys
// everything off an organisation cuid with a human `code` ("SUKARI"). We fetch
// the org roster once from /bootstrap and match by code, so any page that needs
// live backend data can turn a companyId into an orgId.

import { apiFetch } from '../services/api'
import { readCache, writeCache } from '../services/cache'

// company slug → backend org `code`. Only orgs actually seeded in the DB
// resolve; the rest return null → the caller renders empty.
export const ORG_CODE_BY_COMPANY = {
  samad: 'SAMAD',
}

const BOOTSTRAP_CACHE = 'ft-bootstrap'

// The roster rarely changes — cache it in localStorage so resolveOrgId resolves
// instantly on a reload (and start the snapshot without waiting on the network),
// while a background fetch refreshes the cache for next time. Reset the in-flight
// promise on failure so a transient error doesn't poison later attempts.
let bootstrapPromise = null
export function loadBootstrap() {
  const cached = readCache(BOOTSTRAP_CACHE)
  if (!bootstrapPromise) {
    bootstrapPromise = apiFetch('/api/v1/bootstrap')
      .then(res => { writeCache(BOOTSTRAP_CACHE, res.data); return res.data })
      .catch(err => { bootstrapPromise = null; if (cached) return cached; throw err })
  }
  // If we have a cached roster, use it immediately; the fetch above still runs
  // and refreshes the cache in the background.
  return cached ? Promise.resolve(cached) : bootstrapPromise
}

/** Find a company's org in a roster, by code first and then by name. */
function matchOrg(orgs, companyId) {
  const code = ORG_CODE_BY_COMPANY[companyId] ?? String(companyId ?? '').toUpperCase()
  return (
    orgs.find(o => (o.code ?? '').toUpperCase() === code) ??
    orgs.find(o => (o.name ?? '').toLowerCase().includes(String(companyId ?? '').toLowerCase())) ??
    null
  )
}

/** Fetch the roster from the network, bypassing the cache, and re-cache it. */
function refreshBootstrap() {
  bootstrapPromise = apiFetch('/api/v1/bootstrap')
    .then(res => { writeCache(BOOTSTRAP_CACHE, res.data); return res.data })
    .catch(err => { bootstrapPromise = null; throw err })
  return bootstrapPromise
}

export async function resolveOrgId(companyId) {
  const { orgs = [] } = await loadBootstrap()
  const hit = matchOrg(orgs, companyId)
  if (hit) return hit.id

  // A MISS is not the same as "no such org", because the roster above may be
  // the cached one — and readCache has no expiry, so a browser that loaded the
  // dash before an organisation existed holds a list without it indefinitely.
  //
  // That is not hypothetical: Menengai and West Sugar were added on 2026-08-31
  // and were invisible to every existing browser, which resolved them to null
  // and drew an empty map while the API was serving 244 and 486 vehicles.
  // Returning null here on a stale list reports "this company has no fleet"
  // when the truthful answer is "this list is out of date".
  //
  // The roster is one small request and a miss is rare, so it is worth paying
  // for rather than guessing.
  try {
    const { orgs: fresh = [] } = await refreshBootstrap()
    return matchOrg(fresh, companyId)?.id ?? null
  } catch {
    return null
  }
}
