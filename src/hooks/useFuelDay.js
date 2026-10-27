import { useEffect, useState } from 'react'
import { apiFetch } from '../services/api'
import { fleetDayOf } from '../lib/fuelDay'
import { cachedVehicleFuelEvents, loadVehicleFuelEvents } from './useVehicleFuelEvents'

/**
 * One unit's fuel for one fleet day: its tank-ledger row, its refuels and its
 * flagged drops. Feeds the day breakdown in the fuel incident window; the
 * arithmetic is lib/fuelDay.
 *
 * The tank ledger is served per ORGANISATION, not per unit, so this reads the
 * whole fleet's row set and keeps one. That is the same request the Sensor
 * Monitor makes, cached server-side (warm for today, stored for past days), so
 * it costs a lookup rather than a recomputation. For a past day it is read as
 * the day stood at its end; today has no end yet, so it is read as of now.
 *
 * DRAWN FROM WHAT IS HELD. The window opened on "Loading the day…" and filled
 * in a round trip later (operator, 2026-09-27: "ensure that everything is
 * already mapped on it"). The ledger is now held per org and day, the refuels
 * and drops come from the same held copy the vehicle panel's chart reads
 * (hooks/useVehicleFuelEvents), and lib/fuelPrefetch reads both for every unit
 * with a fuel alert before its window is opened. The window opens complete and
 * re-reads underneath.
 */

/** How old today's ledger may be and still be served without a re-read. */
const FRESH_MS = 60_000
const tanks = new Map()     // `${org}|${day}` -> { byVehicle: Map, at, complete }
const tankReads = new Map() // same key -> Promise

const today = () => fleetDayOf(new Date().toISOString())

/** What is held of the org's ledger for the day, or null. Synchronous. */
export function cachedTankState(orgId, day) {
  return tanks.get(`${orgId}|${day}`) ?? null
}

/** The org's ledger rows for the day, by vehicle, sharing a read in flight. */
export function loadTankState(orgId, day) {
  const key = `${orgId}|${day}`
  const held = tanks.get(key)
  if (held && (held.complete || Date.now() - held.at < FRESH_MS)) return Promise.resolve(held)
  if (tankReads.has(key)) return tankReads.get(key)
  const isToday = day >= today()
  const p = apiFetch(`/api/v1/organisations/${orgId}/fuel/tank-state${isToday ? '' : `?date=${day}`}`)
    .then((res) => {
      const next = {
        byVehicle: new Map((res.data ?? []).map((r) => [r.vehicleId, r])),
        at: Date.now(),
        complete: !isToday,
      }
      tanks.set(key, next)
      return next
    })
    .finally(() => tankReads.delete(key))
  tankReads.set(key, p)
  return p
}

/** Tests only. */
export function _resetFuelDay() {
  tanks.clear()
  tankReads.clear()
}

/** Both halves, for lib/fuelPrefetch. */
export function loadFuelDay(orgId, vehicleId, day) {
  return Promise.all([loadTankState(orgId, day), loadVehicleFuelEvents(orgId, vehicleId, day)])
}

function heldDay(orgId, vehicleId, day) {
  if (!orgId || !vehicleId || !day) return null
  const tank = cachedTankState(orgId, day)
  const events = cachedVehicleFuelEvents(orgId, vehicleId, day)
  if (!tank || !events) return null
  return {
    tank: tank.byVehicle.get(vehicleId) ?? null,
    fillings: events.fillings,
    drops: events.drains,
    loading: false,
    error: null,
  }
}

const EMPTY = { tank: null, fillings: [], drops: [], loading: false, error: null }

export function useFuelDay(orgId, vehicleId, day) {
  const [state, setState] = useState(() => heldDay(orgId, vehicleId, day) ?? { ...EMPTY, loading: Boolean(orgId && vehicleId && day) })

  useEffect(() => {
    if (!orgId || !vehicleId || !day) return undefined
    let live = true
    const held = heldDay(orgId, vehicleId, day)
    setState((s) => held ?? { ...s, loading: true, error: null })

    loadFuelDay(orgId, vehicleId, day)
      .then(([tank, events]) => {
        if (!live) return
        setState({
          tank: tank.byVehicle.get(vehicleId) ?? null,
          fillings: events.fillings,
          drops: events.drains,
          loading: false,
          error: null,
        })
      })
      .catch((err) => {
        if (!live) return
        // What is drawn stays drawn; only an empty window reports the failure.
        setState((s) => (s.tank ? { ...s, loading: false } : { ...s, loading: false, error: err?.message ?? 'Could not load the day' }))
      })
    return () => { live = false }
  }, [orgId, vehicleId, day])

  return state
}
