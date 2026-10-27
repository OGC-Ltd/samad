// What a fuel alert opens, read before it is opened.
//
// A click on a fuel alert opens its incident window and the unit's side panel
// (operator, 2026-09-27: "when rendering this modal ensure that everything is
// already mapped on it", and the Fuel & overspeed chart "without any sort of
// delays"). Both drew their frame at once and then waited a round trip for
// their contents, so they opened on "Loading…" and filled in.
//
// There are one or two open alerts per company, so everything the two views
// need is simply read ahead for each of them, into the same held copies the
// views draw from:
//
//   - the incident's day in the window: the org's tank ledger for that day,
//     and the unit's drains and fillings (hooks/useFuelDay);
//   - the side panel's chart: today's readings (lib/vehicleDay) and today's
//     drains and fillings for its bands (hooks/useVehicleFuelEvents);
//   - whether this viewer may review the alert (lib/fuelReview).
//
// Re-read every REFRESH_MS while the alerts stand, so what a click finds is
// never more than a couple of minutes old, and the views re-read underneath
// whatever they open on.

import { useEffect, useMemo, useRef } from 'react';
import { loadFuelDay } from '../hooks/useFuelDay';
import { loadVehicleFuelEvents } from '../hooks/useVehicleFuelEvents';
import { isTheftAlert } from './fuelAlerts';
import { fleetDayOf } from './fuelDay';
import { fetchReviewRights } from './fuelReview';
import { loadDay } from './vehicleDay';

const REFRESH_MS = 2 * 60_000;

const quietly = (p) => Promise.resolve(p).catch(() => null);

/** Reads everything one alert's window and side panel will show. Never rejects. */
export function prefetchFuelAlert(orgId, vehicle) {
  const id = vehicle?.vehicleId;
  const incident = vehicle?.fuelIncident;
  if (!orgId || !id || !incident) return Promise.resolve();
  const today = fleetDayOf(new Date().toISOString());
  const day = incident.beganAt ? fleetDayOf(incident.beganAt) : today;
  return Promise.all([
    quietly(loadFuelDay(orgId, id, day)),
    quietly(loadDay(orgId, id, today)),
    day === today ? null : quietly(loadVehicleFuelEvents(orgId, id, today)),
    quietly(fetchReviewRights(orgId)),
  ]);
}

/**
 * Keeps every open fuel alert's views read ahead. Call once, where the fleet
 * and its organisation are known. The work waits for an idle moment, so it
 * never competes with the map drawing the snapshot it arrived with.
 */
export function usePrefetchFuelAlerts(orgId, vehicles) {
  const alerts = useMemo(() => (vehicles ?? []).filter(isTheftAlert), [vehicles]);
  const latest = useRef(alerts);
  latest.current = alerts;
  // Changes only when an alert opens, closes or is replaced — not on every
  // live frame the fleet array is rebuilt for.
  const which = alerts.map((v) => `${v.vehicleId}:${v.fuelIncident.id}`).join(',');

  useEffect(() => {
    if (!orgId || !which) return undefined;
    const run = () => { for (const v of latest.current) prefetchFuelAlert(orgId, v); };
    // Called ON window: cancelIdleCallback detached from it throws "Illegal
    // invocation", and a throw in this cleanup takes the whole map down.
    const hasIdle = typeof window.requestIdleCallback === 'function';
    const idle = hasIdle ? window.requestIdleCallback(run, { timeout: 1500 }) : setTimeout(run, 200);
    const timer = setInterval(run, REFRESH_MS);
    return () => {
      if (hasIdle) window.cancelIdleCallback(idle); else clearTimeout(idle);
      clearInterval(timer);
    };
  }, [orgId, which]);
}
