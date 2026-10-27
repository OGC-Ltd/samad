// The Live Feed panel's list — the live stream on top of history read from the
// server, in whichever of its two scopes is in force.
//
// Two sources, because neither alone answers either question. The SSE stream
// is current but capped at ~200 items in the browser (see useFleetLive); the
// history endpoint has everything but stops at the moment it was read. Merged,
// the panel opens with real history and keeps ticking.
//
// ## Two scopes, one list
//
// ONE UNIT, when the operator has clicked a marker: its whole history, paged
// back as far as the store goes. The live buffer is org-wide and a single unit
// is a couple of hundredths of that traffic — Kasulu emits roughly thirteen
// zone crossings a minute across 224 vehicles — so filtering the buffer to one
// of them usually yields nothing at all.
//
// THE FLEET, otherwise: everything logged TODAY. The same cap bites from the
// other side here — 200 items against thirteen a minute is about a quarter of
// an hour, so scrolling the buffer reached the bottom of the browser's memory
// and stopped, with no way to tell that from a quiet afternoon. The day is
// paged from the store like a unit's history is, and the list is bounded to
// the fleet day at both ends so the foot of it means what it says.
//
// ## Continuous: no hole between the history and the live tail
//
// The history is read when the panel opens, and the buffer only ever holds the
// last quarter of an hour. So a panel left open for an hour used to show the
// history up to the moment it opened, the buffer's last fifteen minutes, and
// NOTHING between them: the items that had passed through the buffer and been
// evicted from it were gone from the list too. A dropped SSE connection or a
// sleeping laptop tore the same hole.
//
// Two things close it. Every in-scope item the buffer shows is KEPT here, not
// read through it, so eviction from the buffer no longer removes it from the
// list. And the head of the history is re-read from the server — every minute,
// on reconnecting, and on returning to the tab — back to the newest row the
// server has already given us (see catchUp), so anything the stream missed
// entirely is filled in from the record rather than lost.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getNotifications, fleetToday } from "../api/notifications";
import { isDeletedCaseItem } from "../lib/fuelFollowUps";

/**
 * One page. The endpoint caps at 200 (500 for a day read); 100 fills the panel
 * several times over and keeps the first paint cheap, which is the read that
 * happens on every marker click.
 */
const PAGE = 100;

/**
 * One page of the fleet day, which is a much denser read than a unit's
 * history — a Kasulu day runs to several thousand rows, so 100 at a time
 * would be forty round trips to scroll it. The server allows 500 on a day
 * query (it treats a day as a complete answer rather than a page); 200 is
 * two-thirds of a screen-hour and keeps each response inside a second.
 */
const DAY_PAGE = 200;

/** How often the head is re-read from the server while the panel is up. */
const CATCH_UP_MS = 60_000;

/**
 * The most head pages one catch-up walks. At thirteen items a minute and 200 a
 * page this is about five hours of absence, which covers a laptop closed over
 * lunch; a longer gap is still filled, the next minute, from where this one
 * stopped, because each walk resumes from the newest row it reached.
 */
const CATCH_UP_MAX_PAGES = 20;

/**
 * Is this item's timestamp inside the given fleet day?
 *
 * Formatted in Africa/Nairobi and compared as a string, because that is the
 * boundary the server cut the page on (see api/notifications.fleetToday) — a
 * local-midnight comparison in a browser set to another zone would disagree
 * with the rows it was handed.
 */
const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi", year: "numeric", month: "2-digit", day: "2-digit",
});
function onFleetDay(item, day) {
  const t = Date.parse(item?.ts);
  return Number.isNaN(t) ? false : dayFmt.format(t) === day;
}

/**
 * Does this feed item belong to `vehicle`?
 *
 * The cuid is the real key — every emitter that knows its vehicle sets it. The
 * plate fallback catches items published before the vehicle was resolved (the
 * org-attribution pass links a plate to a vehicle on a later cycle, and until
 * it does the item carries a plate and a null vehicleId).
 */
export function feedItemMatchesVehicle(item, vehicle) {
  if (!item || !vehicle) return false;
  if (item.vehicleId && vehicle.vehicleId) return item.vehicleId === vehicle.vehicleId;
  return Boolean(item.plate) && item.plate === vehicle.id;
}

/** Fleet midnight (Africa/Nairobi, UTC+3 all year) of a `YYYY-MM-DD`, as ISO UTC. */
export function fleetMidnightIso(day) {
  return new Date(`${day}T00:00:00+03:00`).toISOString();
}

/**
 * The bounds of a unit's date range as ISO UTC strings: `[start, end)`, from
 * fleet midnight of `from` to fleet midnight after `to`. Null for no range.
 */
export function rangeBounds(from, to) {
  if (!from || !to) return null;
  const start = fleetMidnightIso(from);
  const end = new Date(Date.parse(fleetMidnightIso(to)) + 24 * 3600_000).toISOString();
  return { start, end };
}

/** Newest `ts` in a list of items, or null. ISO UTC strings compare lexically. */
const newestTs = (items) => items.reduce((m, it) => (it?.ts && (!m || it.ts > m) ? it.ts : m), null);

/**
 * Read the head of the history back to `since`, the newest `ts` the server has
 * already handed us, and return every row newer than or equal to it.
 *
 * Walks pages from now backwards and stops at the first page that reaches
 * `since` (or at the end of the history, or after `maxPages`). `<=` rather than
 * `<` so rows sharing that exact timestamp are re-read: they are deduplicated
 * by id, and a strict compare could skip one that landed in the same
 * millisecond as the last row of the previous read.
 *
 * @param {(before?: string) => Promise<{items: Array, nextBefore: string|null}>} fetchPage
 * @returns {Promise<{items: Array, complete: boolean}>} `complete` is false
 *   when `maxPages` ran out before reaching `since`: the rows returned are still
 *   good, and the caller resumes from the newest of them next time.
 */
export async function catchUp(fetchPage, since, maxPages = CATCH_UP_MAX_PAGES) {
  const out = [];
  let before;
  for (let n = 0; n < maxPages; n += 1) {
    const { items, nextBefore } = await fetchPage(before);
    out.push(...items);
    const oldest = items.length ? items[items.length - 1].ts : null;
    if (!nextBefore || !oldest || !since || oldest <= since) return { items: out, complete: true };
    before = nextBefore;
  }
  return { items: out, complete: false };
}

/**
 * @param {object|null} vehicle  the selected mapped vehicle, or null for the fleet
 * @param {string|null} orgId    backend organisation cuid; null switches the
 *                               hook off (nothing read, nothing kept), which is
 *                               how a closed panel stays idle
 * @param {Array}       liveFeed the shared org-wide live feed
 * @param {{from: string, to: string}|null} [range] unit scope only: fleet days
 *   `YYYY-MM-DD` to read between, inclusive. The server has no `after`, so the
 *   read starts at the range's end (`before`) and pages back until a page
 *   reaches past its start. Live items and the minute catch-up only apply
 *   while the range includes today. Null or absent: the whole history.
 * @param {{ allDays?: boolean }} [opts] fleet scope only: allDays reads the
 *   whole history rather than today (a technician's repair notices do not
 *   reset at midnight, operator 2026-10-27).
 * @returns {{ items: Array, loading: boolean, error: Error|null, retry: () => void }}
 */
export function useVehicleFeed(vehicle, orgId, liveFeed, range = null, { allDays = false } = {}) {
  // Depend on the IDENTITY strings, not on the vehicle object: every SSE
  // position flush hands back a new object for the same unit, so memoising on
  // the object would re-merge the whole feed a few times a second for a
  // selection that has not changed.
  const vehicleId = vehicle?.vehicleId ?? null;
  const plate     = vehicle?.id ?? null;
  // The fleet scope reads one day; the unit scope reads all of that unit's
  // history and passes no day at all. Recomputed per render rather than held
  // in state — it is a string, so it is only a new dependency once a night,
  // and the rollover then resets the read the same way a new selection does.
  const day = vehicleId || allDays ? null : fleetToday();
  // A unit's range, as primitives so it is a stable dependency.
  const rangeFrom = vehicleId ? range?.from ?? null : null;
  const rangeTo   = vehicleId ? range?.to ?? null : null;
  const bounds = useMemo(() => rangeBounds(rangeFrom, rangeTo), [rangeFrom, rangeTo]);
  // Does the range reach now? Then live items and catch-ups belong in it.
  const reachesNow = !bounds || rangeTo >= fleetToday();

  /**
   * Every item in scope that this panel has seen, by id: history pages, head
   * catch-ups and live items alike. It only grows (until the scope changes),
   * which is the point: nothing leaves the list because it left the buffer.
   *
   * Deliberately not localStorage-cached: see the note on services/cache —
   * several thousand rows would crowd out the writes first paint depends on.
   */
  const [known, setKnown] = useState(() => new Map());
  const [cursor, setCursor] = useState(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [firstLoaded, setFirstLoaded] = useState(false);

  // Guards a page request against the scroll handler firing again before the
  // one in flight lands — a fast scroll otherwise issues the same `before`
  // several times and appends the same page twice.
  const inFlight = useRef(false);
  const catchingUp = useRef(false);
  // Bumped on every selection change, and checked when a response lands, so a
  // reply for the truck you just clicked away from cannot append itself to the
  // list for the one you are looking at now.
  const runRef = useRef(0);
  // The newest `ts` the SERVER has given us: where the next catch-up may stop.
  // Not the newest in `known`, which may be a live item sitting above a gap.
  const serverNewest = useRef(null);

  /**
   * One page, bounded to the fleet day here as well as on the server. The
   * server's first-page cache used to answer a day read with the latest 200
   * rows whatever their day (fixed server-side, but a deployed server may
   * predate the fix), which put last night under a footer reading "everything
   * logged today". `nextBefore` is kept as the server gave it, so paging stops
   * where the server's cursor says it does.
   */
  const read = useCallback(async (before) => {
    // A range that ends before today starts its read at the range's end.
    const from = before ?? (bounds && !reachesNow ? bounds.end : undefined);
    const page = await getNotifications({ orgId, vehicleId, day, limit: day ? DAY_PAGE : PAGE, before: from });
    if (day) return { ...page, items: page.items.filter((it) => onFleetDay(it, day)) };
    if (!bounds) return page;
    // Kept to the range; a page reaching past its start is the last one.
    const inRange = page.items.filter((it) => it?.ts >= bounds.start && it.ts < bounds.end);
    const oldest = page.items.length ? page.items[page.items.length - 1].ts : null;
    return { items: inRange, nextBefore: oldest && oldest < bounds.start ? null : page.nextBefore };
  }, [orgId, vehicleId, day, bounds, reachesNow]);

  /** Server rows go in under any copy already held: the live copy wins, as it
   *  carries a republished notification's corrected wording. */
  const addFromServer = useCallback((items) => {
    if (!items.length) return;
    setKnown((prev) => {
      let next = null;
      for (const it of items) {
        if (it?.id == null || prev.has(it.id)) continue;
        next ??= new Map(prev);
        next.set(it.id, it);
      }
      return next ?? prev;
    });
    const top = newestTs(items);
    if (top && (!serverNewest.current || top > serverNewest.current)) serverNewest.current = top;
  }, []);

  const fetchPage = useCallback(async (before) => {
    if (!orgId || inFlight.current) return;
    inFlight.current = true;
    const run = runRef.current;
    setLoading(true);
    try {
      const { items, nextBefore } = await read(before);
      if (run !== runRef.current) return;
      addFromServer(items);
      setCursor(nextBefore);
      setDone(!nextBefore);
      setError(null);
      setFirstLoaded(true);
    } catch (err) {
      if (run === runRef.current) setError(err);
    } finally {
      if (run === runRef.current) setLoading(false);
      inFlight.current = false;
    }
  }, [orgId, read, addFromServer]);

  // A new selection — or a new day — starts a new history. Everything resets,
  // including the cursor: carrying one over would page into the previous
  // unit's timeline, or into yesterday.
  useEffect(() => {
    runRef.current += 1;
    inFlight.current = false;
    catchingUp.current = false;
    serverNewest.current = null;
    setKnown(new Map()); setCursor(null); setDone(false); setError(null); setFirstLoaded(false);
    if (orgId) fetchPage(undefined);
  }, [orgId, vehicleId, day, bounds, fetchPage]);

  // Keep every in-scope live item, so the buffer evicting it does not.
  // Off while the scope is off (no org: a closed panel), so a panel that is
  // mounted but shut does not accumulate a day in the background.
  useEffect(() => {
    if (!orgId || !liveFeed?.length || !reachesNow) return;
    const subject = vehicleId || plate ? { vehicleId, id: plate } : null;
    setKnown((prev) => {
      let next = null;
      for (const it of liveFeed) {
        if (it?.id == null) continue;
        if (subject ? !feedItemMatchesVehicle(it, subject) : day && !onFleetDay(it, day)) continue;
        if (bounds && !(it.ts >= bounds.start)) continue;
        if (prev.get(it.id) === it) continue;
        next ??= new Map(prev);
        next.set(it.id, it);
      }
      return next ?? prev;
    });
  }, [orgId, liveFeed, vehicleId, plate, day, bounds, reachesNow]);

  // Fill anything the stream missed, from the record.
  const runCatchUp = useCallback(async () => {
    if (!orgId || !firstLoaded || !reachesNow || catchingUp.current || !serverNewest.current) return;
    catchingUp.current = true;
    const run = runRef.current;
    try {
      const { items } = await catchUp(read, serverNewest.current);
      if (run === runRef.current) addFromServer(items);
    } catch {
      // The next tick tries again; the list on screen stays as it is.
    } finally {
      if (run === runRef.current) catchingUp.current = false;
    }
  }, [orgId, firstLoaded, reachesNow, read, addFromServer]);

  useEffect(() => {
    if (!firstLoaded) return undefined;
    const tick = () => { if (document.visibilityState !== "hidden") runCatchUp(); };
    const id = setInterval(tick, CATCH_UP_MS);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("online", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
      window.removeEventListener("online", tick);
    };
  }, [firstLoaded, runCatchUp]);

  /** Ask for the next page. A no-op at the end of the history. */
  const loadMore = useCallback(() => {
    if (done || loading || !cursor) return;
    fetchPage(cursor);
  }, [done, loading, cursor, fetchPage]);

  const retry = useCallback(() => fetchPage(undefined), [fetchPage]);

  // `ts` is an ISO-8601 UTC string server-side, so a lexical compare is a
  // chronological one.
  // A deleted alert's case items are never shown (lib/fuelFollowUps).
  const items = useMemo(
    () => [...known.values()]
      .filter((it) => !isDeletedCaseItem(it))
      .sort((a, b) => String(b.ts).localeCompare(String(a.ts))),
    [known],
  );

  return {
    items,
    /**
     * True only while the FIRST page is in flight, so the panel shows its
     * loading state on open and never blanks the history already on screen to
     * announce that more of it is coming.
     */
    loading: loading && !firstLoaded,
    /** A page beyond the first is arriving — for a footer, not for the list. */
    loadingMore: loading && firstLoaded,
    /** Nothing older remains: the end of the unit's history, or of the day. */
    atEnd: done,
    loadMore,
    error,
    retry,
  };
}
