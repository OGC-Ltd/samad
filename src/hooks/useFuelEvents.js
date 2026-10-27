// useFuelEvents.js — Fuel fillings + thefts for FSL pattern analysis
// ADDED 2026-08-07
//
// Calls the REAL backend endpoints:
//   GET /api/v1/organisations/:orgId/fuel/fillings?from=<24h ago>&limit=200
//   GET /api/v1/organisations/:orgId/fuel/thefts?from=<24h ago>&limit=200
//
// Returns a merged, sorted list of all fuel events across the fleet
// in the last 24 hours, tagged by type (refill | drain).
//
// Per-vehicle filtering is done client-side so we only need 2 API calls
// instead of one per vehicle.

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "../services/api";

/**
 * Verdict reasons that mean our OWN telemetry watched the outcome, rather than
 * the provider's claim being relayed because we could not check it.
 *
 * Mirrors CONFIRMED_REASONS in the server's modules/fuel/fuel-adjudication.ts.
 * The server derives confirmation from `verdictReason` rather than storing it,
 * so a second column can never disagree with the first — and the same trick
 * works here, which is why this is a set of reasons and not a boolean on the
 * wire.
 */
const CONFIRMED_REASONS = new Set(["level-stayed-down", "level-recovered"]);

/**
 * Fleet days are KENYAN, not UTC, and not the viewer's browser timezone.
 *
 * A drain at 01:00 EAT belongs to that day's shift; bucketing it by UTC would
 * file it under the previous one, and by browser timezone would mean two people
 * looking at the same table on the same morning saw different days. The server
 * buckets on Africa/Nairobi (lib/provider-time `fleetDayStart`) and this has to
 * agree with it or the totals will not reconcile.
 */
const FLEET_OFFSET_H = 3;

/** "2026-08-13" for the fleet day containing `d`. */
export function fleetDayKey(d = new Date()) {
  return new Date(d.getTime() + FLEET_OFFSET_H * 3600_000).toISOString().slice(0, 10);
}

/** [start, end) of a fleet day, as UTC instants. */
function fleetDayRange(dayKey) {
  const start = new Date(`${dayKey}T00:00:00.000Z`).getTime() - FLEET_OFFSET_H * 3600_000;
  return { from: new Date(start), to: new Date(start + 86_400_000) };
}

/**
 * Fuel events for ONE fleet day, defaulting to today.
 *
 * Was a rolling 24 hours, which meant the table never lined up with a shift:
 * at 14:00 it showed half of yesterday, and no two people opening it an hour
 * apart saw the same set. A day is the unit operations actually works in.
 */
export function useFuelEvents(orgId, dayKey = fleetDayKey()) {
  const [events,  setEvents]  = useState([]);
  /**
   * vehicleId -> { initialMl, currentMl, consumedMl, turbulenceMl }.
   * A stop is the engine going off; see the server's fuel-tank-state.
   */
  const [tankState, setTankState] = useState({});
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState(null);
  /**
   * The day the rows in `events` belong to.
   *
   * A new day is asked for on the render AFTER the picker changes, and until it
   * answers `events` still holds the previous day. `loading` cannot say so on
   * that first render — the effect that sets it has not run yet — so a reader
   * that must never show one day's rows under another day's date compares this
   * with the day it asked for.
   */
  const [loadedDay, setLoadedDay] = useState(null);
  const abortRef = useRef(null);
  /**
   * Bumped by `reload`, and read as an effect dependency.
   *
   * The tab's Refresh button needs to re-run a fetch whose inputs have not
   * changed — same org, same day — and an effect keyed only on those two will
   * not fire again. A nonce is the whole mechanism: no second code path, so a
   * refetch is byte-for-byte the fetch the mount did.
   */
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce(n => n + 1), []);

  useEffect(() => {
    if (!orgId) return;

    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    setLoading(true);
    setError(null);

    const { from: dayFrom, to: dayTo } = fleetDayRange(dayKey);
    const from = dayFrom.toISOString();
    const to   = dayTo.toISOString();
    const isToday = dayKey === fleetDayKey();

    Promise.all([
      apiFetch(`/api/v1/organisations/${orgId}/fuel/fillings?from=${from}&to=${to}&limit=200`, { signal: ctrl.signal }),
      apiFetch(`/api/v1/organisations/${orgId}/fuel/thefts?from=${from}&to=${to}&limit=200`,  { signal: ctrl.signal }),
      // Whole fleet in one call — a per-vehicle endpoint would fire 200
      // requests against a 100 req/60s limit.
      // For a past day the tank is read as it stood at that day's END, so the
      // Initial/Current pair matches the events beside it. Today has no end yet.
      apiFetch(`/api/v1/organisations/${orgId}/fuel/tank-state${isToday ? '' : `?date=${dayKey}`}`,
        { signal: ctrl.signal }).catch(() => ({ data: [] })),
    ])
      .then(([fillRes, theftRes, tankRes]) => {
        if (ctrl.signal.aborted) return;
        setTankState(Object.fromEntries((tankRes.data ?? []).map(t => [t.vehicleId, t])));

        const fillings = (fillRes.data ?? []).map(f => ({
          vehicleId:  f.vehicleId,
          type:       "refill",
          at:         new Date(f.filledAt).getTime(),
          atIso:      f.filledAt,
          litres:     f.filledMl  != null ? +(f.filledMl  / 1000).toFixed(1) : null,
          location:   f.location  ?? null,
          // ADDED 2026-08-11: fillings are adjudicated now too. A REDISTRIBUTION
          // here means fuel was supposedly added and the tank is no fuller for
          // it — the up-swing of an oscillating probe, logged by the provider as
          // a delivery. 307 of 5,794 rows, claiming 13,075 L that never arrived
          // while the tanks collectively fell 3,689 L.
          verdict:      f.verdict ?? null,
          verdictReason: f.verdictReason ?? null,
          // What OUR telemetry saw arrive, against f.filledMl claimed.
          observedMl:   f.observedRiseMl ?? null,
          confirmed:    f.verdictReason === "level-rose",
        }));

        const thefts = (theftRes.data ?? []).map(t => ({
          vehicleId:  t.vehicleId,
          type:       "drain",
          at:         new Date(t.beganAt ?? t.detectedAt).getTime(),
          atIso:      t.beganAt ?? t.detectedAt,
          litres:     t.stolenMl != null ? +(t.stolenMl / 1000).toFixed(1) : null,
          location:   t.initialLocation ?? null,
          speedAtEvent: t.initialSpeedKmh ?? null,
          // ADDED 2026-08-08: the server's verdict on whether the fuel actually
          // left the tank. This was being dropped, and the table below re-derived
          // a far cruder answer from the SHAPE of the event sequence — see
          // flaggedVehicles. The endpoint has carried these three fields all
          // along; fuel-adjudication.ts sets them by checking whether the level
          // came back (60% of the drop, judged 20 min after detection).
          // CHANGED 2026-08-11: LOSS and UNVERIFIED are gone. The verdict now
          // describes what happened to the fuel and nothing else; how sure the
          // server is rides alongside in `confirmed`, derived from the reason.
          verdict:     t.verdict ?? null,          // REFILL | DRAIN | REDISTRIBUTION | SENSOR_FAULT | PENDING
          recoveredMl: t.recoveredMl ?? null,
          verdictReason: t.verdictReason ?? null,  // e.g. 'level-recovered'
          confirmed:   CONFIRMED_REASONS.has(t.verdictReason ?? ""),
        }));

        // Merge and sort newest first
        const merged = [...fillings, ...thefts].sort((a, b) => b.at - a.at);
        setEvents(merged);
        setLoadedDay(dayKey);
        setLoading(false);
      })
      .catch(err => {
        if (err?.name === "AbortError" || ctrl.signal.aborted) return;
        setError(err.message ?? "Failed to load fuel events");
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [orgId, dayKey, nonce]);

  // Helper: get events for a specific vehicleId (cuid)
  const forVehicle = (vehicleId) => events.filter(e => e.vehicleId === vehicleId);

  /**
   * One row per vehicle, carrying the SERVER's verdict on its drains.
   *
   * CHANGED 2026-08-08: this used to score the shape of the event sequence —
   * `alternating >= 2`, where `alternating` counted type CHANGES down the list.
   * It never looked at volume, so +26 L / −26 L and +26 L / −200 L scored the
   * same; and never at elapsed time, so a ± pair 27 minutes apart scored the
   * same as one 8 hours apart. With four or five mixed events almost any
   * working machine cleared the bar, and the honest reading of most of them —
   * fuel moving in a part-full tank on undulating ground, so the probe reads
   * low and recovers — had no way to be expressed at all.
   *
   * The server already answers this properly and has all along. Each drain
   * carries a verdict from fuel-adjudication.ts, which tests whether the level
   * CAME BACK (60% of the drop, 20 minutes after detection) rather than
   * theorising about why it moved. On 2026-08-08 both of KTCC 850B's drains —
   * the pair this table was calling Inconsistent — were already REDISTRIBUTION
   * / 'level-recovered', one with 27.8 L recovered against a 27.5 L drop.
   *
   * So there is no heuristic here any more. The row reports the worst verdict
   * its drains carry, which is also the only one worth acting on.
   */
  const flaggedVehicles = () => {
    const byVehicle = {};
    for (const e of events) {
      if (!byVehicle[e.vehicleId]) byVehicle[e.vehicleId] = [];
      byVehicle[e.vehicleId].push(e);
    }

    const flagged = [];
    for (const [vehicleId, evts] of Object.entries(byVehicle)) {
      const sorted = evts.slice().sort((a, b) => a.at - b.at);
      const drains = sorted.filter(e => e.type === "drain");

      // EVERY drain is a suspicious drain, confirmed or not.
      //
      // The confirmed/unconfirmed split still exists on the server and still
      // decides how loudly a drain is announced — see fuel-adjudication's
      // `confirmed`. It is deliberately NOT a visual distinction here: fuel
      // that went down and did not come back is worth looking at whether or not
      // our own telemetry happened to be watching, and drawing the unconfirmed
      // ones in a softer colour invited them to be read as less serious when
      // the only thing weaker about them is our coverage of that vehicle.
      const loss    = drains.filter(d => d.verdict === "DRAIN");
      const undul   = drains.filter(d => d.verdict === "REDISTRIBUTION");
      // No REFILL bucket: every row on this ledger is a reported DROP, so none
      // of them can turn out to be fuel arriving. Real refills come through as
      // `type === "refill"` from the fillings endpoint and are counted below.
      const refills = [];
      // A drain too fresh to judge — still inside the 20 min settle window.
      const open    = drains.filter(d => d.verdict === "PENDING" || d.verdict == null);

      // Worst verdict present wins, because that is the one that needs a human.
      const [pattern, status] =
        loss.length    ? ["Suspicious drain", "loss"]
      : open.length    ? ["Settling",         "open"]
      : undul.length   ? ["Undulating",       "undulating"]
      :                  ["Refills only",     "refill"];

      flagged.push({
        vehicleId,
        events: sorted,
        pattern,
        status,                                  // 'loss' | 'open' | 'undulating' | 'refill'
        isInconsistent: loss.length > 0,         // any drain, confirmed or not
        drainCount:  drains.length,
        refillCount: evts.filter(e => e.type === "refill").length,
        // The split behind the count, for the drains cell's tooltip. A row
        // reading "4" hides whether that is four drains or four recoveries.
        verdictSplit: {
          loss: loss.length, settled: undul.length, refill: refills.length, open: open.length,
          recoveredL: +(undul.reduce((s, d) => s + (d.recoveredMl ?? 0), 0) / 1000).toFixed(1),
        },
      });
    }

    // Suspicious drains first, then the unsettled, then undulation, then fuel
    // that only ever went in.
    const rank = { loss: 0, open: 1, undulating: 2, refill: 3 };
    return flagged.sort((a, b) =>
      rank[a.status] - rank[b.status] ||
      b.events.length - a.events.length
    );
  };

  return { events, loading, error, loadedDay, forVehicle, flaggedVehicles, tankState, reload };
}
