/**
 * The fuel-alerts toggle, at the one place it changes what the map says.
 *
 * `markerState` decides a marker's treatment, and the toggle suppresses exactly
 * one branch of it. The risk is not that the red goes away — it is what takes
 * its place: a flagged unit that is also offline must still read as offline,
 * and the lazy version of this change (return 'ok') would have swapped one
 * wrong story for another and told an operator a dead tracker was driving.
 */

import { describe, it, expect } from 'vitest'
import { markerState } from './vehicleMap.js'

const now = Date.now()

/**
 * A vehicle as the map sees it — driving, connected, unremarkable.
 *
 * `engine: 'on'` and a real `speed` are both required for vehicleActivity to
 * call this transit; an earlier version of this fixture set `movement: 'moving'`
 * (a string, where the code reads `movement.state`) and left the engine out,
 * so the "unmuted" case came back 'stationary' and looked like a bug in the
 * toggle rather than in the fixture.
 */
const unit = (over = {}) => ({
  status: 'ok',
  online: true,
  capturedAt: new Date(now - 30_000).toISOString(),
  speed: 20,
  engine: 'on',
  movement: { state: 'moving' },
  ...over,
})

describe('fuel alerts on, the default', () => {
  it('paints a flagged unit as theft', () => {
    expect(markerState(unit({ status: 'theft' }))).toBe('theft')
    expect(markerState(unit({ status: 'theft' }), {})).toBe('theft')
    expect(markerState(unit({ status: 'theft' }), { fuelAlerts: true })).toBe('theft')
  })

  it('is the default when no options are passed at all', () => {
    // Every existing call site passes one argument. None of them may change
    // behaviour because a second one was added.
    expect(markerState(unit({ status: 'theft' }))).toBe('theft')
  })
})

describe('fuel alerts off', () => {
  const off = { fuelAlerts: false }

  it('paints a flagged unit by what it is DOING', () => {
    expect(markerState(unit({ status: 'theft' }), off)).toBe('ok')
  })

  it('still reads a flagged unit that is OFFLINE as offline', () => {
    // The whole point. Suppressing the alert must not promote a dead tracker
    // to a moving one.
    const dead = unit({ status: 'theft', online: false, capturedAt: new Date(now - 6 * 3600_000).toISOString() })
    expect(markerState(dead, off)).toBe('parked')
    expect(markerState(dead, off)).not.toBe('ok')
  })

  it('still reads a flagged unit that is stopped as stopped', () => {
    // 'stationary', not 'parked': this unit is ONLINE and standing still, and
    // markerState keeps those apart on purpose — 'parked' means the tracker is
    // off the network. Muting the alert must not blur that distinction either.
    const idle = unit({ status: 'theft', speed: 0, engine: 'off', movement: { state: 'resting' } })
    expect(markerState(idle, off)).toBe('stationary')
    expect(markerState(unit({ speed: 0, engine: 'off', movement: { state: 'resting' } }))).toBe('stationary')
  })

  it('still reads a flagged unit that is idling as idling', () => {
    // The state a siphon most often happens in, so it is the one most likely to
    // be looked at with the alert muted.
    const idling = unit({ status: 'theft', speed: 0, engine: 'on', movement: { state: 'idling' } })
    expect(markerState(idling, off)).toBe('idling')
  })

  it('leaves SPEEDING alone, a different alert, not this toggle\'s business', () => {
    expect(markerState(unit({ status: 'speeding' }), off)).toBe('speeding')
  })

  it('changes nothing for a unit that was never flagged', () => {
    for (const v of [unit(), unit({ online: false }), unit({ speed: 0, movement: 'stopped' })]) {
      expect(markerState(v, off)).toBe(markerState(v))
    }
  })
})
