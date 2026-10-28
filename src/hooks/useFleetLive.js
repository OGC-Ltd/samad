// Live fleet for the active company, straight from the fleet-server DB: seed
// from GET /vehicles/snapshot, then keep positions current from the org-wide
// SSE stream. Returns the vehicle shape FleetMap renders (see lib/vehicleMap).
//
// The data lives in the TanStack Query cache (fleetKeys below) — the snapshot
// and the org id are queries, and the stream writes its frames into the same
// cache entries. Anything else that needs the fleet reads those entries
// (useFleetCount does) instead of fetching again. Mount the stream ONCE:
// context/FleetLiveContext does, for the active company.
//
// First paint is instant: the last snapshot for each company is kept in
// localStorage and seeds the query, so a reload shows the fleet immediately
// and then swaps in fresh data and the live stream.

import { useState, useEffect, useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { sseUrl } from '../services/api'
import { fetchSnapshot } from '../services/snapshot'
import { resolveOrgId } from '../api/org'
import { mapSnapshotVehicle, applyLiveUpdate, applyDispatchUpdate, applyConnectionRefresh } from '../lib/vehicleMap'
import { readCache, writeCache } from '../services/cache'
import { repairsChanged } from '../api/repairs'
import { dismissIncident } from '../lib/fuelDismissals'
import { followUpsChanged } from '../lib/fuelFollowUps'
import { accessChanged } from '../lib/accessChanged'
import { createFrameStore } from '../lib/positionDelta'

const fleetCacheKey = (companyId) => `ft-fleet:${companyId}`
const orgCacheKey   = (companyId) => `ft-org:${companyId}`
const feedCacheKey  = (companyId) => `ft-feed:${companyId}`

/**
 * How much activity the panel keeps.
 *
 * Deliberately far more than the 40 the server replays on connect, because the
 * two numbers answer different questions. The replay is "what happened most
 * recently"; this is "what this operator has seen". Matching them meant a
 * refresh could only ever show the newest 40 events, and on a fleet where one
 * event type dominates that is the same 40 every time — SUKARI's newest 40 are
 * 37 fuel items, so an hour's worth of accumulated TRACTOR_OVERDUE and driver
 * changes vanished on reload while the fuel stayed. Keeping a longer tail is
 * what lets the minority events survive alongside a noisy majority.
 */
const MAX_FEED_ITEMS = 200

/**
 * How long a persisted feed stays useful. Older than this and the operator is
 * better served by the server's replay than by yesterday's screen.
 */
const FEED_CACHE_MAX_AGE_MS = 12 * 60 * 60_000

/** Coalescing window for feed writes — see scheduleFeedPersist. */
const FEED_PERSIST_DEBOUNCE_MS = 2_000

/**
 * Most of the list any ONE kind of event may occupy.
 *
 * A plain newest-N cap cannot keep a mixed feed mixed when the emitters are
 * this lopsided. KASULU produces about thirteen zone crossings a minute, so
 * 200 slots is roughly fifteen minutes — a fuel drop from an hour ago is
 * evicted by sheer volume, and no amount of extra capacity fixes that, it only
 * moves the cliff. SUKARI has the same problem mirrored, with fuel as the
 * majority and driver/dispatch alerts as the casualties.
 *
 * Reserving the remainder for everything else is what makes "do not discard the
 * other notifications" actually hold. The cost is that the list can show a
 * chronological GAP — recent zone crossings, then a jump back to an older fuel
 * event — which is a fair trade against not showing the fuel event at all.
 */
const MAJORITY_SHARE = 0.6

/** Newest first, nothing older than the horizon, and no type hogging the list.
 *  `horizonMs` Infinity keeps every age: a technician's feed is the repair
 *  notices on their jobs, which stay until read however old (operator,
 *  2026-10-27). */
function pruneFeed(items, horizonMs = FEED_CACHE_MAX_AGE_MS) {
  const floor = Date.now() - horizonMs
  const sorted = items
    .filter(i => i && i.id && (Date.parse(i.ts) || 0) >= floor)
    .sort((a, b) => String(b.ts).localeCompare(String(a.ts)))

  if (sorted.length <= MAX_FEED_ITEMS) return sorted

  // Take newest-first, but stop admitting a type once it holds its share.
  const perType  = Math.ceil(MAX_FEED_ITEMS * MAJORITY_SHARE)
  const counts   = new Map()
  const kept     = []
  const overflow = []
  for (const it of sorted) {
    if (kept.length >= MAX_FEED_ITEMS) break
    const t = it.alertType || it.source || 'other'
    const n = counts.get(t) || 0
    if (n < perType) { counts.set(t, n + 1); kept.push(it) }
    else overflow.push(it)
  }

  // A feed with only ONE type must still fill the panel — otherwise reserving
  // space for events that do not exist would just show less.
  if (kept.length < MAX_FEED_ITEMS) {
    for (const it of overflow) {
      if (kept.length >= MAX_FEED_ITEMS) break
      kept.push(it)
    }
    kept.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))
  }
  return kept
}

/**
 * A line that came back saying something else carries `revisedAt`, so the bell
 * lights again for it (lib/feedReads). A parked fall's call is rewritten in
 * place by its verdict ("still missing", "topped up", "retracted") hours after
 * it was read; without this the dot stayed dark for the news that mattered.
 * A replay or an identical re-offer keeps the line's earlier revision.
 */
function withRevision(old, item, now) {
  if (!old) return item
  if (old.text === item.text && old.type === item.type) {
    return old.revisedAt ? { ...item, revisedAt: old.revisedAt } : item
  }
  return { ...item, revisedAt: new Date(now).toISOString() }
}

/**
 * Merge one SSE feed item into the panel's list: keyed by `id`, ordered by
 * EVENT time, capped.
 *
 * This used to be `[item, ...prev].slice(0, MAX)` — a blind prepend, which was
 * wrong in two ways once fuel events joined the feed.
 *
 * **Identity.** Both panels render `key={item.id}`, so any republished item put
 * two siblings with the same React key in the list; React keeps the first and
 * stops updating the rest, which is why the feed appeared to freeze until a
 * page reload. Three things republish: the SSE reconnect replay (EventSource
 * reconnects internally, so the effect never re-runs and never clears `feed`,
 * yet the server replays 40 items on every connect), the fuel sync (it
 * publishes by event AGE, so one filling is re-emitted on each cycle inside its
 * 2-hour window), and any reconcile pass re-surfacing a provider alert. Keying
 * by id makes all three idempotent: a republish REPLACES its item — which is
 * also what makes a corrected volume or a resolved plate land in place.
 *
 * **Order.** Every other emitter publishes with `at ≈ now`, so arrival order
 * was event order. Wialon only recognises a filling once settled readings
 * follow it, so a fuel item arrives with a timestamp up to two hours old and a
 * prepend put it ABOVE events from thirty seconds ago — then a reload, which
 * replays in server-side score order, silently moved it back down. Sorting on
 * `ts` here means the live list and the replayed list agree.
 *
 * `ts` is always an ISO-8601 UTC string (`Date.toISOString()` server-side), so
 * a lexical compare is a chronological one — no Date parsing per comparison.
 */
export function mergeFeedItem(prev, item, now = Date.now(), horizonMs = FEED_CACHE_MAX_AGE_MS) {
  const byId = new Map(prev.map(i => [i.id, i]))
  byId.set(item.id, withRevision(byId.get(item.id), item, now))
  // pruneFeed owns ordering, the age horizon and the per-type share, so the
  // live path and the rehydrated path cannot drift apart.
  return pruneFeed([...byId.values()], horizonMs)
}

// How often to re-read the snapshot purely to refresh ONLINE/OFFLINE.
//
// The provider's verdict flaps on a scale of a minute or two — DZ 08 went
// true -> false inside 90 s — so anything much slower shows a stale badge, and
// anything much faster just re-reads a 190 KB payload for no new information.
const CONNECTION_REFRESH_MS = 60_000

// ── The query cache entries ────────────────────────────────────────────────
//
// Three per company, all keyed by company so an org switch reads the new
// company's entry on the very first render — the previous org's fleet, feed or
// orgId is never painted, and never handed to a dependent hook:
//
//   orgId     resolved once and kept for the session.
//   vehicles  the snapshot, then kept current by the stream, which WRITES into
//             this entry (setQueryData) rather than into component state.
//   feed      never fetched — only the stream fills it — so it survives a
//             switch to another company and back within the session.
//
// Each is seeded from localStorage (services/cache) so a reload paints the
// last-known fleet at once. The seed is stamped as old (updatedAt 0), so the
// snapshot is still read straight away; until it lands the stream is not
// opened, because frames for units the entry does not hold are dropped.

export const fleetKeys = {
  all:      ['fleet'],
  orgId:    (companyId) => ['fleet', 'org-id', companyId],
  vehicles: (companyId) => ['fleet', 'vehicles', companyId],
  feed:     (companyId) => ['fleet', 'feed', companyId],
}

const NONE = []
const cachedList = (key) => { const c = readCache(key); return Array.isArray(c) && c.length ? c : undefined }

export const orgIdQuery = (companyId) => ({
  queryKey: fleetKeys.orgId(companyId),
  queryFn: async () => {
    const orgId = (await resolveOrgId(companyId)) ?? null
    if (orgId) writeCache(orgCacheKey(companyId), orgId)
    return orgId
  },
  enabled: Boolean(companyId),
  initialData: () => readCache(orgCacheKey(companyId)) ?? undefined,
  initialDataUpdatedAt: 0,
  staleTime: Infinity,
})

export const vehiclesQuery = (companyId, orgId) => ({
  queryKey: fleetKeys.vehicles(companyId),
  queryFn: async () => {
    const res = await fetchSnapshot(orgId)
    const mapped = (Array.isArray(res.data) ? res.data : []).map(mapSnapshotVehicle)
    writeCache(fleetCacheKey(companyId), mapped)   // refresh the seed for next load
    return mapped
  },
  enabled: Boolean(companyId && orgId),
  initialData: () => cachedList(fleetCacheKey(companyId)),
  initialDataUpdatedAt: 0,
  // The stream keeps the entry current while it is open; re-read the snapshot
  // when a company is revisited after longer than this, since nothing streamed
  // for it in the meantime.
  staleTime: 30_000,
  // A whole fleet replaced every animation frame: deep-comparing 200+ vehicles
  // to share structure would cost more than it saves. Unchanged units keep
  // their identity anyway — applyFrames copies only the ones a frame touched.
  structuralSharing: false,
})

const feedQuery = (companyId, horizonMs) => ({
  queryKey: fleetKeys.feed(companyId),
  queryFn: () => NONE,          // never runs: enabled is false
  enabled: false,
  initialData: () => pruneFeed(readCache(feedCacheKey(companyId)) || [], horizonMs),
  staleTime: Infinity,
  gcTime: Infinity,
  structuralSharing: false,
})

/** Apply a frame's worth of updates to the cached fleet, touching only those units. */
function applyFrames(list, updates) {
  if (!list?.length || !updates.size) return list
  let changed = false
  const next = list.map((v) => {
    const fn = updates.get(v.vehicleId)
    if (!fn) return v
    const nv = fn(v)
    if (nv !== v) changed = true
    return nv
  })
  return changed ? next : list
}

/**
 * @param {{ keepFeed?: boolean }} [opts] keepFeed: hold feed items of every
 *   age rather than the last 12 hours (technicians' repair notices).
 */
export function useFleetLive(companyId, { keepFeed = false } = {}) {
  const horizonMs = keepFeed ? Infinity : FEED_CACHE_MAX_AGE_MS
  const queryClient = useQueryClient()
  const [retryToken, setRetryToken] = useState(0)

  const org = useQuery(orgIdQuery(companyId))
  const orgId = org.data ?? null
  const fleet = useQuery(vehiclesQuery(companyId, orgId))
  const { data: feed = NONE } = useQuery(feedQuery(companyId, horizonMs))

  // The snapshot has been READ (not only seeded from storage): the stream may
  // open. Stays true across later refreshes, so they do not reconnect it.
  const snapshotRead = fleet.dataUpdatedAt > 0

  const retry = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: fleetKeys.orgId(companyId) })
    queryClient.invalidateQueries({ queryKey: fleetKeys.vehicles(companyId) })
    setRetryToken((t) => t + 1)
  }, [queryClient, companyId])

  useEffect(() => {
    if (!companyId || !orgId || !snapshotRead) return undefined
    const vehiclesKey = fleetKeys.vehicles(companyId)
    const feedKey = fleetKeys.feed(companyId)
    let alive = true
    let feedPersistTimer = null
    let feedToPersist = null

    // Persisting on every item would re-serialise the whole list on each SSE
    // frame, and KASULU emits a zone crossing every few seconds — localStorage
    // writes are synchronous and block the main thread. Coalesce instead; the
    // only cost of the delay is losing the last couple of seconds of feed on a
    // hard crash, which the server's replay restores anyway.
    const scheduleFeedPersist = (items) => {
      feedToPersist = items
      if (feedPersistTimer) return
      feedPersistTimer = setTimeout(() => {
        feedPersistTimer = null
        if (alive && feedToPersist) writeCache(feedCacheKey(companyId), feedToPersist)
      }, FEED_PERSIST_DEBOUNCE_MS)
    }

    // Coalesce a burst of position events (one per vehicle each poll cycle)
    // into a single cache write per frame. Updates queue per vehicle and
    // compose, so two frames for one unit inside one animation frame both land.
    let pending = new Map()
    let scheduled = false
    const flush = () => {
      scheduled = false
      if (!alive) return
      const updates = pending
      pending = new Map()
      queryClient.setQueryData(vehiclesKey, (list) => applyFrames(list, updates))
    }
    const queue = (vehicleId, fn) => {
      const prev = pending.get(vehicleId)
      pending.set(vehicleId, prev ? (v) => fn(prev(v)) : fn)
      if (!scheduled) { scheduled = true; requestAnimationFrame(flush) }
    }

    // ?delta=1: after the full replay on connect, only changed vehicles and
    // fields arrive (`position_delta`); `frames` rebuilds the full frame that
    // applyLiveUpdate needs. See lib/positionDelta.
    const frames = createFrameStore()
    const es = new EventSource(sseUrl(`/api/v1/organisations/${orgId}/live?delta=1`))
    es.addEventListener('feed', (e) => {
      try {
        const item = JSON.parse(e.data)
        // The server scopes the feed per org; drop anything else that slips
        // through (e.g. a replay raced by an org switch).
        if (item.orgId && item.orgId !== orgId) return
        // The server replays its newest 40 on every (re)connect; mergeFeedItem
        // keys by id, so a replayed item is an update, never a copy.
        const next = queryClient.setQueryData(feedKey, (prev) => mergeFeedItem(prev ?? NONE, item, Date.now(), horizonMs))
        scheduleFeedPersist(next)
      } catch { /* ignore malformed frame */ }
    })
    /* Somebody in this organisation deleted a fuel incident (the server keeps
       the record; see lib/fuelDismissals). Dropped here the moment it happens,
       so no one is left looking at a red unit their colleague has dealt with. */
    es.addEventListener('fuel_incident_dismissed', (e) => {
      try {
        const data = JSON.parse(e.data)
        if (data?.incidentId) dismissIncident(data.incidentId)
      } catch { /* ignore malformed frame */ }
    })
    /* A follow-up on a deleted fuel alert opened, changed hands or was decided
       (lib/fuelFollowUps). The frame only names it; readers re-read. */
    es.addEventListener('fuel_followup', () => { followUpsChanged() })
    /* A repair job changed for anybody in this organisation: the Repairs tab
       and the Fuel Audit read it again. */
    es.addEventListener('repair_changed', () => { repairsChanged() })
    /* An administrator changed THIS account's role or access. The server
       closes the stream after this frame; the reconnect is checked against
       the new access, and AuthProvider re-reads who this is. */
    es.addEventListener('access_changed', () => {
      accessChanged()
      // Which units this account sees may have changed with it (a technician
      // sees flagged units only, and a resolved one drops off): read the
      // snapshot again rather than keep drawing units now out of scope.
      queryClient.invalidateQueries({ queryKey: vehiclesKey })
    })
    /* What the unit is CARRYING, pushed when the gate signs it out — its own
       event because a truck standing at the gate may not send a position for an
       hour. Frames for units not in this org's snapshot fall through
       applyFrames untouched. */
    es.addEventListener('dispatch', (e) => {
      try {
        const data = JSON.parse(e.data)
        queue(data.vehicleId, (v) => applyDispatchUpdate(v, data))
      } catch { /* ignore malformed frame */ }
    })
    es.addEventListener('position', (e) => {
      try {
        const data = frames.full(JSON.parse(e.data))
        queue(data.vehicleId, (v) => applyLiveUpdate(v, data))
      } catch { /* ignore malformed frame */ }
    })
    es.addEventListener('position_delta', (e) => {
      try {
        for (const d of JSON.parse(e.data)) {
          const data = frames.apply(d)
          queue(data.vehicleId, (v) => applyLiveUpdate(v, data))
        }
      } catch { /* ignore malformed frame */ }
    })
    // EventSource reconnects on its own; nothing to do on error.

    // Connection verdicts do NOT arrive on the stream for the units that
    // matter most: a position frame is sent only when a fix time advances, so a
    // parked unit's ONLINE/OFFLINE would freeze at page load. Re-read the
    // snapshot on a slow timer and take the verdict from it, nothing else —
    // never its positions, which the stream has since overtaken.
    const connTimer = setInterval(() => {
      fetchSnapshot(orgId)
        .then((res) => {
          if (!alive) return
          const rows = Array.isArray(res.data) ? res.data : []
          const updates = new Map(rows.map((row) => [row.vehicleId, (v) => applyConnectionRefresh(v, row)]))
          const before = queryClient.getQueryData(vehiclesKey)
          const after = queryClient.setQueryData(vehiclesKey, (list) => applyFrames(list, updates))
          if (after && after !== before) writeCache(fleetCacheKey(companyId), after)
        })
        .catch(() => { /* transient — the next tick retries */ })
    }, CONNECTION_REFRESH_MS)

    return () => {
      alive = false
      es.close()
      clearInterval(connTimer)
      // FLUSH rather than cancel: closing the tab or switching org is when
      // the feed most needs to have been saved.
      if (feedPersistTimer) clearTimeout(feedPersistTimer)
      if (feedToPersist) writeCache(feedCacheKey(companyId), feedToPersist)
    }
  }, [companyId, orgId, snapshotRead, retryToken, queryClient, horizonMs])

  // A company with no backend organisation has no fleet — not a stale one.
  const noOrg = org.isSuccess && !orgId
  const vehicles = noOrg ? NONE : (fleet.data ?? NONE)
  return {
    vehicles,
    orgId,
    // Nothing to show yet and a read on its way.
    loading: !noOrg && vehicles.length === 0 && (org.isFetching || fleet.isFetching || fleet.isPending),
    error: org.error ?? fleet.error ?? null,
    retry,
    feed,
  }
}
