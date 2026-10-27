// One live fleet, shared app-wide. The fleet itself lives in the TanStack Query
// cache (hooks/useFleetLive's fleetKeys), but the SSE stream that keeps it
// current must be opened ONCE — this provider mounts it for the active company.
// It also applies the dismissed-incident filter once, here, rather than in each
// of the ~36 components that read the fleet (vehicles update on every SSE
// position flush, so doing it per reader would repeat it per frame).

import { createContext, useContext, useMemo } from "react";
import { useFleetLive } from "../hooks/useFleetLive";
import { useAppSelector } from "./AppContext";
import { useDismissedIncidents, withoutDismissed } from "../lib/fuelDismissals";
import { deriveStatus } from "../lib/vehicleMap";
import { usePermissions } from "../hooks/usePermissions";

// A technician's Live Feed is the repair notices on their flagged units; the
// server sends only those, and this drops any tracking items a browser kept
// from before (operator, 2026-10-27).
const REPAIR_SOURCES = new Set(["repair", "repair_flag", "repair_verified"]);
const repairOnly = (feed) => feed?.filter((f) => REPAIR_SOURCES.has(f?.source)) ?? feed;

const FleetLiveContext = createContext(null);

export function FleetLiveProvider({ children }) {
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const { flaggedOnly, vehicleIds } = usePermissions();
  const live = useFleetLive(activeCompanyId, { keepFeed: flaggedOnly });
  // Incidents deleted in the incident window leave the fleet here, once, so the
  // alerts list, the map, the side panel and the window all drop them together.
  // UI only: see lib/fuelDismissals.
  const dismissed = useDismissedIncidents();
  // A technician's fleet is the units flagged for repair, everywhere a list,
  // a count or a type chip reads it (operator, 2026-10-27). The server sends
  // only those; this also keeps a fleet cached in the browser from before out.
  const flagged = useMemo(() => (flaggedOnly && vehicleIds ? new Set(vehicleIds) : null), [flaggedOnly, vehicleIds]);
  const vehicles = useMemo(() => {
    const kept = withoutDismissed(live.vehicles, dismissed, deriveStatus);
    return flagged && kept ? kept.filter((v) => flagged.has(v.vehicleId)) : kept;
  }, [live.vehicles, dismissed, flagged]);
  const feed = useMemo(() => (flaggedOnly ? repairOnly(live.feed) : live.feed), [flaggedOnly, live.feed]);
  const fleet = useMemo(
    () => (vehicles === live.vehicles && feed === live.feed ? live : { ...live, vehicles, feed }),
    [live, vehicles, feed],
  );
  return <FleetLiveContext.Provider value={fleet}>{children}</FleetLiveContext.Provider>;
}

/** { vehicles, orgId, loading, error, retry, feed } for the active company. */
export function useFleetLiveShared() {
  const ctx = useContext(FleetLiveContext);
  if (!ctx) throw new Error("useFleetLiveShared must be used inside FleetLiveProvider");
  return ctx;
}
