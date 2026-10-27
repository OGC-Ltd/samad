// Estate zone geometry for the map overlay — the planted areas, farm blocks,
// nurseries, wetlands, rivers and haulage roads that make up the Kasulu estate.
//
// These are the SAME rows the geofence violation engine evaluates, served as
// GeoJSON by /geofences/geojson. Drawing them from the fences themselves rather
// than from a separately-imported copy of the CAD drawing means the overlay and
// the alerts can never drift apart: if a zone moves in Wialon, one sync updates
// both what operators see and what the engine enforces.
//
// Fetched ONCE per org and cached. Zone boundaries change on the order of
// months — there is nothing live here, and this must never be put on a poll
// alongside the 30 s telemetry stream.

import { useState, useEffect } from 'react'
import { apiFetch } from '../services/api'
import { readCache, writeCache } from '../services/cache'

const cacheKey = (orgId) => `ft-zones:${orgId}`

// Module-level so an org's geometry is fetched once per page load even if
// several components ask for it.
const inflight = new Map()

function loadZones(orgId) {
  if (!inflight.has(orgId)) {
    inflight.set(
      orgId,
      apiFetch(`/api/v1/organisations/${orgId}/geofences/geojson`)
        .then((res) => {
          writeCache(cacheKey(orgId), res.data)
          return res.data
        })
        .catch((err) => { inflight.delete(orgId); throw err }),
    )
  }
  return inflight.get(orgId)
}

/**
 * @returns {{ zones: object|null, loading: boolean, error: Error|null }}
 *          `zones` is a GeoJSON FeatureCollection, or null until it arrives.
 */
export function useEstateZones(orgId) {
  const [zones, setZones]     = useState(() => (orgId && readCache(cacheKey(orgId))) || null)
  const [loading, setLoading] = useState(() => !(orgId && readCache(cacheKey(orgId))))
  const [error, setError]     = useState(null)

  useEffect(() => {
    if (!orgId) { setZones(null); return }
    let cancelled = false

    // Drop the previous org's geometry IMMEDIATELY. Without this, switching
    // company left the old estate drawn over the new fleet for as long as the
    // new request took — Kasulu's fields under Sukari's trucks.
    setZones(readCache(cacheKey(orgId)) || null)

    const cached = readCache(cacheKey(orgId))
    if (cached) { setZones(cached); setLoading(false) }
    else setLoading(true)

    loadZones(orgId)
      .then((fc) => { if (!cancelled) { setZones(fc); setError(null); setLoading(false) } })
      .catch((err) => { if (!cancelled) { setError(err); setLoading(false) } })

    return () => { cancelled = true }
  }, [orgId])

  return { zones, loading, error }
}
