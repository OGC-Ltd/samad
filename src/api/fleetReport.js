// What the Reports page's three reports are made from.
//
// FULL (server reports.go, once deployed):
//
//   GET /api/v1/reports/fleet?org=<orgId>&from=<epoch ms>&to=<epoch ms>
//     → { data: { from, to, generatedAt, keptSince, zones: [name],
//                 events: [{ id, kind, type, label, source, severity, occurredAt,
//                            vehicleId, plate, lat, lng, speed, hasClip, zone, action }],
//                 vehicles: [{ vehicleId, plate, driver, type, lat, lng, speedKmh,
//                              capturedAt, online, moving, zoneNow, nearestZone,
//                              nearestKm, lastCrossing: { zone, action, at } | null }] } }
//
// LIMITED (operator, 2026-11-03: "lets work with what we can get"): a server
// without that route answers it with an empty list (handlers.go emptyRoute).
// The same shape is then put together from the routes every server has:
//
//   GET /alerts?from&to&kind=all&status=all   overspeeds and the dashcams'
//        warning and critical alarms, 100 a page (the Alerts page's own)
//   GET /organisations/{org}/vehicles/snapshot   every unit and its position
//   GET /organisations/{org}/geofences/geojson   the zones, to say which one a
//        unit is in now, or how far it is from the nearest
//
// What that cannot give, and `limited` says so the reports leave it out:
// camera covered (an informational alarm, never on the Alerts page) and zone
// entries and exits (the server keeps them to itself), so no crossings and no
// "out since".

import { apiFetch } from '../services/api'

/** What the report has, so each report shows only what it can stand behind. */
export const FULL = { cameraCovered: true, crossings: true }
export const LIMITED = { cameraCovered: false, crossings: false }

export async function loadFleetReport({ orgId, from, to, signal }) {
  if (!orgId) throw new Error('No organisation selected')
  const q = `org=${encodeURIComponent(orgId)}&from=${Math.round(from)}&to=${Math.round(to)}`
  const res = await apiFetch(`/api/v1/reports/fleet?${q}`, signal ? { signal } : undefined)
  const d = res?.data
  if (!d || Array.isArray(d) || !Array.isArray(d.vehicles)) {
    return loadFromExistingRoutes({ orgId, from, to, signal })
  }
  return {
    has: FULL,
    from: Date.parse(d.from) || from,
    to: Date.parse(d.to) || to,
    generatedAt: Date.parse(d.generatedAt) || Date.now(),
    keptSince: Date.parse(d.keptSince) || null,
    zones: Array.isArray(d.zones) ? d.zones : [],
    events: (Array.isArray(d.events) ? d.events : []).map((e) => ({ ...e, at: Date.parse(e.occurredAt) }))
      .filter((e) => Number.isFinite(e.at)),
    vehicles: (Array.isArray(d.vehicles) ? d.vehicles : []).map((v) => ({
      ...v,
      fixAt: v.capturedAt ? Date.parse(v.capturedAt) || null : null,
      lastCrossing: v.lastCrossing ? { ...v.lastCrossing, at: Date.parse(v.lastCrossing.at) || null } : null,
    })),
  }
}

// ── the limited report, from the routes every server has ────────────────────

/**
 * The report heading an alarm counts under — the same rules as the server's
 * reportKind (reports.go), read from the partner's type key.
 */
export function kindOfType(type, severity) {
  const t = String(type ?? '').toLowerCase()
  if (t.includes('speeding')) return 'overspeed'
  if (t.includes('harsh_brak')) return 'harsh_braking'
  if (t.includes('harsh_accel')) return 'harsh_acceleration'
  if (t.includes('seatbelt')) return 'no_seatbelt'
  if (t.includes('phone')) return 'phone'
  if (t.includes('occlusion') || t.includes('cover')) return 'camera_covered'
  return severity === 'critical' ? 'critical' : null
}

/** One Alerts-page row → one report event, or null for one no report counts. */
export function eventOfAlert(a) {
  const at = Date.parse(a?.at)
  if (!Number.isFinite(at)) return null
  const base = { id: String(a.id), vehicleId: String(a.vehicleId ?? ''), plate: a.plate ?? '', at, zone: null, action: null }
  if (a.kind === 'speeding') {
    const s = a.speeding ?? {}
    return { ...base, kind: 'overspeed', type: 'over_speeding', label: 'Overspeeding', severity: 'warning',
      speed: Number.isFinite(s.peakKmh) ? s.peakKmh : null, lat: s.lat ?? null, lng: s.lng ?? null, hasClip: false }
  }
  if (a.kind === 'camera') {
    const c = a.camera ?? {}
    const kind = kindOfType(c.type, c.severity)
    if (!kind) return null
    return { ...base, kind, type: c.type, label: c.label || String(c.type ?? '').replace(/_/g, ' '), severity: c.severity,
      speed: Number.isFinite(c.speedKmh) ? c.speedKmh : null, lat: c.lat ?? null, lng: c.lng ?? null,
      hasClip: Boolean(c.clips?.roadFacing || c.clips?.driverFacing) }
  }
  return null
}

/** Every Alerts-page row in the period, page by page (100 a page). */
async function allAlerts({ from, to, signal }) {
  const out = []
  let cursor = null
  for (let pages = 0; pages < 200; pages++) {
    const q = new URLSearchParams({
      from: new Date(from).toISOString(), to: new Date(to).toISOString(),
      kind: 'all', status: 'all', limit: '100', ...(cursor ? { cursor } : {}),
    })
    const res = await apiFetch(`/api/v1/alerts?${q}`, signal ? { signal } : undefined)
    const body = res?.data ?? {}
    out.push(...(Array.isArray(body.data) ? body.data : []))
    if (!body.hasNextPage || !body.cursor) break
    cursor = body.cursor
  }
  return out
}

// ── zones, from the map's GeoJSON ───────────────────────────────────────────

const rad = (d) => (d * Math.PI) / 180
export function km(lat1, lng1, lat2, lng2) {
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2
  return 2 * 6371 * Math.asin(Math.sqrt(h))
}

/** The GeoJSON's features → { name, contains(lat, lng), centre: [lat, lng] }. */
export function zonesOf(geojson) {
  const out = []
  for (const f of geojson?.features ?? []) {
    const name = f?.properties?.name
    const g = f?.geometry
    if (!name || !g) continue
    if (g.type === 'Point' && Number.isFinite(f.properties.radiusM)) {
      const [lng, lat] = g.coordinates
      const r = f.properties.radiusM / 1000
      out.push({ name, centre: [lat, lng], contains: (la, ln) => km(la, ln, lat, lng) <= r })
    } else if (g.type === 'Polygon' && Array.isArray(g.coordinates?.[0]) && g.coordinates[0].length >= 3) {
      const ring = g.coordinates[0]
      const centre = [ring.reduce((s, p) => s + p[1], 0) / ring.length, ring.reduce((s, p) => s + p[0], 0) / ring.length]
      out.push({
        name, centre,
        contains: (la, ln) => {
          let inside = false
          for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
            const [xi, yi] = ring[i]; const [xj, yj] = ring[j]
            if ((yi > la) !== (yj > la) && ln < ((xj - xi) * (la - yi)) / (yj - yi) + xi) inside = !inside
          }
          return inside
        },
      })
    }
  }
  return out
}

/** The zone a point is in, or the nearest one and how far (km, one decimal). */
export function whereNow(zones, lat, lng) {
  if (lat == null || lng == null) return { zoneNow: null, nearestZone: null, nearestKm: null }
  const inside = zones.find((z) => z.contains(lat, lng))
  if (inside) return { zoneNow: inside.name, nearestZone: null, nearestKm: null }
  let best = null
  for (const z of zones) {
    const d = km(lat, lng, z.centre[0], z.centre[1])
    if (!best || d < best.d) best = { name: z.name, d }
  }
  return best ? { zoneNow: null, nearestZone: best.name, nearestKm: Math.round(best.d * 10) / 10 } : { zoneNow: null, nearestZone: null, nearestKm: null }
}

/** One snapshot row → one report unit. */
export function unitOfSnapshot(r, zones) {
  const lat = Number.isFinite(r?.lat) ? r.lat : null
  const lng = Number.isFinite(r?.lng) ? r.lng : null
  return {
    vehicleId: String(r.vehicleId), plate: r.plate, driver: r.driver ?? 'Unassigned', type: r.vehicleType ?? null,
    lat, lng, speedKmh: r.speedKmh ?? null, fixAt: r.capturedAt ? Date.parse(r.capturedAt) || null : null,
    online: Boolean(r.connectionOnline), moving: Boolean(r.movement?.moving),
    ...(lat != null && (lat !== 0 || lng !== 0) ? whereNow(zones, lat, lng) : { zoneNow: null, nearestZone: null, nearestKm: null }),
    lastCrossing: null,
  }
}

async function loadFromExistingRoutes({ orgId, from, to, signal }) {
  const opts = signal ? { signal } : undefined
  const org = encodeURIComponent(orgId)
  const [alerts, snap, geo] = await Promise.all([
    allAlerts({ from, to, signal }),
    apiFetch(`/api/v1/organisations/${org}/vehicles/snapshot`, opts),
    apiFetch(`/api/v1/organisations/${org}/geofences/geojson`, opts).catch(() => null),
  ])
  const zones = zonesOf(geo?.data)
  const seen = new Set()
  const events = []
  for (const a of alerts) {
    const e = eventOfAlert(a)
    if (!e || seen.has(e.id) || e.at < from || e.at >= to) continue
    seen.add(e.id)
    events.push(e)
  }
  events.sort((a, b) => a.at - b.at)
  return {
    has: LIMITED,
    from, to, generatedAt: Date.now(), keptSince: null,
    zones: zones.map((z) => z.name),
    events,
    vehicles: (Array.isArray(snap?.data) ? snap.data : []).map((r) => unitOfSnapshot(r, zones)),
  }
}

// ── distance each unit covered in a period (operator, 2026-11-03) ────────

/** Faster than this between two fixes is a GPS jump, not driving: not counted. */
export const MAX_KMH = 160

/** km along a unit's points ({ t, lat, lng }, oldest first), jumps left out. */
export function distanceKm(points) {
  let total = 0
  for (let i = 1; i < (points?.length ?? 0); i++) {
    const a = points[i - 1], b = points[i]
    if (![a.lat, a.lng, b.lat, b.lng].every(Number.isFinite)) continue
    if ((a.lat === 0 && a.lng === 0) || (b.lat === 0 && b.lng === 0)) continue
    const d = km(a.lat, a.lng, b.lat, b.lng)
    const hours = (b.t - a.t) / 3_600_000
    if (hours > 0 && d / hours > MAX_KMH) continue
    total += d
  }
  return Math.round(total * 10) / 10
}

/**
 * Each unit's distance between `from` and `to`, from its trip history (the
 * route Route Playback reads), three units at a time.
 * @returns {Promise<Map<string, number|null>>} vehicleId → km; null where the history could not be read
 */
export async function distancesIn({ orgId, vehicles, from, to, signal }) {
  const org = encodeURIComponent(orgId)
  const q = `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}`
  const out = new Map()
  const one = async (v) => {
    try {
      const res = await apiFetch(`/api/v1/organisations/${org}/vehicles/${encodeURIComponent(v.vehicleId)}/track?${q}`,
        signal ? { signal } : undefined)
      out.set(String(v.vehicleId), distanceKm(Array.isArray(res?.data?.points) ? res.data.points : []))
    } catch (e) {
      if (signal?.aborted) throw e
      out.set(String(v.vehicleId), null)
    }
  }
  const list = vehicles ?? []
  for (let i = 0; i < list.length; i += 3) await Promise.all(list.slice(i, i + 3).map(one))
  return out
}
