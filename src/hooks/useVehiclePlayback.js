import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '../services/api'
import { daysOf, mergeDays } from '../lib/playbackRange'

/**
 * One unit's recorded day, ready to replay.
 *
 * Served by /vehicles/:id/playback, which is deliberately NOT the endpoint the
 * map's breadcrumb line uses. That one returns three columns for a static
 * polyline; this returns heading and speed per fix as well, because a marker
 * has to point somewhere and a readout has to say something.
 *
 * NOT cached, unlike the sibling hooks in this folder. A day is up to ~15,000
 * fixes and the payload for the busiest unit in the fleet is around 74 KB after
 * simplification — too big to spend the shared localStorage budget on, and
 * pointless to keep: nobody replays the same day twice in a session, and a day
 * that is still in progress would be served stale.
 *
 * `day` is a SPAN: one fleet day (`YYYY-MM-DD`) or a range
 * (`YYYY-MM-DD..YYYY-MM-DD`, at most a month). The server answers one day per
 * request, so a range is one request per day, FETCH_AT_ONCE at a time, joined
 * by lib/playbackRange into the shape of a single day.
 */
/** Days requested in parallel. A month at once would be 31 simultaneous
 *  requests each scanning a day of fixes, from one browser tab. */
const FETCH_AT_ONCE = 4

/** `fn` over `items`, at most `n` running at once, results in input order. */
async function inBatches(items, n, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export function useVehiclePlayback(orgId, vehicleId, day) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const abortRef = useRef(null)

  useEffect(() => {
    if (!orgId || !vehicleId || !day) { setData(null); return undefined }

    // A day change while the previous request is in flight must not leave the
    // later response racing the earlier one — the day picker is a spinner and
    // people hold the arrow down.
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setLoading(true)
    setError(null)

    inBatches(daysOf(day), FETCH_AT_ONCE, d => apiFetch(
      `/api/v1/organisations/${orgId}/vehicles/${vehicleId}/playback?day=${d}`,
      { signal: ctrl.signal },
    ))
      .then(results => {
        if (ctrl.signal.aborted) return
        setData(mergeDays(results.map(res => res.data ?? null)))
        setLoading(false)
      })
      .catch(err => {
        if (ctrl.signal.aborted || err?.name === 'AbortError') return
        setError(err?.message ?? 'Could not load that day')
        setData(null)
        setLoading(false)
      })

    return () => ctrl.abort()
  }, [orgId, vehicleId, day])

  return {
    data,
    points: data?.points ?? [],
    /**
     * What happened during the day, in time order — stops, drains, refuels,
     * zone crossings, speeding runs. Positions are deliberately absent; the
     * server has none to give (no event table on this fleet carries a
     * coordinate), so each one is placed on the track by its timestamp.
     */
    events: data?.events ?? [],
    loading,
    error,
  }
}
