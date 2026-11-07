import { describe, it, expect } from 'vitest'
import { dayStart, shiftRange, currentShift, presetRange, span, periodWords } from './samadReports'

const H = 3_600_000
const NOW = Date.parse('2026-11-03T14:05:00+03:00')

describe('time', () => {
  it('reads days and shifts in Nairobi', () => {
    expect(dayStart(NOW)).toBe(Date.parse('2026-11-03T00:00:00+03:00'))
    expect(shiftRange('2026-11-03', 'day')).toEqual({ from: Date.parse('2026-11-03T07:30:00+03:00'), to: Date.parse('2026-11-03T19:30:00+03:00') })
    expect(shiftRange('2026-11-03', 'night')).toEqual({ from: Date.parse('2026-11-03T19:30:00+03:00'), to: Date.parse('2026-11-04T07:30:00+03:00') })
    expect(currentShift(NOW)).toEqual({ day: '2026-11-03', shift: 'day' })
    expect(currentShift(Date.parse('2026-11-04T03:00:00+03:00'))).toEqual({ day: '2026-11-03', shift: 'night' })
  })
  it('opens the day shift until 8 PM and the night shift until 8 AM', () => {
    const at = (t) => currentShift(Date.parse(`2026-11-03T${t}:00+03:00`))
    expect(at('19:45')).toEqual({ day: '2026-11-03', shift: 'day' })   // the day shift, just ended
    expect(at('20:00')).toEqual({ day: '2026-11-03', shift: 'night' })
    expect(at('23:59')).toEqual({ day: '2026-11-03', shift: 'night' })
    expect(at('07:45')).toEqual({ day: '2026-11-02', shift: 'night' }) // last night's, just ended
    expect(at('08:00')).toEqual({ day: '2026-11-03', shift: 'day' })
    expect(presetRange('yesterday', NOW).from).toBe(Date.parse('2026-11-02T00:00:00+03:00'))
  })
  it('writes spans and periods', () => {
    expect(span(12 * 60_000)).toBe('12 min')
    expect(span(2 * H + 5 * 60_000)).toBe('2 h 05 min')
    expect(span(75 * H)).toBe('3 d 3 h')
    expect(periodWords(dayStart(NOW), dayStart(NOW) + 24 * H)).toBe('3 Nov 2026')
  })
})
