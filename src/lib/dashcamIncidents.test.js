import { describe, it, expect } from 'vitest'
import { initialsOf, needsAttention, sinceFor, CATEGORIES } from './dashcamIncidents'

describe('dashcam inbox helpers', () => {
  it('row badges', () => {
    expect(initialsOf('Harsh braking')).toBe('HB')
    expect(initialsOf('Impact')).toBe('IM')
    expect(initialsOf('')).toBe('?')
  })

  it('the badge counts what needs a look and is not reviewed', () => {
    const list = [{ id: 'a', severity: 'critical' }, { id: 'b', severity: 'informational' }, { id: 'c', severity: 'warning' }]
    expect(needsAttention(list, new Set(['c'])).map((i) => i.id)).toEqual(['a'])
  })

  it('windows are rounded, so the same window is the same request', () => {
    const now = new Date(2026, 9, 23, 18, 7, 33)
    expect(sinceFor('today', now)).toBe(new Date(2026, 9, 23).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    expect(sinceFor('7d', now)).toBe(new Date(2026, 9, 17).toISOString().replace(/\.\d{3}Z$/, 'Z'))
    expect(new Date(sinceFor('24h', now)).getMinutes() % 5).toBe(0)
  })

  it('the six chips', () => {
    expect(CATEGORIES.map((c) => c.key)).toEqual(['braking', 'speeding', 'driver', 'collision', 'geofence', 'other'])
  })
})
