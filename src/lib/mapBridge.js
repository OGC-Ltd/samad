// What FleetMap hands to the rest of the app that is not plain state.
//
//   Published lists — `layers` (rows with their own onToggle) and `stranded`
//     (live vehicle objects). Read with useMapPublished, which re-renders on
//     change through useSyncExternalStore. Kept out of Redux on purpose: the
//     store must hold serialisable values, and it freezes what it holds, which
//     would freeze vehicle objects the live feed still writes to.
//   Commands — focus a vehicle, apply a filter, start a playback, fly to a
//     weighbridge, put the map on screen. FleetMap registers its handlers;
//     anything can call them. Calling before the map has registered is a
//     no-op, as it was with the context.
//
// Module-level, so there is nothing to mount: one map, one bridge.

import { useSyncExternalStore } from "react";

const EMPTY = [];
let published = { layers: EMPTY, stranded: EMPTY };
const listeners = new Set();

function publish(key, value) {
  const next = value ?? EMPTY;
  if (published[key] === next) return;
  published = { ...published, [key]: next };
  listeners.forEach((l) => l());
}

export const publishLayers = (layers) => publish("layers", layers);
export const publishStranded = (list) => publish("stranded", list);

const subscribe = (l) => { listeners.add(l); return () => listeners.delete(l); };
const snapshot = () => published;

/** The lists FleetMap has published: `{ layers, stranded }`. */
export function useMapPublished() {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const handlers = { focus: null, filter: null, playback: null, bridge: null, reveal: null };

/** FleetMap: register (or, with null, withdraw) the handler for a command. */
export function registerMapCommand(name, fn) {
  if (name in handlers) handlers[name] = fn ?? null;
}

/** Run a command if the map has registered one. */
export function runMapCommand(name, ...args) {
  return handlers[name]?.(...args);
}

/** Tests: back to an empty bridge. */
export function resetMapBridge() {
  published = { layers: EMPTY, stranded: EMPTY };
  Object.keys(handlers).forEach((k) => { handlers[k] = null; });
  listeners.forEach((l) => l());
}
