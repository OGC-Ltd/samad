// Per-viewer preferences out of the Redux store and into localStorage, and back.
//
// Only the fields a slice names as preferences are kept — never a selection or
// anything from the server. Storage is best-effort: private mode, a full quota
// or a corrupt entry all read as "nothing kept", never as a broken page.

import { FUEL_REPORT_PREFS, PERIOD_PRESETS } from "./fuelReportSlice";

const KEY = "ft-prefs";
const LEGACY_HEADER_KEY = "ft-fuel-report-header-collapsed";

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj[k]]));

/** The kept preferences, shaped as a partial preloaded state per slice. */
export function loadPrefs() {
  let kept = {};
  try { kept = JSON.parse(localStorage.getItem(KEY) ?? "{}") ?? {}; } catch { kept = {}; }
  const fuelReport = pick(kept.fuelReport, FUEL_REPORT_PREFS);
  // Only a plain { orgId: vehicleId } map is trusted back out of storage.
  const units = fuelReport.unitByOrg;
  fuelReport.unitByOrg = units && typeof units === "object" && !Array.isArray(units)
    ? Object.fromEntries(Object.entries(units).filter(([, v]) => typeof v === "string"))
    : {};
  if (fuelReport.presetId !== undefined && !PERIOD_PRESETS.includes(fuelReport.presetId)) delete fuelReport.presetId;
  // Carried over from before the store: the fold was its own key.
  if (fuelReport.headerCollapsed === undefined) {
    try { if (localStorage.getItem(LEGACY_HEADER_KEY) === "1") fuelReport.headerCollapsed = true; } catch { /* none */ }
  }
  return { fuelReport };
}

export function savePrefs(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ fuelReport: pick(state.fuelReport, FUEL_REPORT_PREFS) }));
  } catch { /* not kept */ }
}
