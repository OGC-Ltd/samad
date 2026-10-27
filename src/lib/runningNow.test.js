/**
 * The one case where a live frame outranks the provider's connection verdict.
 *
 * `isOnline` is otherwise netconn and nothing else, and the note on it explains
 * at length why a "reported recently" fallback was removed. `isRunningNow` puts
 * a narrower one back: ignition ON, covering ground, in a frame fresh enough
 * that all three are one observation rather than three old ones.
 *
 * The freshness gate is the whole predicate, so it is what these tests are
 * mostly about. Measured against the live Sukari account on 2026-09-21, 20 of
 * 597 units carry engineOn with a non-zero speed while netconn calls them
 * offline — with fixes 20 to 285 DAYS old. Exactly one of them has a fix inside
 * the window. Drop the gate and the map paints the other nineteen green.
 */

import { describe, it, expect } from 'vitest'
import { isRunningNow, isOnline } from './vehicleMap.js'

const now = Date.now()
const minsAgo = (m) => new Date(now - m * 60_000).toISOString()

/** Offline by the provider, but demonstrably working. */
const running = (over = {}) => ({
  connectionOnline: false,
  engineOn: true,
  speedKmh: 34,
  movement: { state: 'moving' },
  capturedAt: minsAgo(3),
  ...over,
})

describe('isRunningNow', () => {
  it('accepts ignition on, moving, and a fresh fix', () => {
    expect(isRunningNow(running())).toBe(true)
  })

  it('accepts movement.state alone when the speed reads zero', () => {
    expect(isRunningNow(running({ speedKmh: 0 }))).toBe(true)
  })

  it('takes capturedAtMs as well as an ISO string', () => {
    expect(isRunningNow(running({ capturedAt: undefined, capturedAtMs: now - 60_000 }))).toBe(true)
  })

  it('refuses a unit with the engine off, however fast the last frame said it was going', () => {
    expect(isRunningNow(running({ engineOn: false }))).toBe(false)
    expect(isRunningNow(running({ engineOn: null }))).toBe(false)
  })

  it('refuses a running engine that is not covering ground', () => {
    expect(isRunningNow(running({ speedKmh: 0, movement: { state: 'resting' } }))).toBe(false)
  })

  /* The 20 units this predicate exists to EXCLUDE. Their frames say engine on
     at 12 km/h; the frames are two months old. */
  it('refuses a frozen frame, whatever it claims', () => {
    expect(isRunningNow(running({ capturedAt: minsAgo(31) }))).toBe(false)
    expect(isRunningNow(running({ capturedAt: minsAgo(84_468) }))).toBe(false)
    expect(isRunningNow(running({ capturedAt: minsAgo(411_122) }))).toBe(false)
  })

  it('refuses a unit with no fix time at all', () => {
    expect(isRunningNow(running({ capturedAt: null }))).toBe(false)
    expect(isRunningNow(running({ capturedAt: 'not a date' }))).toBe(false)
  })

  /* A clock skewed forward would otherwise make every future-stamped frame
     look fresh, which is the same failure in the other direction. */
  it('refuses a frame stamped in the future', () => {
    expect(isRunningNow(running({ capturedAtMs: now + 10 * 60_000 }))).toBe(false)
  })
})

describe('isOnline', () => {
  it('still answers the provider verdict first', () => {
    expect(isOnline({ connectionOnline: true })).toBe(true)
    expect(isOnline({ connectionOnline: false })).toBe(false)
    expect(isOnline({ connectionOnline: null })).toBe(false)
  })

  it('does not treat a missing verdict as online on its own', () => {
    expect(isOnline({ connectionOnline: null, engineOn: false, capturedAt: minsAgo(1) })).toBe(false)
  })

  it('overrules an offline verdict for a unit that is demonstrably working', () => {
    expect(isOnline(running())).toBe(true)
  })

  it('leaves a stale offline unit offline', () => {
    expect(isOnline(running({ capturedAt: minsAgo(60) }))).toBe(false)
  })
})
