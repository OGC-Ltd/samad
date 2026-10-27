/**
 * Fuel incidents deleted from the dashboard.
 *
 * "Delete" on the incident window calls the server
 * (POST /fuel/thefts/:id/dismiss), which marks the fuel_thefts row dismissed
 * for the whole organisation and KEEPS it: the ledger, the reports and the
 * notification history still count it. The server then stops including it in
 * the fleet snapshot and tells every open dashboard over SSE
 * (`fuel_incident_dismissed`, handled in useFleetLive).
 *
 * This store is how a dismissal reaches the screen without waiting for a new
 * snapshot. A dismissed incident is removed from the live fleet itself (see
 * FleetLiveContext), so the alerts list, the map, the side panel and the
 * window all forget it at once. It is also kept in localStorage, which covers
 * a snapshot cached in the browser from before the dismissal.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'ft-fuel-incident-dismissed';
// The server only shows an incident for 24 h, so a short list is plenty.
const MAX = 200;

const listeners = new Set();
let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    cache = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    cache = new Set();
  }
  return cache;
}

export function readDismissed() {
  return load();
}

export function dismissIncident(id) {
  if (id == null) return;
  const next = new Set(load());
  if (next.has(id)) return;
  next.add(id);
  cache = new Set([...next].slice(-MAX));
  try {
    localStorage.setItem(KEY, JSON.stringify([...cache]));
  } catch { /* private mode, quota: still deleted for this session */ }
  listeners.forEach((fn) => fn());
}

function subscribe(fn) {
  listeners.add(fn);
  // Another tab deleting one should take effect here too.
  const onStorage = (e) => {
    if (e.key !== KEY) return;
    cache = null;
    fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** The deleted incident ids, re-rendering the caller when one is added. */
export function useDismissedIncidents() {
  return useSyncExternalStore(subscribe, load, load);
}

/**
 * The fleet as the UI should see it: a deleted incident is taken off its unit,
 * and a unit that was red only because of it gets its ordinary status back.
 * Vehicles without a deleted incident are returned as the same objects, so
 * nothing downstream re-renders for them.
 */
export function withoutDismissed(vehicles, dismissed, deriveStatus) {
  if (!dismissed?.size || !vehicles?.length) return vehicles;
  let changed = false;
  const out = vehicles.map((v) => {
    if (!v?.fuelIncident || !dismissed.has(v.fuelIncident.id)) return v;
    changed = true;
    return {
      ...v,
      fuelIncident: null,
      status: v.status === 'theft'
        ? deriveStatus({
            speedKmh:         v.speed,
            flags:            { fuelInconsistency: false },
            capturedAt:       v.capturedAt,
            capturedAtMs:     v.capturedAtMs,
            movement:         v.movement,
            connectionOnline: v.connectionOnline,
            engineOn:         v.engine === 'on',
            speedLimitKmh:    v.speedLimit,
          })
        : v.status,
    };
  });
  return changed ? out : vehicles;
}
