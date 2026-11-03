// Notification → clip (operator, 2026-10-31: "when one clicks on a
// notification in the notification tab, he/she gets directed to the clip
// instead of the right panel").
//
// A dashcam notification (feed item `source: "device"`, see server/shapes.go
// feedItem) carries the same id as its alarm on the Camera page
// (server/vss.go vssAlarms: both are the partner's event_id). So the bell
// does not need the clip itself: it asks the Camera page's own query whether
// that alarm came with evidence, and if so leaves the alarm's id here and
// switches tab. The Camera page takes the id on mount, opens that alarm and
// plays its clip.
//
// A camera notification with no clip (the page lists only alarms that brought
// one) keeps the old behaviour: the unit's panel on the map.

import { useSyncExternalStore } from 'react'
import { vssIncidentsQuery } from '../api/vssAlarms'
import { queryClient } from '../store/queryClient'

/** True for a feed item that came from a dashcam. */
export const isDashcamItem = (item) => item?.source === 'device' && item?.id != null

/**
 * The smallest Camera-page window that holds a moment: today, else the last
 * seven days, else none (older than the page can show).
 */
export function rangeFor(ts, now = new Date()) {
  const t = Date.parse(ts)
  if (!Number.isFinite(t)) return 'today'
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (t >= midnight.getTime()) return 'today'
  const week = new Date(midnight); week.setDate(week.getDate() - 6)
  return t >= week.getTime() ? '7d' : null
}

/**
 * Does this notification's alarm have a clip or snapshot on the Camera page?
 * Reads the page's own query (cached: the map rail's badge keeps "today"
 * warm), so the answer is usually instant. Resolves to the range to open the
 * page on, or null when there is nothing to show. Never throws.
 */
export async function findDashcamAlarm(item, orgId) {
  if (!isDashcamItem(item) || !orgId) return null
  const range = rangeFor(item.ts)
  if (!range) return null
  try {
    const list = await queryClient.fetchQuery(vssIncidentsQuery(orgId, range))
    const hit = (list ?? []).find((i) => i.id === String(item.id))
    return hit && (hit.hasClip || hit.hasPhoto) ? range : null
  } catch {
    return null
  }
}

// ── the hand-over to the Camera page ────────────────────────────────────────

let pending = null              // { id, range } until the page takes it
const listeners = new Set()
const emit = () => listeners.forEach((fn) => fn())

/** Ask the Camera page to open alarm `id`, in window `range`. */
export function openDashcamAlarm(id, range = 'today') {
  pending = { id: String(id), range, at: Date.now() }
  emit()
}

/** The page has opened it. */
export function clearDashcamJump() {
  if (!pending) return
  pending = null
  emit()
}

/** The alarm waiting to be opened, or null. */
export function useDashcamJump() {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    () => pending,
    () => pending,
  )
}
