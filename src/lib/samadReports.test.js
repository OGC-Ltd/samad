import { describe, it, expect } from 'vitest'
import { dayStart, shiftRange, currentShift, presetRange, span, periodWords } from './samadReports'

const H = 3_600_000
const NOW = Date.parse('2026-11-03T14:05:00+03:00')

describe('time', () => {
  it('reads days and shifts in Nairobi', () => {
    expect(dayStart(NOW)).toBe(Date.parse('2026-11-03T00:00:00+03:00'))
    expect(shiftRange('2026-11-03', 'night')).toEqual({ from: Date.parse('2026-11-03T18:00:00+03:00'), to: Date.parse('2026-11-04T06:00:00+03:00') })
    expect(currentShift(NOW)).toEqual({ day: '2026-11-03', shift: 'day' })
    expect(currentShift(Date.parse('2026-11-04T03:00:00+03:00'))).toEqual({ day: '2026-11-03', shift: 'night' })
    expect(presetRange('yesterday', NOW).from).toBe(Date.parse('2026-11-02T00:00:00+03:00'))
  })
  it('writes spans and periods', () => {
    expect(span(12 * 60_000)).toBe('12 min')
    expect(span(2 * H + 5 * 60_000)).toBe('2 h 05 min')
    expect(span(75 * H)).toBe('3 d 3 h')
    expect(periodWords(dayStart(NOW), dayStart(NOW) + 24 * H)).toBe('3 Nov 2026')
  })
})
