// Live Feed history, from the fleet-server notification store.
//
// The panel's normal source is the SSE 'feed' stream plus the ~200 items this
// browser has accumulated (see hooks/useFleetLive). That buffer is too small
// for BOTH of the questions the feed is asked, in opposite directions:
//
//   · ONE UNIT. The buffer is the whole organisation's traffic, and a single
//     vehicle is a couple of hundredths of it — so it holds a handful of that
//     unit's events at best, and usually none.
//   · TODAY. The buffer caps at 200 items with a per-type share (see
//     hooks/useFleetLive), which on a fleet emitting thirteen zone crossings a
//     minute is about a quarter of an hour. Scrolling it reached the bottom of
//     the browser's memory, not the bottom of the day.
//
// Both are read from the durable store here.

import { apiFetch } from "../services/api";

/**
 * One page of newest-first notifications for an organisation.
 *
 * `vehicleId` narrows it to one unit — the backend cuid (`vehicle.vehicleId`
 * on a mapped vehicle), NOT the plate, which is `id`. `day` bounds it to one
 * FLEET day, `YYYY-MM-DD` in Africa/Nairobi, which is the calendar the server
 * counts in and the one the operators work in.
 *
 * Returns the same item shape the SSE feed delivers — { id, ts, time, type,
 * text, source, alertType, plate, vehicleId } — so callers can merge the two
 * lists without translating either.
 *
 * ## Paged, because "all of it" is not a response size
 *
 * The panel shows a unit's whole history, and for a busy one that is thousands
 * of rows: the store keeps 90 days and the p95 vehicle-day carries 52 events.
 * Asking for all of it at once would be a multi-megabyte payload whose first
 * twenty lines are the only ones anybody reads. `before` is the server's own
 * cursor — the `ts` of the last item on the page — so each further page is one
 * indexed range scan, fetched as the list is actually scrolled.
 *
 * @param {string} [before] ISO timestamp; returns items strictly older than it.
 * @param {string[]} [alertTypes] only these alert types (the server's own
 *   `alertType` filter), e.g. the Safety tab's harsh-driving events.
 * @returns {Promise<{items: Array, nextBefore: string|null}>} `nextBefore` is
 *   null when there is nothing older, which is what ends the scroll.
 */
export async function getNotifications({ orgId, vehicleId, day, limit = 100, before, alertTypes }) {
  if (!orgId) return { items: [], nextBefore: null };

  const res = await apiFetch(
    `/api/v1/organisations/${orgId}/notifications?limit=${limit}` +
      (vehicleId ? `&vehicleId=${encodeURIComponent(vehicleId)}` : "") +
      (alertTypes?.length ? `&alertType=${encodeURIComponent(alertTypes.join(","))}` : "") +
      (day ? `&day=${encodeURIComponent(day)}` : "") +
      (before ? `&before=${encodeURIComponent(before)}` : "")
  );

  const items = res.data?.notifications ?? [];
  return {
    items,
    // The server echoes a cursor even for a short page, so trust the LENGTH
    // instead: a page thinner than asked for is the end of the history, and
    // following its cursor would be one more empty round trip every time the
    // operator reaches the bottom.
    nextBefore: items.length < limit ? null : (res.data?.nextBefore ?? null),
  };
}

/**
 * The fleet day, `YYYY-MM-DD`, as the server counts it.
 *
 * Africa/Nairobi explicitly rather than the browser's own midnight: the day is
 * a FILTER the server applies in that zone (see notification.reader,
 * fleetDayBounds), so a browser open in another zone asking for "its" today
 * would be handed a window the server had already cut somewhere else. Both
 * Kenyan and Tanzanian operations sit at +03, so for everyone actually running
 * a fleet this is also their own wall calendar.
 */
export function fleetToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}
