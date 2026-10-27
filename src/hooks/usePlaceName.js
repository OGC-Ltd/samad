// Human place label for a coordinate — reverse-geocoded through the backend
// (/api/v1/reverse-geocode, OSM Nominatim behind a per-grid-cell disk cache).
// Client-side it caches per ~1.1 km grid cell in module memory + localStorage,
// so a moving vehicle refetches only when it crosses into a new cell and
// revisited cells (fixed routes!) cost nothing. Returns null until resolved —
// callers show the raw coordinates as the fallback.

import { useState, useEffect } from 'react'
import { apiFetch } from '../services/api'

// -v2 discards labels cached under the previous single-word format; keep in
// step with the server's key prefix in lib/geocode.ts.
const LS_KEY = 'ft-geocode-v2'
const LS_MAX = 600           // cap the localStorage cache; reset when exceeded

const mem = new Map()
let ls = null
function lsCache() {
  if (!ls) {
    try { ls = JSON.parse(localStorage.getItem(LS_KEY)) ?? {} } catch { ls = {} }
    if (Object.keys(ls).length > LS_MAX) ls = {}
  }
  return ls
}
function lsSave() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(ls)) } catch { /* quota */ }
}

const keyOf = (lat, lng) => `${lat.toFixed(2)},${lng.toFixed(2)}`

// A list of a few hundred units asks for a few hundred cells at once, and the
// server answers external lookups one a second. Without these two, every row
// fired its own request — the same cell asked for twice was two requests, and
// the queue of open requests starved the app's other calls. Now one request
// per cell is ever in flight, and at most MAX_ACTIVE run at a time.
const MAX_ACTIVE = 3
const inflight = new Map()   // key -> Promise<string|null>
const waiting = []           // thunks not yet started
let active = 0

function pump() {
  while (active < MAX_ACTIVE && waiting.length) {
    active++
    waiting.shift()().finally(() => { active--; pump() })
  }
}

function lookup(key, lat, lng) {
  if (inflight.has(key)) return inflight.get(key)
  const p = new Promise((resolve) => {
    waiting.push(() => apiFetch(`/api/v1/reverse-geocode?lat=${lat}&lng=${lng}`)
      .then((res) => {
        const place = res.data?.place ?? null
        if (place) {
          mem.set(key, place)
          lsCache()[key] = place
          lsSave()
        }
        resolve(place)
      })
      .catch(() => resolve(null))           // transient — coords fallback stays
      .finally(() => inflight.delete(key)))
    pump()
  })
  inflight.set(key, p)
  return p
}

/**
 * `enabled: false` reads the cache but never asks the network — for rows not
 * yet on screen (see UnitsMenu's location cell).
 */
export function usePlaceName(lat, lng, { enabled = true } = {}) {
  const key = lat != null && lng != null ? keyOf(lat, lng) : null
  const [place, setPlace] = useState(() =>
    key ? mem.get(key) ?? lsCache()[key] ?? null : null)

  useEffect(() => {
    if (!key) { setPlace(null); return }
    const cached = mem.get(key) ?? lsCache()[key]
    if (cached !== undefined && cached !== null) { setPlace(cached); return }
    if (!enabled) return
    let alive = true
    lookup(key, lat, lng).then((p) => { if (alive && p) setPlace(p) })
    return () => { alive = false }
    // lat/lng intentionally keyed by grid cell, not raw floats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled])

  return place
}
