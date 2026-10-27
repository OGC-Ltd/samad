// The map's shared UI state — what used to be MapLayersContext's useState.
//
// Only plain values live here. The things FleetMap hands out that are not
// values — the layer rows (each carries its own onToggle), the stranded list
// (live vehicle objects the feed keeps updating, which the store would
// freeze), and the commands it registers (focus, filter, playback, reveal) —
// live in lib/mapBridge instead.
//
// `activeFilter` is PUBLISHED by FleetMap: the map is the only thing that
// knows which filter is really applied (it clears it itself on an org switch
// and a refit), so the sidebar cards and the mobile rail highlight from this
// one value and change it through the map's applyFilter, never directly.

import { createSlice } from "@reduxjs/toolkit";
import { tabChosen } from "./appSlice";

/** Windows that sit on the map but are opened from elsewhere (the sidebar). */
export const MAP_WINDOWS = ["unitsOpen", "strandedOpen", "fuelAlertsOpen"];

const mapSlice = createSlice({
  name: "map",
  initialState: {
    activeFilter: "all",
    unitsOpen: false,
    strandedOpen: false,
    fuelAlertsOpen: false,
  },
  reducers: {
    filterPublished(state, { payload }) { state.activeFilter = payload ?? "all"; },
    windowSet: {
      reducer(state, { payload: { name, open } }) {
        if (!MAP_WINDOWS.includes(name)) return;
        // One window on the map at a time (operator, 2026-10-02: Units,
        // Stopped in transit and Fuel alerts open together, with a unit card
        // on top, was three panels over the thing they describe). Opening one
        // closes the others; FleetMap drops its pinned card on the same edge.
        if (open) for (const w of MAP_WINDOWS) state[w] = false;
        state[name] = Boolean(open);
      },
      prepare: (name, open) => ({ payload: { name, open } }),
    },
  },
  extraReducers: (builder) => {
    // Leaving the map for another page closes its windows (appSlice tabChosen).
    builder.addCase(tabChosen, (state, { payload }) => {
      if (payload && payload !== "fleet") for (const w of MAP_WINDOWS) state[w] = false;
    });
  },
});

export const { filterPublished, windowSet } = mapSlice.actions;
export default mapSlice.reducer;
