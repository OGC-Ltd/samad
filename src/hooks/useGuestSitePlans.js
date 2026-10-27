// Which surveys belonging to OTHER organisations currently hold one of this
// fleet's units — see lib/guestSitePlans for what a guest layer is and why the
// containment is computed here.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ALL_SITE_PLANS } from "../lib/sitePlans";
import {
  perimeterOf, bboxOf, occupantsIn, nextGuestState, sameGuestList,
} from "../lib/guestSitePlans";

/**
 * The shortest gap between two sweeps.
 *
 * A LEADING-edge throttle, which is the whole point: the first change after a
 * quiet spell runs immediately, and only a burst is coalesced. A lorry
 * arriving in a yard is precisely the quiet-then-one-frame case, so it is
 * caught on the position frame that reports it.
 *
 * This was a 20-second interval, which meant a visit could sit undetected for
 * twenty seconds after the telemetry had already arrived — and the map layer
 * and the header's quick links waited with it. The interval was guarding
 * against a cost that was never there: measured on the live fleets, one pass
 * over 597 units against seven perimeters (12 to 141 vertices) is 1.5-2 ms,
 * and with bboxOf's reject in front of it, a fraction of that.
 *
 * A second is still worth keeping. The fleet array is replaced on every
 * animation frame that carries position updates, so an unthrottled sweep would
 * run up to sixty times a second to answer a question that cannot change that
 * fast.
 */
const MIN_SWEEP_GAP_MS = 1_000;

/**
 * The slow tick, which exists for LEAVING rather than arriving.
 *
 * Arrival is driven by the fleet changing. Departure often is not: the last
 * unit in a yard drives out, its final frame lands, and then nothing about
 * this organisation changes at all — so with no clock the grace window would
 * never expire and the survey would stay offered. Thirty seconds against a
 * three-minute grace is well inside the noise.
 */
const EXPIRY_TICK_MS = 30_000;

/**
 * The perimeters, fetched once per file and then never again.
 *
 * Two caches on purpose. `pending` makes the request happen once even if two
 * organisations ask for the same file in the same tick; `ready` holds the
 * RESOLVED value, so an organisation whose files have already been read can
 * sweep in the same tick it mounts rather than waiting a promise tick between
 * the switch and the answer.
 *
 * A file that fails to load resolves to null rather than rejecting. A guest
 * layer is an extra: a survey that cannot be read simply offers nothing, and
 * putting an error on the map for a layer the operator never asked for would
 * be noise about someone else's tenant.
 */
const pending = new Map();
const ready = new Map();

function loadFence(url) {
  if (ready.has(url)) return ready.get(url);
  if (!pending.has(url)) {
    pending.set(url, fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((fc) => {
        const perimeter = perimeterOf(fc);
        const fence = perimeter ? { perimeter, bbox: bboxOf(perimeter) } : null;
        ready.set(url, fence);
        return fence;
      })
      .catch(() => { ready.set(url, null); return null; }));
  }
  return pending.get(url);
}

/**
 * @param {object} opts
 * @param {Array}  opts.vehicles         this organisation's live fleet
 * @param {string} opts.activeCompanyId  the organisation on screen
 * @param {boolean} [opts.enabled]       false switches the whole thing off
 * @returns {Array} plan rows to append to this org's own surveys, each marked
 *   `guest: true` and carrying `occupants` and `since`. Stable by identity
 *   while the answer is unchanged.
 */
export function useGuestSitePlans({ vehicles, activeCompanyId, enabled = true }) {
  const [guestState, setGuestState] = useState({});

  // The surveys that are not this organisation's. Molo and anything else
  // without a fence drops out below, once its file has been read.
  const foreign = useMemo(
    () => ALL_SITE_PLANS.filter((p) => p.companyId !== activeCompanyId),
    [activeCompanyId],
  );

  // Read by the sweep rather than depended on by it, so the sweep function
  // stays stable while the fleet is replaced under it.
  const vehiclesRef = useRef(vehicles);
  vehiclesRef.current = vehicles;

  const fencesRef    = useRef([]);   // [{ plan, perimeter, bbox }] for THIS org
  const lastSweepRef = useRef(0);
  const timerRef     = useRef(null);

  const sweep = useCallback(() => {
    const now = Date.now();
    lastSweepRef.current = now;
    const sightings = {};
    for (const { plan, perimeter, bbox } of fencesRef.current) {
      sightings[plan.id] = occupantsIn(vehiclesRef.current, perimeter, now, bbox);
    }
    setGuestState((prev) => {
      const next = nextGuestState(prev, sightings, now);
      // Same yards, same counts: hand back the SAME object, or a sweep that
      // found nothing new would still rebuild every map layer it describes.
      return sameGuestList(prev, next) ? prev : next;
    });
  }, []);

  const scheduleSweep = useCallback(() => {
    if (timerRef.current) return;                       // one already queued
    const wait = MIN_SWEEP_GAP_MS - (Date.now() - lastSweepRef.current);
    if (wait <= 0) { sweep(); return; }                 // the leading edge
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      sweep();
    }, wait);
  }, [sweep]);

  useEffect(() => {
    // A fresh organisation starts with an empty list — the previous org's
    // guests were about the previous org's lorries — and with NO fences, set
    // synchronously. Leaving the old set in place for even one sweep would let
    // a survey this organisation OWNS be reported as one it is visiting, since
    // that is exactly what it was a moment ago.
    fencesRef.current = [];
    setGuestState({});
    if (!enabled || foreign.length === 0) return undefined;

    let alive = true;

    const install = (loaded) => {
      if (!alive) return;
      fencesRef.current = loaded
        .filter((l) => l.fence)
        .map((l) => ({ plan: l.plan, ...l.fence }));
      // sweep, not scheduleSweep: this is the answer to "what is happening
      // HERE", and it must not be held behind a gap left over from the
      // organisation the operator has just left.
      sweep();
    };

    // The same tick where possible. Every file this org needs may already have
    // been read — on a second visit to an organisation it always has.
    const cached = foreign.map((plan) => ({ plan, fence: ready.get(plan.url) }));
    if (cached.every((c) => c.fence !== undefined)) {
      install(cached);
    } else {
      Promise.all(foreign.map((plan) =>
        Promise.resolve(loadFence(plan.url)).then((fence) => ({ plan, fence }))))
        .then(install);
    }

    // Warm the rest in the background, so the NEXT switch is a same-tick
    // answer too. A few KB each, read once per session.
    for (const plan of ALL_SITE_PLANS) if (!ready.has(plan.url)) loadFence(plan.url);

    const expiry = setInterval(sweep, EXPIRY_TICK_MS);
    return () => {
      alive = false;
      clearInterval(expiry);
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    };
  }, [foreign, enabled, sweep]);

  // The fleet moved, so the answer may have. This is what replaced the poll.
  useEffect(() => { scheduleSweep(); }, [vehicles, scheduleSweep]);

  return useMemo(
    () => foreign
      .filter((plan) => guestState[plan.id])
      .map((plan) => ({
        ...plan,
        guest: true,
        // A guest is never persisted. Carrying no prefKey is what says so, and
        // what stops a visit writing itself into this org's stored layers.
        prefKey: null,
        occupants: guestState[plan.id].occupants ?? [],
        since: guestState[plan.id].since,
      })),
    [foreign, guestState],
  );
}
