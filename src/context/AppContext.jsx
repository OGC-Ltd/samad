// Global app state: company, theme, active tabs, filters.
//
// The state itself lives in the Redux store (store/appSlice) and the company
// roster in the query cache; `<AppProvider>` only runs the app-level side
// effects. Components read through narrow hooks, each re-rendering only for
// what it reads:
//
//   useAppSelector(a => a.field)   one field
//   useAppFields("a", "b")         several fields, compared one by one
//   useAppActions()                the setters; subscribes to nothing
//   useCompanies()                 activeCompany, companies, allCompanies
//   useTheme()                     themePref / darkMode (light only)
//
// There was a `useAppContext()` returning all of it at once. It subscribed to
// the WHOLE slice, so a hover-card flag re-rendered FleetMap and every
// panel; it was retired on 2026-10-02 — do not bring it back.

import { useEffect, useMemo } from "react";
import { shallowEqual, useDispatch, useSelector, useStore } from "react-redux";
import { useQuery } from "@tanstack/react-query";
import { getCompanies } from "../api/companies";
import { ORG_CODE_BY_COMPANY } from "../api/org";
import { useAuth } from "./AuthContext";
import { persistChoice } from "../lib/navMemory";
import {
  PLAIN_FIELDS, fieldSet, companyChosen, tabChosen, mobileTabChosen, fleetTypesSet, trackedIdsSet,
  incidentRequested, sitePlanRequested, selectionRestored,
} from "../store/appSlice";
import { mirrorCompany } from "../store/appPersist";

const THEME_PREF_KEY = "ft-theme-pref";

/**
 * Theme — light, and only light. `themePref` / `setThemePref` stay because the
 * account page still draws the Appearance row with Light marked on; the setter
 * accepts "light" and refuses anything else, so a caller asking for dark gets
 * the truth instead of appearing to work.
 */
const themePref = "light";
const darkMode = false;
const setThemePref = () => persistChoice(THEME_PREF_KEY, "light");
const setDarkMode = () => setThemePref("light");

/** One field of the app slice; re-renders only when it changes. */
export const useAppSelector = (pick) => useSelector((st) => pick(st.app));

/** The whole platform roster — fetched once per session. */
function useCompanyRoster() {
  const { data } = useQuery({ queryKey: ["companies"], queryFn: getCompanies, staleTime: Infinity });
  return data ?? EMPTY;
}
const EMPTY = [];

/**
 * Only the organisations this account may open. The roster is the whole
 * platform; membership decides which of it this person sees. Filtering here
 * narrows every consumer at once — the switcher, the mobile sheet, the header.
 */
function useVisibleCompanies(companies) {
  const { orgs: authOrgs, booting: authBooting } = useAuth();
  return useMemo(() => {
    if (authBooting) return EMPTY;
    const allowed = new Set(authOrgs.map((o) => o.code));
    // No membership at all sees nothing — a real state, never a fallback to all.
    return companies.filter((c) => allowed.has(ORG_CODE_BY_COMPANY[c.id] ?? String(c.id).toUpperCase()));
  }, [companies, authOrgs, authBooting]);
}

export function AppProvider({ children }) {
  const dispatch = useDispatch();
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const visibleCompanies = useVisibleCompanies(useCompanyRoster());
  const { booting: authBooting } = useAuth();

  useEffect(() => {
    /* Both keys are written, and written to light, so a browser holding
       "dark" from before is CORRECTED rather than carrying a stale value. */
    persistChoice(THEME_PREF_KEY, "light");
    persistChoice("ft-dark-mode", "false");
    // Mirrored onto <html> so the page background follows.
    document.documentElement.dataset.theme = "light";
    // The company the page loaded on, into storage and the URL — later
    // switches are written by store/appPersist.
    mirrorCompany(activeCompanyId);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A stored or link-supplied company the account cannot open is replaced by
  // the first one it can, rather than left selected and rendering blank.
  useEffect(() => {
    if (authBooting || visibleCompanies.length === 0) return;
    if (!visibleCompanies.some((c) => c.id === activeCompanyId)) {
      dispatch(companyChosen(visibleCompanies[0].id));
    }
  }, [visibleCompanies, activeCompanyId, authBooting, dispatch]);

  return children;
}

/**
 * Several fields of the app slice, as one object; re-renders only when one of
 * THOSE fields changes (compared field by field, not by the object's identity).
 *
 *   const { activeCompanyId, desktopActiveTab } = useAppFields("activeCompanyId", "desktopActiveTab");
 */
export function useAppFields(...names) {
  return useSelector((st) => Object.fromEntries(names.map((n) => [n, st.app[n]])), shallowEqual);
}

/**
 * The setters, without subscribing to any state: a component that only WRITES
 * never re-renders on account of the app slice. Stable for the life of the
 * store, as useState's were, and each takes a value or an updater applied to
 * the CURRENT state (never a rendered copy).
 */
export function useAppActions() {
  const dispatch = useDispatch();
  const store = useStore();
  return useMemo(() => {
    const current = (field) => store.getState().app[field];
    const resolve = (field, v) => (typeof v === "function" ? v(current(field)) : v);
    const plain = Object.fromEntries(PLAIN_FIELDS.map((field) => [
      `set${field[0].toUpperCase()}${field.slice(1)}`,
      (v) => dispatch(fieldSet(field, resolve(field, v))),
    ]));
    return {
      ...plain,
      setActiveCompanyId: (v) => dispatch(companyChosen(resolve("activeCompanyId", v))),
      // Not a plain set: leaving the map clears it (appSlice tabChosen).
      setDesktopActiveTab: (v) => dispatch(tabChosen(resolve("desktopActiveTab", v))),
      setMobileActiveTab: (v) => dispatch(mobileTabChosen(resolve("mobileActiveTab", v))),
      setFleetTypes: (v) => dispatch(fleetTypesSet(resolve("fleetTypes", v))),
      setTrackedIds: (v) => dispatch(trackedIdsSet(resolve("trackedIds", v))),
      requestIncident: (vehicleId) => dispatch(incidentRequested(vehicleId)),
      requestSitePlan: (id, kind = "site") => dispatch(sitePlanRequested({ id, kind })),
      markSelectionRestored: (found) => dispatch(selectionRestored({ found })),
    };
  }, [dispatch, store]);
}

/**
 * The organisations: `companies` is the roster this account may open (what
 * every switcher shows), `allCompanies` the whole platform's, `activeCompany`
 * the open one's record. Subscribes to the active company id only.
 */
export function useCompanies() {
  const allCompanies = useCompanyRoster();
  const companies = useVisibleCompanies(allCompanies);
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const activeCompany = useMemo(
    () => companies.find((c) => c.id === activeCompanyId) || companies[0],
    [companies, activeCompanyId],
  );
  return useMemo(() => ({ activeCompany, companies, allCompanies }), [activeCompany, companies, allCompanies]);
}

/** The theme — light only; see the note on `themePref` above. */
export const useTheme = () => THEME;
const THEME = { themePref, setThemePref, darkMode, setDarkMode };
