// One vehicle's fuel ledger for one fleet day — its drains and fillings, as
// the server judged them — for the fuel chart's event bands (lib/fuelEpisodes),
// the FUEL RATE / FUEL DOWN summary under it (lib/fuelRateSummary) and the day
// in the fuel incident window (hooks/useFuelDay).
//
// The same two list endpoints the fuel tab reads for the whole fleet, filtered
// to the unit: two small requests rather than the fleet's day.
//
// HELD FOR THE SESSION, and drawn from what is held. The window and the panel
// used to open on "Loading…" and fill in a round trip later (operator,
// 2026-09-27: "when rendering this modal ensure that everything is already
// mapped on it"). Now one loader serves all three, a unit with a fuel alert is
// read before anyone opens it (lib/fuelPrefetch), and a view opens on what is
// held and re-reads underneath. A finished day never changes and is kept; today
// is re-read when it is older than FRESH_MS, and every few minutes while open,
// since the adjudicator judges drains every quarter hour.

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../services/api';
import { dayBounds } from '../lib/vehicleDay';
import { fuelEpisodes, levelsFromPings } from '../lib/fuelEpisodes';
import { settleLimited } from '../lib/settleLimited';
import { fleetDayKey } from './useFuelEvents';

const TODAY_REFRESH_MS = 5 * 60_000;
/** How old today's copy may be and still be served without a re-read. */
const FRESH_MS = 60_000;
const EMPTY = { drains: [], fillings: [], loading: false, error: null };
const cache = new Map();     // `${org}|${vehicle}|${day}` -> { drains, fillings, at, complete }
const inflight = new Map();  // same key -> Promise

const keyOf = (orgId, vehicleId, dayKey) => `${orgId}|${vehicleId}|${dayKey}`;

/** What is held for the unit's day, or null. Synchronous, for the first frame. */
export function cachedVehicleFuelEvents(orgId, vehicleId, dayKey) {
  return orgId && vehicleId && dayKey ? cache.get(keyOf(orgId, vehicleId, dayKey)) ?? null : null;
}

/**
 * The unit's drains and fillings for the day, from what is held where it is
 * current, sharing a request already in flight. Resolves to the held entry
 * { drains, fillings }. `force` re-reads today even when it is fresh.
 */
export function loadVehicleFuelEvents(orgId, vehicleId, dayKey, { force = false } = {}) {
  const key = keyOf(orgId, vehicleId, dayKey);
  const held = cache.get(key);
  if (held && (held.complete || (!force && Date.now() - held.at < FRESH_MS))) return Promise.resolve(held);
  if (inflight.has(key)) return inflight.get(key);

  const { start, end } = dayBounds(dayKey);
  const q = `vehicleId=${encodeURIComponent(vehicleId)}&from=${new Date(start).toISOString()}`
    + `&to=${new Date(end).toISOString()}&limit=200`;
  const p = Promise.all([
    apiFetch(`/api/v1/organisations/${orgId}/fuel/thefts?${q}`),
    apiFetch(`/api/v1/organisations/${orgId}/fuel/fillings?${q}`),
  ])
    .then(([d, f]) => {
      const next = { drains: d?.data ?? [], fillings: f?.data ?? [], at: Date.now(), complete: dayKey < fleetDayKey() };
      cache.set(key, next);
      return next;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Tests only. */
export function _resetVehicleFuelEvents() {
  cache.clear();
  inflight.clear();
}

const shown = (held) => ({ drains: held.drains, fillings: held.fillings, loading: false, error: null });

export function useVehicleFuelEvents(orgId, vehicleId, dayKey) {
  const key = orgId && vehicleId && dayKey ? keyOf(orgId, vehicleId, dayKey) : null;
  const [state, setState] = useState(() => {
    const held = key ? cache.get(key) : null;
    return held ? shown(held) : { ...EMPTY, loading: Boolean(key) };
  });

  useEffect(() => {
    if (!key) { setState(EMPTY); return undefined; }
    let live = true;
    const held = cache.get(key);
    // What is held is on screen from the first frame; the read below only
    // ever replaces it with something newer.
    setState((s) => (held ? (s.drains === held.drains && s.fillings === held.fillings && !s.loading ? s : shown(held)) : { ...EMPTY, loading: true }));

    const load = (force) => loadVehicleFuelEvents(orgId, vehicleId, dayKey, { force })
      .then((got) => {
        if (!live) return;
        setState((s) => (s.drains === got.drains && s.fillings === got.fillings && !s.loading ? s : shown(got)));
      })
      .catch((err) => {
        if (!live) return;
        // Keep what is drawn; only an empty view reports the failure.
        setState((s) => (s.drains.length || s.fillings.length
          ? { ...s, loading: false }
          : { ...s, loading: false, error: err?.message ?? 'Could not load the fuel events' }));
      });

    load(false);
    const timer = dayKey === fleetDayKey() ? setInterval(() => load(true), TODAY_REFRESH_MS) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [key, orgId, vehicleId, dayKey]);

  return state;
}

/**
 * The same for several days (the Fuel tab's range, lib/dayRange), each day
 * read and held exactly as useVehicleFuelEvents holds it. A day that fails
 * leaves a gap rather than emptying the range; today, when in it, is re-read
 * on the same clock.
 */
export function useVehicleFuelEventsRange(orgId, vehicleId, dayKeys) {
  const key = orgId && vehicleId && dayKeys.length ? `${orgId}|${vehicleId}|${dayKeys.join(',')}` : null;
  const joined = (helds) => (helds.length === 1
    ? shown(helds[0])
    : { drains: helds.flatMap((h) => h.drains), fillings: helds.flatMap((h) => h.fillings), loading: false, error: null });
  const heldAll = () => dayKeys.map((d) => cache.get(keyOf(orgId, vehicleId, d)));
  const [state, setState] = useState(() => {
    const helds = key ? heldAll() : [];
    return key && helds.every(Boolean) ? joined(helds) : { ...EMPTY, loading: Boolean(key) };
  });

  useEffect(() => {
    if (!key) { setState(EMPTY); return undefined; }
    let live = true;
    const helds = heldAll();
    if (helds.every(Boolean)) setState(joined(helds));
    else setState((s) => ({ ...s, loading: true, error: null }));

    // A few days at a time: a pick can run to 90 days (lib/settleLimited)
    const load = (force) => settleLimited(dayKeys, 4, (d) => loadVehicleFuelEvents(orgId, vehicleId, d, { force: force && d === fleetDayKey() }))
      .then((rs) => {
        if (!live) return;
        const got = rs.filter((r) => r.status === 'fulfilled').map((r) => r.value);
        if (!got.length) {
          const err = rs[0]?.reason;
          setState((s) => ({ ...s, loading: false, error: err?.message ?? 'Could not load the fuel events' }));
          return;
        }
        setState(joined(got));
      });

    load(false);
    const timer = dayKeys.includes(fleetDayKey()) ? setInterval(() => load(true), TODAY_REFRESH_MS) : null;
    return () => { live = false; if (timer) clearInterval(timer); };
  // `key` carries the org, the unit and every day
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/**
 * The day's events placed on its tank line and numbered (lib/fuelEpisodes).
 * Worked out once by the panel and handed to both the chart and the FUEL RATE
 * / FUEL DOWN summary under it, so the numbers the two show are the same ones.
 */
export function useFuelEpisodes(drains, fillings, pings) {
  return useMemo(
    () => fuelEpisodes({ drains, fillings, levels: levelsFromPings(pings) }),
    [drains, fillings, pings],
  );
}
