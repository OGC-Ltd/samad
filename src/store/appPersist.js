// Where the app slice is remembered: the nav choices in localStorage, the
// overlay pages in sessionStorage, the organisation in localStorage AND the
// URL (so a copied link lands on the same company).
//
// Driven by state changes, field by field — except the per-organisation
// lists, which are written only by the action that SET them, under the org
// that was active then. Written on a company switch they would stamp one
// fleet's list onto the other's key.

import { persistChoice, persistOverlay } from "../lib/navMemory";
import {
  DESKTOP_TAB_KEY, MOBILE_TAB_KEY, MAINT_VIEW_KEY, ACCOUNT_OPEN_KEY, USER_ADMIN_OPEN_KEY,
  ACTIVE_COMPANY_KEY, fleetTypesKey, trackedUnitsKey, fleetTypesSet, trackedIdsSet,
  selectedVehicleKey,
} from "./appSlice";

/** Per browser tab, under the company it belongs to; cleared when nothing is selected. */
function persistSelected(companyId, vehicleId) {
  try {
    if (vehicleId) sessionStorage.setItem(selectedVehicleKey(companyId), vehicleId);
    else sessionStorage.removeItem(selectedVehicleKey(companyId));
  } catch { /* storage unavailable — the app works, it just won't remember */ }
}

/** Put the company in storage and the address bar, without a navigation. */
export function mirrorCompany(id) {
  persistChoice(ACTIVE_COMPANY_KEY, id);
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (url.searchParams.get("company") !== id) {
    url.searchParams.set("company", id);
    window.history.replaceState(null, "", url);
  }
}

const FIELDS = [
  ["desktopActiveTab", (v) => persistChoice(DESKTOP_TAB_KEY, v)],
  ["mobileActiveTab", (v) => persistChoice(MOBILE_TAB_KEY, v)],
  ["maintenanceView", (v) => persistChoice(MAINT_VIEW_KEY, v)],
  // Written on close as well as open, or a stale "1" reopens it forever.
  ["accountOpen", (v) => persistOverlay(ACCOUNT_OPEN_KEY, v)],
  ["userAdminOpen", (v) => persistOverlay(USER_ADMIN_OPEN_KEY, v)],
  ["activeCompanyId", mirrorCompany],
];

export function startAppPersist(listener) {
  listener.startListening({
    predicate: (_a, now, before) => now.app !== before.app,
    effect: (action, api) => {
      const now = api.getState().app;
      const before = api.getOriginalState().app;
      for (const [field, save] of FIELDS) if (now[field] !== before[field]) save(now[field]);
      // Under the company now open: a switch clears the selection, and with it
      // the new company's stored one — which is right, the switch was a fresh
      // start there.
      if (now.selectedVehicleId !== before.selectedVehicleId) persistSelected(now.activeCompanyId, now.selectedVehicleId);
      if (fleetTypesSet.match(action)) persistChoice(fleetTypesKey(now.activeCompanyId), JSON.stringify(now.fleetTypes));
      if (trackedIdsSet.match(action)) persistChoice(trackedUnitsKey(now.activeCompanyId), JSON.stringify(now.trackedIds));
    },
  });
}
