/**
 * What "in transit" counts — the rule behind every badge that claims a number
 * of moving units.
 *
 * The sidebar's Movement badge used to show `inTransitOnly ? 1 : 0`, the number
 * of filters switched on rather than the number of vehicles, sitting in the
 * same slot where Units and Stopped in transit both count vehicles. These tests
 * pin the predicate the badge now uses, and in particular the two ways of
 * getting this wrong that the codebase has already been bitten by.
 */

import { describe, it, expect } from 'vitest'
import { isInTransit, vehicleActivity } from './vehicleMap.js'

const now = Date.now()

/** A unit as the live stream shapes it: driving, connected, unremarkable. */
const unit = (over = {}) => ({
  id: 'KDL 182X',
  online: true,
  status: 'ok',
  engine: 'on',
  speed: 42,
  movement: { state: 'moving' },
  capturedAt: new Date(now - 30_000).toISOString(),
  ...over,
})

const count = (list) => list.filter(isInTransit).length

describe('isInTransit', () => {
  it('counts a connected unit moving under power', () => {
    expect(isInTransit(unit())).toBe(true)
  })

  it('does NOT count an idling unit', () => {
    // The mistake worth guarding: `status !== 'parked'` reads as ONLINE, so a
    // yard of units standing with their engines running counted as driving.
    const idling = unit({ speed: 0, movement: { state: 'idling' } })
    expect(idling.status).not.toBe('parked')     // the old rule would count it
    expect(vehicleActivity(idling)).toBe('idling')
    expect(isInTransit(idling)).toBe(false)
  })

  it('does NOT count a unit stopped with the engine off', () => {
    expect(isInTransit(unit({ speed: 0, engine: 'off', movement: { state: 'resting' } }))).toBe(false)
  })

  it('does NOT count an OFFLINE unit, whatever its last frame said', () => {
    // Measured live when this gate was added: 14 vehicles on the topbar button
    // against 4 on the map, the 10 extra all offline — one of them still
    // reporting 49 km/h from a frame nobody believes any more.
    const dead = unit({ online: false, speed: 49 })
    expect(vehicleActivity(dead)).toBe('transit')   // the frame still says moving
    expect(isInTransit(dead)).toBe(false)           // and it still does not count
  })

  it('does not count engine-on-but-stopped as movement, at the threshold', () => {
    expect(isInTransit(unit({ speed: 0 }))).toBe(false)
    expect(isInTransit(unit({ speed: 1 }))).toBe(true)
  })

  it('survives a missing engine or speed rather than throwing', () => {
    for (const v of [unit({ engine: undefined }), unit({ speed: undefined }), {}, null]) {
      expect(() => isInTransit(v)).not.toThrow()
    }
    expect(isInTransit(null)).toBe(false)
  })
})

describe('the Movement badge count', () => {
  it('is a number of VEHICLES, not a number of filters', () => {
    const fleet = [
      unit({ id: 'A' }),
      unit({ id: 'B' }),
      unit({ id: 'C', speed: 0, movement: { state: 'idling' } }),
      unit({ id: 'D', online: false }),
      unit({ id: 'E', engine: 'off', speed: 0, movement: { state: 'resting' } }),
    ]
    // Two are moving. The badge showed 1 — "one filter is on" — for any fleet
    // at all, which is the bug.
    expect(count(fleet)).toBe(2)
    expect(count(fleet)).not.toBe(1)
  })

  it('is 0 for a fleet where nothing is moving, not for a fleet with no filter', () => {
    const parked = [unit({ engine: 'off', speed: 0, movement: { state: 'resting' } })]
    expect(count(parked)).toBe(0)
  })

  it('agrees with the map filter it switches on', () => {
    // matchesMapFilters' inTransitOnly branch calls the same predicate, so the
    // badge and the map it filters cannot disagree about who is moving.
    const fleet = [unit({ id: 'A' }), unit({ id: 'B', speed: 0, movement: { state: 'idling' } })]
    expect(count(fleet)).toBe(fleet.filter(isInTransit).length)
  })
})
