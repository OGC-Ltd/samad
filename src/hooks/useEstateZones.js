// The organisation's geofences for the map: IntelliFleet's zones (read-only)
// and the ones drawn in Samad (server/fences.go), as one GeoJSON collection
// from /geofences/geojson. The stranded-stop test and playback read it too.
//
// Fetched once per org and cached; reloadEstateZones fetches it again after a
// fence is drawn, changed or removed. Never put on the 30 s telemetry poll.

import { useState, useEffect } from 'react'
import { apiFetch } from '../services/api'
import { readCache, writeCache } from '../services/cache'

const cacheKey = (orgId) => `ft-zones:${orgId}`

// Module-level so an org's geometry is fetched once per page load even if
// several components ask for it.
const inflight = new Map()

/** The organisation's geofences as GeoJSON, fetched once per page load (the Tankers Report reads MORL's). */
export function loadZones(orgId) {
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

// Mounted hooks per org, so a fence drawn on the map reaches every one of them.
const listeners = new Map()

/** Fetch an org's geofences again (after one is drawn, changed or removed). */
export function reloadEstateZones(orgId) {
  inflight.delete(orgId)
  return loadZones(orgId).then((fc) => {
    for (const fn of listeners.get(orgId) ?? []) fn(fc)
    return fc
  })
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

    const onReload = (fc) => { if (!cancelled) setZones(fc) }
    if (!listeners.has(orgId)) listeners.set(orgId, new Set())
    listeners.get(orgId).add(onReload)

    return () => { cancelled = true; listeners.get(orgId)?.delete(onReload) }
  }, [orgId])

  return { zones, loading, error }
}
