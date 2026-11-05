import { describe, it, expect } from 'vitest'
import {
  breachesReport, movementsReport, shiftReport, breachesHtml, movementsHtml, shiftHtml,
  shiftRange, currentShift, presetRange, dayStart, span, outSince, reportNumber, BREACHES,
} from './samadReports'

const H = 3_600_000
const NOW = Date.parse('2026-11-03T14:05:00+03:00')
const ev = (id, kind, vehicleId, at, extra = {}) => ({ id, kind, vehicleId, at, plate: `P${vehicleId}`, label: kind, speed: null, hasClip: false, ...extra })
const veh = (id, extra = {}) => ({
  vehicleId: id, plate: `KD${id}`, driver: 'Unassigned', type: 'TRUCK', lat: -1, lng: 37, online: true, moving: false,
  zoneNow: null, nearestZone: 'Mombasa Yard', nearestKm: 12.4, lastCrossing: null, fixAt: NOW - 60_000, ...extra,
})

const data = {
  from: NOW - 8 * H, to: NOW, generatedAt: NOW, zones: ['Mombasa Yard', 'Nairobi Depot'],
  vehicles: [
    veh('1', { driver: 'Ali Musa', moving: true, lastCrossing: { zone: 'Mombasa Yard', action: 'exit', at: NOW - 30 * H } }),
    veh('2', { zoneNow: 'Nairobi Depot', lastCrossing: { zone: 'Nairobi Depot', action: 'entry', at: NOW - 2 * H } }),
    veh('3', { type: 'TRAILER', online: false }),
  ],
  events: [
    ev('a', 'overspeed', '1', NOW - 5 * H, { speed: 92.4 }),
    ev('b', 'overspeed', '1', NOW - 4 * H, { speed: 88 }),
    ev('c', 'no_seatbelt', '1', NOW - 3 * H, { hasClip: true }),
    ev('d', 'phone', '3', NOW - 2 * H),
    ev('e', 'critical', '3', NOW - 1 * H, { label: 'Forward collision', hasClip: true }),
    ev('f', 'geofence', '2', NOW - 2 * H, { zone: 'Nairobi Depot', action: 'entry' }),
  ],
}

describe('policy breaches', () => {
  const m = breachesReport(data)
  it('counts each breach per unit, worst first', () => {
    expect(m.total).toBe(4)
    expect(m.rows.map((r) => r.plate)).toEqual(['KD1', 'KD3'])
    expect(m.rows[0].counts).toMatchObject({ overspeed: 2, no_seatbelt: 1 })
    expect(m.rows[0].topSpeed).toBe(92)
    expect(m.rows[0].driver).toBe('Ali Musa')
    expect(m.rows[1].driver).toBeNull()
  })
  it('groups by vehicle type when there is more than one', () => {
    expect(m.sections.map((s) => s.name).sort()).toEqual(['Trailer', 'Truck'])
  })
  it('leaves critical alarms and crossings out', () => {
    expect(m.rows.flatMap((r) => Object.keys(r.counts))).toEqual(expect.arrayContaining(BREACHES.map((b) => b.key)))
    expect(m.kpis.find((k) => k.label === 'Total breaches').value).toBe(4)
  })
  it('draws the letterhead with Samad on the left', () => {
    const { html, filename } = breachesHtml(data, m, { logos: { left: 'samad.png', ogc: 'ogc.png', leftAlt: 'Samad Resources' }, now: NOW })
    expect(html).toContain('src="samad.png" alt="Samad Resources"')
    expect(html).toContain('POLICY BREACHES REPORT')
    expect(html).toContain('PB-SAMAD-20261103-1405')
    expect(filename).toBe('Policy Breaches Report Samad Resources 2026-11-03.pdf')
  })
})

describe('movements', () => {
  const distances = new Map([['1', 42.5], ['2', 120.25]])
  const places = new Map([['1', 'A109, Voi'], ['2', 'Nairobi Depot']])
  const m = movementsReport(data, { distances, places })
  it('lists every unit by distance in the period, furthest first, with a place name', () => {
    expect(m.rows.map((r) => [r.plate, r.km, r.place])).toEqual([
      ['KD2', 120.25, 'Nairobi Depot'], ['KD1', 42.5, 'A109, Voi'], ['KD3', null, '-1.0000, 37.0000'],
    ])
    expect(m.kpis.map((k) => k.label)).toEqual(['Units', 'Moving now'])
  })
  it('makes a page: Distance and Current location, no status, last fix or crossings', () => {
    const { html } = movementsHtml(data, m, { logos: { left: 'l', ogc: 'o' }, now: NOW })
    expect(html).toContain('MOVEMENTS REPORT')
    expect(html).toContain('Current location')
    expect(html).toContain('120.3 km')
    expect(html).toContain('A109, Voi')
    for (const gone of ['Zones</th>', 'Status', 'Last fix', 'Zone crossings', 'Out since', 'km from', 'In a zone now', 'Out of zones now', 'Exits', 'Entries']) {
      expect(html).not.toContain(gone)
    }
  })
})

describe('end of shift', () => {
  const m = shiftReport(data, NOW)
  it('lists critical alarms and every unit per breach', () => {
    expect(m.critical.map((e) => e.label)).toEqual(['Forward collision'])
    expect(m.breaches.find((b) => b.key === 'overspeed').units).toEqual([{ plate: 'KD1', n: 2 }])
    expect(m.kpis.map((k) => k.label)).not.toContain('Out of geofence now')
  })
  it('counts units online now and lists every unit, furthest first', () => {
    expect(m.reporting).toBe(2)
    expect(m.kpis.find((k) => k.label === 'Units reporting').value).toBe('2 of 3')
    const d = shiftReport(data, NOW, { distances: new Map([['1', 120.4], ['2', 300], ['3', null]]) })
    expect(d.units.map((u) => [u.plate, u.km])).toEqual([['KD2', 300], ['KD1', 120.4], ['KD3', null]])
  })
  it('makes a page: Shift Overview, breaches by unit, the units, nothing else at the foot', () => {
    const model = shiftReport(data, NOW, { distances: new Map([['1', 120.4], ['2', 300]]) })
    const { html } = shiftHtml(data, model, { logos: { left: 'l', ogc: 'o' }, now: NOW, shiftWords: 'Day, 06:00 to 18:00' })
    expect(html).toContain('END OF SHIFT REPORT')
    expect(html).toContain('Shift Overview')
    expect(html).toContain('3 (2 reporting)')
    expect(html).toContain('Distance in shift')
    expect(html).toContain('300.0 km')
    expect(html).toContain('Not available')
    for (const gone of ['Outgoing operator', 'Operator</th>', 'Handed to', 'Handover', 'Out of geofence', 'fuel readings', 'operations@offgridconsultingltd.com', 'Shift at a glance']) {
      expect(html).not.toContain(gone)
    }
  })
})

describe('time', () => {
  it('reads days and shifts in Nairobi', () => {
    expect(dayStart(NOW)).toBe(Date.parse('2026-11-03T00:00:00+03:00'))
    expect(shiftRange('2026-11-03', 'night')).toEqual({ from: Date.parse('2026-11-03T18:00:00+03:00'), to: Date.parse('2026-11-04T06:00:00+03:00') })
    expect(currentShift(NOW)).toEqual({ day: '2026-11-03', shift: 'day' })
    expect(currentShift(Date.parse('2026-11-04T03:00:00+03:00'))).toEqual({ day: '2026-11-03', shift: 'night' })
    expect(presetRange('yesterday', NOW).from).toBe(Date.parse('2026-11-02T00:00:00+03:00'))
    expect(reportNumber('ES', NOW)).toBe('ES-SAMAD-20261103-1405')
  })
  it('writes spans', () => {
    expect(span(12 * 60_000)).toBe('12 min')
    expect(span(2 * H + 5 * 60_000)).toBe('2 h 05 min')
    expect(span(75 * H)).toBe('3 d 3 h')
  })
  it('is only out after an exit and while in no zone', () => {
    expect(outSince(veh('9', { lastCrossing: { action: 'entry', at: 1 } }))).toBeNull()
    expect(outSince(veh('9', { zoneNow: 'X', lastCrossing: { action: 'exit', at: 1 } }))).toBeNull()
  })
})
