// Header KPI summary — port of fleetdash's useDashboard onto fleettrack's
// company-slug world. Polls /dashboard/summary every 30 s (matching the
// telemetry poll cadence) and SWR-caches per company so the header stats paint
// instantly on reload / org switch. Powers the Topbar-style KPI buttons:
//   summary.storage   — sugar in silos (Sukari only — others have no silos)
//   summary.inTransit — vehicles moving + tonnes aboard (overridden live in
//                       SukariHeader from the shared fleet stream)
//   summary.sensors   — per-sensor-type configured vs. operational

import { useState, useEffect } from "react";
import { apiFetch } from "../services/api";
import { resolveOrgId } from "../api/org";
import { readCache, writeCache } from "../services/cache";

const summaryCacheKey = (companyId) => `ft-summary:${companyId}`;

export function useDashboardSummary(companyId) {
  const [summary, setSummary] = useState(
    () => (companyId && readCache(summaryCacheKey(companyId))) || null
  );

  // Swap during render, not in the effect below: effects run after paint, so
  // the KPI tiles showed the previous company's figures for a frame.
  const [stateCompanyId, setStateCompanyId] = useState(companyId);
  if (stateCompanyId !== companyId) {
    setStateCompanyId(companyId);
    setSummary((companyId && readCache(summaryCacheKey(companyId))) || null);
  }

  useEffect(() => {
    if (!companyId) return;
    let alive = true;

    // Instant paint from the last-known summary for this company (also clears
    // stale numbers on org switch when there's no cache yet).
    setSummary(readCache(summaryCacheKey(companyId)) || null);

    const load = () =>
      resolveOrgId(companyId)
        .then((orgId) => {
          if (!alive || !orgId) return;
          return apiFetch(`/api/v1/organisations/${orgId}/dashboard/summary`).then((res) => {
            if (!alive) return;
            setSummary(res.data);
            writeCache(summaryCacheKey(companyId), res.data);
          });
        })
        .catch(() => { /* keep showing the cached summary */ });

    load();
    const timer = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(timer); };
  }, [companyId]);

  return summary;
}
