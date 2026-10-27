// Fuel › Report: what the operator picked and how they like the page laid out.
//
// Two kinds of state, kept apart:
//   - the period and the request last executed live for the session, so
//     leaving the page and coming back shows the same report — the report
//     itself is in the query cache under the request's key;
//   - the unit last picked, per organisation, the period PRESET last picked,
//     and the layout (header folded, chart layers) are this viewer's
//     preferences, persisted by store/persist. Per organisation because a unit
//     only exists inside one fleet; the preset rather than its dates because
//     "Yesterday" should mean yesterday on the day the page is opened.

import { createSlice } from "@reduxjs/toolkit";

export const FUEL_REPORT_PREFS = ["unitByOrg", "presetId", "headerCollapsed", "bg", "lines", "marks"];

/** The period presets, in the order the chips show them. */
export const PERIOD_PRESETS = ["today", "yesterday", "week", "month"];

const initialState = {
  unitByOrg: {},          // { [orgId]: vehicleId } — the unit last picked there
  span: null,            // { from, to, id } as datetime-local strings; null = from presetId
  presetId: "today",     // the preset last picked — kept when dates are typed by hand
  request: null,         // { unitId, from, to } ms — the last Execute
  tab: "graph",
  headerCollapsed: false,
  bg: { trip: true, parking: true, stop: true },
  lines: { fuelL: true, fuelSmoothL: false, speedKmh: false, mileageKm: false, altitudeM: false, extVoltageV: false, intVoltageV: false, engineOn: true },
  marks: { fill: true, drain: true, stop: true },
  // Session only (not in FUEL_REPORT_PREFS). Per organisation: whether the
  // operator has picked or run anything this session — until they have, the
  // page opens on lib/fuelReportDefault's pick — and that pick, so the page
  // can say why it is showing this unit.
  touched: {},           // { [orgId]: true }
  autoPick: {},          // { [orgId]: { unitId, from, to, reason, at?, litres?, km? } }
};

const fuelReportSlice = createSlice({
  name: "fuelReport",
  initialState,
  reducers: {
    unitChosen: {
      reducer(state, { payload: { orgId, unitId } }) {
        if (!orgId) return;
        state.touched[orgId] = true;
        if (unitId) state.unitByOrg[orgId] = unitId;
        else delete state.unitByOrg[orgId];
      },
      prepare: (orgId, unitId) => ({ payload: { orgId, unitId: unitId ?? null } }),
    },
    spanChosen(state, { payload }) {
      state.span = payload;
      // Hand-typed dates (id null) are this visit's; the preset stays the one
      // the page opens on next time.
      if (PERIOD_PRESETS.includes(payload?.id)) state.presetId = payload.id;
    },
    executed(state, { payload }) {
      state.request = payload;
      if (payload?.orgId) state.touched[payload.orgId] = true;
    },
    /** The default pick, applied as a pick and a run, remembered with its reason. */
    autoPicked(state, { payload: { orgId, pick } }) {
      if (!orgId || state.touched[orgId]) return;
      state.touched[orgId] = true;
      state.unitByOrg[orgId] = pick.unitId;
      state.autoPick[orgId] = pick;
      state.span = { from: pick.fromInput, to: pick.toInput, id: null };
      state.request = { orgId, unitId: pick.unitId, from: pick.from, to: pick.to };
    },
    tabChosen(state, { payload }) { state.tab = payload; },
    headerToggled(state) { state.headerCollapsed = !state.headerCollapsed; },
    // Keyed by the DEFAULTS, not the saved copy: a viewer whose preferences
    // were saved before a line existed can still switch it on.
    layerToggled(state, { payload: { group, key } }) {
      const base = initialState[group];
      if (!base || typeof base !== "object" || !(key in base)) return;
      state[group] = { ...base, ...state[group] };
      state[group][key] = !state[group][key];
    },
    /** "All lines": every graph line on, or every one off. */
    allLinesSet(state, { payload: on }) {
      state.lines = Object.fromEntries(Object.keys(initialState.lines).map((k) => [k, Boolean(on)]));
    },
  },
});

export const { unitChosen, spanChosen, executed, autoPicked, tabChosen, headerToggled, layerToggled, allLinesSet } = fuelReportSlice.actions;

/** The graph lines with their defaults filled in under what was saved. */
export const linesWithDefaults = (saved) => ({ ...initialState.lines, ...saved });
export default fuelReportSlice.reducer;
