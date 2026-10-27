// App-wide navigation and selection: which organisation, which tab, which
// vehicle, which filters — what context/AppContext used to hold in useState.
//
// Reducers stay pure. Reading storage happens in two places only: here, once,
// to build the initial state (loadAppState), and in companyChosen's prepare
// step, which fetches the NEW organisation's own funnel and tracked units so
// the switch and the swap are one action and never disagree. Writing storage
// and the URL is store/appPersist's job, keyed off these actions.

import { createSlice } from "@reduxjs/toolkit";
import { restoreChoice, restoreOverlay } from "../lib/navMemory";

// ── Where the user was, across a refresh ───────────────────────────────────
//
// Every id that may be restored is listed here, and anything else is thrown
// away rather than trusted: a tab renamed or dropped in a later release would
// otherwise be read back out of storage and select a screen that no longer
// renders. An unknown value costs the user their last tab; a trusted one
// costs them the app.
// Every page in the sidebar (SidePanel's NAV_ITEMS) belongs here, or a reload
// on it lands on the map instead — Fuel Audit and Fuel Report did, until
// 2026-10-02. appSlice.test.js fails if the two lists drift apart.
export const DESKTOP_TABS = ["fleet", "alerts", "drivers", "dashcam"];
export const MOBILE_TABS  = ["home", "map", "search", "drivers"];
// "users" is deliberately gone: User Accounts moved to the avatar menu.
export const MAINT_VIEWS  = ["service", "sensors"];

export const DESKTOP_TAB_KEY = "ft-desktop-tab";
export const MOBILE_TAB_KEY  = "ft-mobile-tab";
export const MAINT_VIEW_KEY  = "ft-maint-view";
// The two full-screen pages over the app: per browser TAB (sessionStorage) —
// see lib/navMemory.
export const ACCOUNT_OPEN_KEY    = "ft-account-open";
export const USER_ADMIN_OPEN_KEY = "ft-user-admin-open";
export const ACTIVE_COMPANY_KEY  = "ft-active-company";

/** The Fleets funnel and the tracked units are per ORGANISATION: a plate or a
 *  machine type only means something inside one fleet. */
export const fleetTypesKey = (orgId) => `ft-fleet-types:${orgId}`;
export const trackedUnitsKey = (orgId) => `ft-tracked-units:${orgId}`;
/** The unit selected on the map, per company and per browser TAB
 *  (sessionStorage): a reload comes back to it; tomorrow does not. */
export const selectedVehicleKey = (orgId) => `ft-selected-vehicle:${orgId}`;

function restoreSelected(orgId) {
  try {
    const v = sessionStorage.getItem(selectedVehicleKey(orgId));
    return v && v.length < 200 ? v : null;
  } catch {
    return null;
  }
}

/** A saved list of strings, or [] — storage can throw rather than return null. */
function restoreStringList(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "null");
    return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
  } catch {
    return [];
  }
}

const restoreOrgLists = (orgId) => ({
  fleetTypes: restoreStringList(fleetTypesKey(orgId)),
  trackedIds: restoreStringList(trackedUnitsKey(orgId)),
});

/** Selection and filters that belong to one organisation's fleet. */
const resetForOrg = (state, lists) => {
  // A selected vehicle, or a feed scoped to one, belongs to ONE fleet —
  // carried across a switch it points at a unit the new fleet lacks.
  state.selectedVehicleId = null;
  state.feedVehicleId = null;
  state.fleetTypes = lists.fleetTypes;
  state.trackedIds = lists.trackedIds;
};

const defaults = {
  activeCompanyId: "samad",
  // The organisation open before this one — set by any switch, including the
  // ones the operator did not ask for (a plate search that hands the dashboard
  // to another tenant), so "back" is something the app knows. Session only.
  previousCompanyId: null,
  selectedVehicleId: null,
  // The selection a reload brought back, until FleetMap has put it back on
  // the map (highlight, card, camera) or found the unit gone. Never stored.
  restoredVehicleId: null,
  // Set by any page to ask FleetMap to fly to a vehicle; FleetMap clears it.
  pendingFocusId: null,
  // Which vehicle the Live Feed is scoped to. NOT the selection: only a
  // marker click scopes the feed; a feed row or a search just selects.
  feedVehicleId: null,
  // Is a floating window committed open over the map? Transient surfaces (the
  // hover card) yield to it. A boolean, not a count, so it cannot leak.
  windowOpen: false,
  // `{ id, n }`: asking twice for the same unit must be two requests.
  incidentRequest: null,
  // The fuel alert whose incident window is open, so FleetMap can draw its
  // route and drive zones (IncidentInvestigation). Null when none is.
  openIncidentId: null,
  // The surveys and weighbridges the map offers (published by FleetMap, read
  // by the header), and a counted request to fly to one.
  sitePlanLinks: [],
  sitePlanRequest: null,
  mobileActiveTab: "home",
  // The map mounts lazily on first visit to the Map tab; a session restored
  // straight onto it must count as that visit.
  mapEverMounted: false,
  desktopActiveTab: "fleet",
  // Default "sensors": Service Status is behind a flag.
  maintenanceView: "sensors",
  activeRange: "Today",
  analyticsView: "Fleet",
  accountOpen: false,
  userAdminOpen: false,
  // [] is "every type" / "the whole fleet", never "nothing". Arrays, not
  // Sets: they are stored as JSON and compared by memo deps.
  fleetTypes: [],
  trackedIds: [],
  // A momentary lens — deliberately never persisted.
  inTransitOnly: false,
  // Counts each time the person left the map for another page (tabChosen).
  // FleetMap clears what it holds itself (pinned card, trip path, playback,
  // investigation, arrivals, camera, measuring) when this changes.
  mapClearN: 0,
};

/**
 * Leaving the map for another page clears it (operator, 2026-10-20: "we need
 * to make sure that we clear the map from any modals cards or components
 * whenever we navigate from page to page"): coming back shows a bare map, and
 * a card or window is there again only when it is opened again. Clears the
 * selection, the Live Feed's scope, the incident window and any focus still
 * waiting. The fleet filters and tracked units are lenses, not cards, and stay.
 */
function clearMapSurfaces(state) {
  state.selectedVehicleId = null;
  state.restoredVehicleId = null;
  state.pendingFocusId = null;
  state.feedVehicleId = null;
  state.openIncidentId = null;
  state.mapClearN += 1;
}

/**
 * The state a page load starts from: an explicit ?company= link wins, then the
 * last saved company, then the default; tabs and overlays as they were left.
 */
export function loadAppState() {
  if (typeof window === "undefined") return {};
  let activeCompanyId = defaults.activeCompanyId;
  try {
    activeCompanyId = new URLSearchParams(window.location.search).get("company")
      || localStorage.getItem(ACTIVE_COMPANY_KEY) || defaults.activeCompanyId;
  } catch { /* storage unavailable */ }
  const mobileActiveTab = restoreChoice(MOBILE_TAB_KEY, MOBILE_TABS, "home");
  const selectedVehicleId = restoreSelected(activeCompanyId);
  return {
    activeCompanyId,
    selectedVehicleId,
    restoredVehicleId: selectedVehicleId,
    ...restoreOrgLists(activeCompanyId),
    mobileActiveTab,
    mapEverMounted: mobileActiveTab === "map",
    desktopActiveTab: restoreChoice(DESKTOP_TAB_KEY, DESKTOP_TABS, "fleet"),
    maintenanceView: restoreChoice(MAINT_VIEW_KEY, MAINT_VIEWS, "sensors"),
    accountOpen: restoreOverlay(ACCOUNT_OPEN_KEY),
    userAdminOpen: restoreOverlay(USER_ADMIN_OPEN_KEY),
  };
}

/** Fields with nothing more to them than "set this value". */
export const PLAIN_FIELDS = [
  "selectedVehicleId", "pendingFocusId", "feedVehicleId", "windowOpen", "sitePlanLinks",
  "desktopActiveTab", "maintenanceView", "activeRange", "analyticsView",
  "accountOpen", "userAdminOpen", "inTransitOnly", "openIncidentId",
];

const appSlice = createSlice({
  name: "app",
  initialState: defaults,
  reducers: {
    fieldSet: {
      reducer(state, { payload: { field, value } }) {
        if (PLAIN_FIELDS.includes(field)) state[field] = value;
      },
      prepare: (field, value) => ({ payload: { field, value } }),
    },
    companyChosen: {
      reducer(state, { payload: { id, lists } }) {
        if (!id || id === state.activeCompanyId) return;
        state.previousCompanyId = state.activeCompanyId;
        state.activeCompanyId = id;
        state.restoredVehicleId = null;
        resetForOrg(state, lists);
      },
      // The new organisation's own funnel and tracked units, read as the
      // action is made so the reducer stays pure.
      prepare: (id) => ({ payload: { id, lists: restoreOrgLists(id) } }),
    },
    /** A page picked. Any page but the map clears the map first; going TO
     *  the map keeps what the caller asked it to show (a focus, an incident). */
    tabChosen(state, { payload }) {
      if (!payload || payload === state.desktopActiveTab) return;
      if (payload !== "fleet") clearMapSurfaces(state);
      state.desktopActiveTab = payload;
    },
    mobileTabChosen(state, { payload }) {
      if (payload === "map") state.mapEverMounted = true;
      state.mobileActiveTab = payload;
    },
    fleetTypesSet(state, { payload }) {
      state.fleetTypes = Array.isArray(payload) ? payload : [];
    },
    trackedIdsSet(state, { payload }) {
      state.trackedIds = Array.isArray(payload) ? [...new Set(payload)] : [];
    },
    /** FleetMap has put the reloaded selection back — or found it gone, and
     *  then the selection goes too rather than open an empty panel. */
    selectionRestored(state, { payload: { found } }) {
      if (!found && state.selectedVehicleId === state.restoredVehicleId) state.selectedVehicleId = null;
      state.restoredVehicleId = null;
    },
    incidentRequested(state, { payload }) {
      state.incidentRequest = { id: payload, n: (state.incidentRequest?.n ?? 0) + 1 };
    },
    sitePlanRequested(state, { payload: { id, kind = "site" } }) {
      state.sitePlanRequest = { id, kind, n: (state.sitePlanRequest?.n ?? 0) + 1 };
    },
  },
});

export const {
  fieldSet, companyChosen, tabChosen, mobileTabChosen, fleetTypesSet, trackedIdsSet,
  incidentRequested, sitePlanRequested, selectionRestored,
} = appSlice.actions;
export default appSlice.reducer;
