import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }))
import { apiFetch } from '../services/api'
import { loadFleetReport, kindOfType, eventOfAlert, zonesOf, whereNow } from './fleetReport'
import { breachesReport, movementsReport, shiftReport, breachesHtml, movementsHtml, shiftHtml } from '../lib/samadReports'

const NOW = Date.parse('2026-11-03T18:00:00+03:00')
const FROM = Date.parse('2026-11-03T00:00:00+03:00')

const alert = (id, kind, at, extra) => ({ id, kind, vehicleId: '7', plate: 'KCN530E', at: new Date(at).toISOString(), ...extra })
const geo = { type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { name: 'Mombasa Yard', radiusM: 500 }, geometry: { type: 'Point', coordinates: [39.6, -4.0] } },
  { type: 'Feature', properties: { name: 'Box' }, geometry: { type: 'Polygon', coordinates: [[[37, -1], [37.1, -1], [37.1, -0.9], [37, -0.9], [37, -1]]] } },
] }
const snap = [
  { vehicleId: '7', plate: 'KCN530E', driver: 'Ali Musa', vehicleType: 'TRUCK', lat: -1.5, lng: 37.5, connectionOnline: true, movement: { moving: true }, capturedAt: new Date(NOW).toISOString() },
  { vehicleId: '8', plate: 'KDT953D', driver: 'Unassigned', vehicleType: 'TRUCK', lat: -4.001, lng: 39.6, connectionOnline: true, movement: { moving: false } },
]

describe('reading alarms the way the server would', () => {
  it('files each type under its breach', () => {
    expect(kindOfType('no_seatbelt', 'critical')).toBe('no_seatbelt')
    expect(kindOfType('phone_use', 'critical')).toBe('phone')
    expect(kindOfType('harsh_braking', 'warning')).toBe('harsh_braking')
    expect(kindOfType('forward_collision', 'critical')).toBe('critical')
    expect(kindOfType('lane_departure', 'warning')).toBeNull()
  })
  it('turns Alerts-page rows into events', () => {
    expect(eventOfAlert(alert('s', 'speeding', NOW, { speeding: { peakKmh: 92 } }))).toMatchObject({ kind: 'overspeed', speed: 92 })
    expect(eventOfAlert(alert('c', 'camera', NOW, { camera: { type: 'no_seatbelt', severity: 'critical', clips: { roadFacing: 'x' } } })))
      .toMatchObject({ kind: 'no_seatbelt', hasClip: true })
    expect(eventOfAlert(alert('l', 'camera', NOW, { camera: { type: 'lane_departure', severity: 'warning' } }))).toBeNull()
  })
  it('places units in or near zones', () => {
    const zones = zonesOf(geo)
    expect(whereNow(zones, -4.001, 39.6).zoneNow).toBe('Mombasa Yard')
    expect(whereNow(zones, -0.95, 37.05).zoneNow).toBe('Box')
    expect(whereNow(zones, -1.5, 37.5)).toMatchObject({ zoneNow: null, nearestZone: 'Box' })
  })
})

describe('a server without the report route', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(async (url) => {
      if (url.startsWith('/api/v1/reports/fleet')) return { success: true, data: [] }
      if (url.startsWith('/api/v1/alerts')) {
        const page2 = url.includes('cursor=100')
        return { success: true, data: {
          data: page2
            ? [alert('p', 'camera', NOW - 3600_000, { camera: { type: 'phone_use', severity: 'critical', label: 'Phone Use' } })]
            : [alert('a', 'camera', NOW - 7200_000, { camera: { type: 'no_seatbelt', severity: 'critical', label: 'NO SEATBELT' } }),
               alert('b', 'speeding', NOW - 5000_000, { speeding: { peakKmh: 88 } }),
               alert('old', 'speeding', FROM - 3600_000, { speeding: { peakKmh: 99 } })],
          hasNextPage: !page2, cursor: page2 ? null : '100' } }
      }
      if (url.includes('/vehicles/snapshot')) return { success: true, data: snap }
      if (url.includes('/geofences/geojson')) return { success: true, data: geo }
      throw new Error(`unexpected ${url}`)
    })
  })

  it('builds the reports from the alerts, the snapshot and the zones', async () => {
    const data = await loadFleetReport({ orgId: 'samad', from: FROM, to: NOW })
    expect(data.has).toEqual({ cameraCovered: false, crossings: false })
    expect(data.events.map((e) => e.id)).toEqual(['a', 'b', 'p'])
    expect(data.vehicles.find((v) => v.plate === 'KDT953D').zoneNow).toBe('Mombasa Yard')

    const b = breachesReport(data)
    expect(b.total).toBe(3)
    expect(b.list.map((x) => x.key)).not.toContain('camera_covered')
    const bh = breachesHtml(data, b, { logos: { left: 'l', ogc: 'o' }, now: NOW }).html
    expect(bh).not.toContain('Camera<br>covered')
    expect(bh).not.toContain('until the server is updated')

    const m = movementsReport(data)
    expect(m.limited).toBe(true)
    expect(movementsHtml(data, m, { logos: { left: 'l', ogc: 'o' }, now: NOW }).html).not.toContain('Zone crossings')

    const s = shiftReport(data, NOW)
    expect(s.breaches.find((b) => b.key === 'no_seatbelt').units).toEqual([{ plate: 'KCN530E', n: 1 }])
    const sh = shiftHtml(data, s, { logos: { left: 'l', ogc: 'o' }, now: NOW, shiftWords: 'Day' }).html
    expect(sh).not.toContain('Out of geofence')
  })
})

describe('distance in a shift', () => {
  it('adds up the trip, leaving GPS jumps out', async () => {
    const { distanceKm } = await import('./fleetReport')
    const t0 = 0, min = 60_000
    // ~11.1 km north in 10 min (67 km/h), then a 500 km jump in 1 min, then back on the line
    expect(distanceKm([{ t: t0, lat: 0, lng: 37 }, { t: t0 + 10 * min, lat: 0.1, lng: 37 }, { t: t0 + 11 * min, lat: 4.6, lng: 37 }])).toBeCloseTo(11.1, 1)
    expect(distanceKm([])).toBe(0)
  })
  it('asks each unit, and marks the one it could not read', async () => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(async (url) => {
      if (url.includes('/vehicles/9/')) throw new Error('down')
      return { data: { points: url.includes('/vehicles/8/') ? [{ t: 0, lat: 0, lng: 37 }, { t: 600_000, lat: 0.1, lng: 37 }] : [] } }
    })
    const { distancesIn } = await import('./fleetReport')
    const d = await distancesIn({ orgId: 'samad', from: FROM, to: NOW, vehicles: [{ vehicleId: '7' }, { vehicleId: '8' }, { vehicleId: '9' }] })
    expect(d.get('7')).toBe(0)
    expect(d.get('8')).toBeCloseTo(11.1, 1)
    expect(d.get('9')).toBeNull()
  })
})
