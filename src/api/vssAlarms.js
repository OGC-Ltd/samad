// Dashcam alarms from Control Tech's VSS platform, for the Alarms tab of every
// organisation whose vehicles carry VSS cameras.
//
// THE CONTRACT (served by the backend; see docs/dashcam-alarms.md):
//
//   GET {VSS_BASE}/cameras?org=<orgId>
//       → { data: { cameras: <number> } }
//         How many of the organisation's vehicles have a VSS camera. 0 (or any
//         failure) hides the tab.
//
//   GET {VSS_BASE}/alarms?org=<orgId>&since=<ISO time>
//       → { data: { incidents: [ { id, code, label, severity, category,
//                                  occurredAt, vehicleId, plate, lat, lng, speed,
//                                  videos: [{ key, label, url, download }],
//                                  photos: [{ key, label, url, download }] } ] } }
//         Alarms that came with evidence, newest first. `severity` is
//         critical | warning | informational; `category` one of the chips in
//         lib/dashcamIncidents. `url`/`download` are the backend's OWN file
//         route (below) — never a VSS link, which carries a VSS token.
//
//   GET {VSS_BASE}/file?org=<orgId>&k=<key>[&download=1]
//       → the clip or snapshot bytes, honouring Range (so a video can seek).
//
// The backend asks the VSS server with ITS account, and decides who may see
// which organisation exactly as for every other organisation route.

import { apiFetch, refreshOnce } from '../services/api'
import { CATEGORY_KEYS, initialsOf, sinceFor, INCIDENTS_REFRESH_MS } from '../lib/dashcamIncidents'

/** Where the backend serves the routes above. One line to change if it moves. */
export const VSS_BASE = '/api/v1/vss'

const SEVERITIES = new Set(['critical', 'warning', 'informational'])

/** Only the backend's own file route is ever handed to a <video> or <img>. */
const media = (list) => (Array.isArray(list) ? list : [])
  .filter((m) => m && typeof m.url === 'string' && m.url.startsWith(`${VSS_BASE}/file?`))
  .map((m, i) => ({ key: String(m.key ?? i), label: String(m.label || 'Camera'), url: m.url, download: m.download ?? null }))

/** One alarm from the backend → one inbox row. */
export function toVssIncident(a) {
  const occurredMs = a?.occurredAt ? Date.parse(a.occurredAt) : NaN
  const videos = media(a?.videos)
  const photos = media(a?.photos)
  const label = String(a?.label || `Alarm ${a?.code ?? ''}`).trim()
  return {
    id:         String(a?.id ?? `${a?.deviceId}-${a?.occurredAt}-${a?.code}`),
    code:       Number(a?.code ?? 0),
    label,
    initials:   initialsOf(label),
    category:   CATEGORY_KEYS.has(a?.category) ? a.category : 'other',
    severity:   SEVERITIES.has(a?.severity) ? a.severity : 'warning',
    occurredMs: Number.isFinite(occurredMs) ? occurredMs : null,
    vehicleId:  a?.vehicleId ?? null,
    plate:      String(a?.plate ?? ''),
    lat:        Number.isFinite(a?.lat) ? a.lat : null,
    lng:        Number.isFinite(a?.lng) ? a.lng : null,
    speed:      Number.isFinite(a?.speed) ? Math.round(a.speed) : null,
    videos,
    photos,
    hasClip:    videos.length > 0,
    hasPhoto:   photos.length > 0,
  }
}

/** The organisation's alarms since `sinceIso`, newest first. */
export async function fetchVssIncidents({ orgId, sinceIso, signal } = {}) {
  const res = await apiFetch(`${VSS_BASE}/alarms?org=${encodeURIComponent(orgId)}&since=${encodeURIComponent(sinceIso)}`,
    signal ? { signal } : undefined)
  const rows = Array.isArray(res?.data?.incidents) ? res.data.incidents : []
  return rows.map(toVssIncident).sort((a, b) => (b.occurredMs ?? 0) - (a.occurredMs ?? 0))
}

/** The query for one organisation's alarms over one window (the screen and the badge share it). */
export function vssIncidentsQuery(orgId, rangeKey) {
  const sinceIso = sinceFor(rangeKey)
  return {
    queryKey: ['vss', 'incidents', orgId, sinceIso],
    queryFn: ({ signal }) => fetchVssIncidents({ orgId, sinceIso, signal }),
    enabled: Boolean(orgId),
    refetchInterval: INCIDENTS_REFRESH_MS,
    staleTime: INCIDENTS_REFRESH_MS / 2,
  }
}

/**
 * How many of the organisation's vehicles have a VSS camera — 0 hides the
 * Alarms tab. Never throws: anything but a clear count (including a backend
 * that does not serve the route yet) is 0, so the tab simply stays hidden.
 */
export async function fetchVssCameraCount(orgId) {
  if (!orgId) return 0
  try {
    const res = await apiFetch(`${VSS_BASE}/cameras?org=${encodeURIComponent(orgId)}`)
    const n = Number(res?.data?.cameras)
    return Number.isFinite(n) ? n : 0
  } catch {
    return 0
  }
}

/**
 * Make sure the login COOKIE is fresh before a <video> or <img> asks for a
 * file: those requests carry the cookie but not the Bearer token.
 */
let checkedAt = 0
export async function ensureVssSession(orgId) {
  if (Date.now() - checkedAt < 60_000) return
  try {
    const res = await fetch(`${VSS_BASE}/cameras?org=${encodeURIComponent(orgId ?? '')}`,
      { credentials: 'include', headers: { Accept: 'application/json' } })
    if (res.status === 401) await refreshOnce()
    checkedAt = Date.now()
  } catch { /* the player reports whatever then goes wrong */ }
}
