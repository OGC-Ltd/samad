// The weighbridges, for the map's own layer.
//
// Cached per organisation for a first paint, then pulled again on mount and
// every couple of minutes: the scales rarely move, but a scale that starts
// reporting and each scale's last ticket should reach an open page without a
// reload. The Weighbridges screen is still where an operator goes for the live
// grid.
//
// An org with no bridges gets an empty array and the layer never offers itself.
// Only Sukari's four centres weigh anything today, but the gate is the RESPONSE
// rather than an org name: the day another mill's scales start reporting, its
// markers appear without an edit here.

import { useEffect, useState } from "react";
import { getWeighbridges } from "../api/weighments";
import { readCache, writeCache } from "../services/cache";

const cacheKey = (orgId) => `ft-weighbridges:${orgId}`;

// How often a mounted hook asks again. The scales themselves rarely change, but
// a newly reporting one, and each scale's last ticket, should reach an open
// page without a reload. Before this the first answer was kept for the whole
// session, so a bridge added mid-day never appeared until the tab was reloaded.
const REFRESH_MS = 2 * 60_000;
// A second component mounting straight after the first reuses its answer.
const FRESH_MS = 30_000;

// Module-level, so two components asking at once make one request.
const inflight = new Map();
const fetchedAt = new Map();

function load(orgId) {
  if (!inflight.has(orgId)) {
    inflight.set(
      orgId,
      getWeighbridges({ orgId })
        .then((rows) => {
          writeCache(cacheKey(orgId), rows);
          fetchedAt.set(orgId, Date.now());
          return rows;
        })
        // Dropped once settled either way: the map only dedupes requests in
        // flight. A kept promise would pin the first answer for the session.
        .finally(() => inflight.delete(orgId)),
    );
  }
  return inflight.get(orgId);
}

/**
 * @param {string|null} orgId
 * @returns {{ bridges: Array|null, loading: boolean, error: Error|null }}
 */
export function useWeighbridges(orgId) {
  // Seeded from the cache so a revisit draws immediately rather than flashing
  // an empty layer while the request is in flight.
  const [bridges, setBridges] = useState(() => (orgId ? readCache(cacheKey(orgId)) ?? null : null));
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);

  useEffect(() => {
    if (!orgId) { setBridges(null); return undefined; }

    let alive = true;
    const cached = readCache(cacheKey(orgId));
    setBridges(cached ?? null);
    setError(null);

    const pull = (force) => {
      if (!force && Date.now() - (fetchedAt.get(orgId) ?? 0) < FRESH_MS) return;
      setLoading(true);
      load(orgId)
        .then((rows) => { if (alive) { setBridges(rows); setError(null); setLoading(false); } })
        .catch((err) => { if (alive) { setError(err); setLoading(false); } });
    };
    // A cached list is only a first paint; always ask on mount unless another
    // component just did.
    pull(cached == null);
    const timer = setInterval(() => pull(true), REFRESH_MS);

    return () => { alive = false; clearInterval(timer); };
  }, [orgId]);

  return { bridges, loading, error };
}
