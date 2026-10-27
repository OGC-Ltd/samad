// State management.
//
//   Server data  → TanStack Query (store/queryClient). Anything fetched from the
//                  API is cached, deduplicated, polled and refreshed there —
//                  hooks/useApiData is a thin layer over useQuery.
//   Client state → Redux Toolkit (this store). What the operator picked and how
//                  they like a page laid out; one slice per screen or concern.
//
// Slices: `app` (organisation, tabs, selection, map filters — read through
// context/AppContext's narrow hooks), `map` (the map's filter and window
// flags — read through context/MapLayersContext's useMapLayers, alongside
// lib/mapBridge for what is not a plain value) and `fuelReport`.
//
// Server state in the query cache, besides useApiData's entries: the signed-in
// user (context/AuthContext, authKeys) and the live fleet (hooks/useFleetLive,
// fleetKeys — the SSE stream writes into it).

import { configureStore, createListenerMiddleware } from "@reduxjs/toolkit";
import app, { loadAppState } from "./appSlice";
import fuelReport from "./fuelReportSlice";
import map from "./mapSlice";
import { loadPrefs, savePrefs } from "./persist";
import { startAppPersist } from "./appPersist";

const reducer = { app, map, fuelReport };

/** A fresh store — the app's own below, and a clean one per test. */
export function makeStore(preloaded) {
  const persist = createListenerMiddleware();
  persist.startListening({
    predicate: (_action, now, before) => now.fuelReport !== before.fuelReport,
    effect: (_action, api) => savePrefs(api.getState()),
  });
  startAppPersist(persist);
  const base = preloaded ?? {};
  return configureStore({
    reducer,
    preloadedState: Object.fromEntries(Object.keys(reducer).map((k) => [
      k, { ...reducer[k](undefined, { type: "@@init" }), ...base[k] },
    ])),
    middleware: (getDefault) => getDefault().prepend(persist.middleware),
  });
}

export const store = makeStore({ ...loadPrefs(), app: loadAppState() });
