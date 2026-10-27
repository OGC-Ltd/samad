/**
 * Arrivals at a hub (operator, 2026-10-15): every unit's live-traffic drive
 * time to one place — Naitiri, Raiply, Sukari
 * Industries, Oyani, Nyaondo, Opapo — so inbound runs can be coordinated and
 * an arrival promised from a road ETA rather than a straight line.
 *
 *   hub     a target in a white square
 *   list    the units ranked by arrival: drive time, clock time, road km,
 *           the traffic delay, and whether the run is dispatched to the hub or
 *           returning to it. A row takes the camera to the unit.
 *
 * The reverse-isochrone rings (Google Isochrones) were removed on request,
 * 2026-10-19; the counts "within 15 / 30 / 60 min" come from the drive times.
 *
 * From /routing/hubs and /routing/hubs/:key/inbound (fleet-server
 * hub-arrivals). The answer is refreshed every two minutes while open.
 *
 * Phase 1 (operator, 2026-10-15):
 *   class       "Trucks", "Cars" or "Tractors" (KT… plates, e.g. KTCB 358X):
 *               the list is that class only, and its drive times are at
 *               the class's MEASURED speed, not Google's car's. "Plant"
 *               (excavators, dozers, loaders) is offered where the fleet
 *               has plant: Kasulu, typed by RaiFactorySuite's machine
 *               register, and Sukari's company machines (2026-10-20);
 *               generators are in no class. Trucks and cars were one list
 *               until 2026-10-20 (operator: "tractors to tractors, trucks
 *               to trucks, cars to cars")
 *   free only   leaves out units on a dispatch or without a recent position
 *   bands       a drive time past an hour reads 1–2 h, 2–4 h or
 *               4 h+ in its row (Menengai's long hauls)
 *   a spot      "Pick a spot on the map…" makes any point the hub — suggest
 *               a unit for a farm, a breakdown, a load waiting by the road
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../services/api";
import { useFloatingWindow } from "../../hooks/useFloatingWindow";
import "./HubArrivals.css";

const TZ = "Africa/Nairobi";
const HHMM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ });

/* The drive-time bands' colours, deepest for the nearest. */
export const ARRIVAL_COLOR = { 15: "#0f766e", 30: "#0d9488", 60: "#2dd4bf" };
const MINUTES = [15, 30, 60];
const PAGE = 8;
const CLS_KEY = "ft-arr-cls";
const FREE_KEY = "ft-arr-free";
/** What the drive times are for, as the window offers it. */
export const ARRIVAL_CLASSES = [
  ["TRUCK", "ti-truck", "Trucks"],
  ["CAR", "ti-car", "Cars"],
  ["TRACTOR", "ti-tractor", "Tractors"],
  ["PLANT", "ti-backhoe", "Plant"],
];
const BASE_CLASSES = ["TRUCK", "CAR", "TRACTOR"];
/**
 * The classes the window offers: those the fleet has units in, by the
 * server's counts (`/routing/hubs` → classes), "Trucks" always.
 * Without counts (an older server), trucks, cars and tractors.
 */
export function offeredClasses(counts) {
  if (!counts) return ARRIVAL_CLASSES.filter(([k]) => BASE_CLASSES.includes(k));
  return ARRIVAL_CLASSES.filter(([k]) => k === "TRUCK" || (counts[k] ?? 0) > 0);
}
/** The remembered class where it is offered, else "Trucks". */
export const offeredClass = (c, offered) => (offered.some(([k]) => k === c) ? c : "TRUCK");
const PICK = "__pick";
const POINT = "__point";
const hubKeyOf = (orgId) => `ft-arr-hub:${orgId}`;
const read = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* a remembered choice only */ } };

const mins = (s) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};
const km = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`);

const svgIcon = (svg, w, h, ax, ay) => ({
  url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  size: { width: w, height: h }, scaledSize: { width: w, height: h }, anchor: { x: ax, y: ay },
});
const HUB_ICON = svgIcon(
  '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">' +
  '<rect x="1" y="1" width="32" height="32" rx="3" fill="#fff" stroke="#0f766e" stroke-width="2"/>' +
  '<circle cx="17" cy="17" r="9" fill="none" stroke="#0f172a" stroke-width="2.2"/><circle cx="17" cy="17" r="4.5" fill="none" stroke="#0f172a" stroke-width="2.2"/>' +
  '<circle cx="17" cy="17" r="1.4" fill="#0f172a"/></svg>', 34, 34, 17, 17);
/** The hubs, the chosen one's answer, and its marker on `map` while open. */
export function useHubArrivals({ map, maps, ready, orgId, open }) {
  const hubsQ = useQuery({
    queryKey: ["routing-hubs", orgId],
    queryFn: ({ signal }) => apiFetch(`/api/v1/organisations/${orgId}/routing/hubs`, { signal }).then((r) => r.data),
    enabled: Boolean(open && orgId),
    staleTime: 60 * 60_000,
    retry: 1,
  });
  const hubs = useMemo(() => hubsQ.data?.hubs ?? [], [hubsQ.data]);
  const [hubKey, setHubKeyState] = useState(null);
  useEffect(() => { setHubKeyState(orgId ? read(hubKeyOf(orgId), null) : null); }, [orgId]);
  const hub = hubs.find((h) => h.key === hubKey) ?? hubs[0] ?? null;
  const setHubKey = useCallback((k) => { setHubKeyState(k); if (orgId) write(hubKeyOf(orgId), k); }, [orgId]);
  const [wanted, setClsState] = useState(() => {
    const c = read(CLS_KEY, "TRUCK");
    return ARRIVAL_CLASSES.some(([k]) => k === c) ? c : "TRUCK";
  });
  const classes = useMemo(() => offeredClasses(hubsQ.data?.classes), [hubsQ.data]);
  // A class this fleet has none of (Plant at Menengai) reads as "Trucks".
  const cls = offeredClass(wanted, classes);
  const setCls = useCallback((c) => { setClsState(c); write(CLS_KEY, c); }, []);
  const [free, setFreeState] = useState(() => read(FREE_KEY, "0") === "1");
  const toggleFree = useCallback(() => setFreeState((f) => { write(FREE_KEY, f ? "0" : "1"); return !f; }), []);

  // A spot picked on the map stands in for the hub until a hub is chosen.
  const [point, setPoint] = useState(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => { setPoint(null); setPicking(false); }, [orgId]);
  useEffect(() => { if (!open) setPicking(false); }, [open]);
  const choose = useCallback((k) => {
    if (k === PICK) { setPicking(true); return; }
    if (k === POINT) return;
    setPicking(false);
    setPoint(null);
    setHubKey(k);
  }, [setHubKey]);
  const target = point ?? hub;

  const qs = `cls=${cls}&available=${free ? 1 : 0}&minutes=${MINUTES.join(",")}`;
  const q = useQuery({
    queryKey: ["hub-inbound", orgId, point ? `${point.lat},${point.lng}` : hub?.key, cls, free],
    queryFn: ({ signal }) => apiFetch(
      point
        ? `/api/v1/organisations/${orgId}/routing/point/inbound?lat=${point.lat}&lng=${point.lng}&${qs}`
        : `/api/v1/organisations/${orgId}/routing/hubs/${encodeURIComponent(hub.key)}/inbound?${qs}`,
      { signal },
    ).then((r) => r.data),
    enabled: Boolean(open && orgId && target && hubsQ.data?.enabled),
    staleTime: 2 * 60_000,
    refetchInterval: open ? 2 * 60_000 : false,
    placeholderData: (prev) => prev,
    retry: 0,
  });
  const d = q.data;
  const data = d?.enabled && target && d.cls === cls && d.available === free
    && Math.abs(d.hub.lat - target.lat) < 0.002 && Math.abs(d.hub.lng - target.lng) < 0.002 ? d : null;

  // Picking: the next click on the map is the spot.
  useEffect(() => {
    if (!open || !picking || !ready || !map) return undefined;
    const l = map.addListener("click", (e) => {
      setPoint({ lat: Math.round(e.latLng.lat() * 1e5) / 1e5, lng: Math.round(e.latLng.lng() * 1e5) / 1e5, name: "Picked spot", key: "point" });
      setPicking(false);
    });
    return () => l?.remove?.();
  }, [open, picking, ready, map]);

  // ── the hub ──
  const framed = useRef(null);
  useEffect(() => {
    const hub = target;
    if (!open || !ready || !map || !maps || !hub) return undefined;
    const drawn = [];
    const add = (x) => { drawn.push(x); return x; };
    add(new maps.Marker({ map, position: { lat: hub.lat, lng: hub.lng }, icon: HUB_ICON, zIndex: 63, title: hub.name }));

    // Frame once per hub or spot: the hub and the units within the hour.
    const fk = `${hub.lat},${hub.lng}`;
    if (framed.current !== fk && data) {
      framed.current = fk;
      const b = new maps.LatLngBounds();
      b.extend({ lat: hub.lat, lng: hub.lng });
      for (const u of data.units) if (u.withinMin != null) b.extend({ lat: u.lat, lng: u.lng });
      maps.event.trigger(map, "resize");
      map.fitBounds(b, 60);
      if (map.getZoom() > 13) map.setZoom(13);
    }
    return () => { for (const x of drawn) x.setMap(null); };
  }, [open, ready, map, maps, target, data]);
  useEffect(() => { if (!open) framed.current = null; }, [open]);

  return {
    open,
    hubs, hub, target, point, choose, picking, cancelPick: () => setPicking(false),
    classes, cls, setCls, free, toggleFree,
    enabled: hubsQ.data ? hubsQ.data.enabled : null,
    loading: (hubsQ.isLoading || q.isLoading || (q.isPlaceholderData && !data)) && open,
    refreshing: q.isFetching && Boolean(data),
    error: hubsQ.error ?? q.error ?? null,
    data,
  };
}

const MIN_KEY = "ft-arr-min";

/**
 * The Arrivals window: which hub, by what, and who gets there when. Docked
 * bottom-right, dragged and remembered like the other map windows; it stays
 * open while the camera moves, so working down the list is one click a unit.
 */
export function ArrivalsWindow({ arrivals, onSelectUnit, onClose }) {
  const { open, hubs, target, point, choose, picking, cancelPick, classes, cls, setCls, free, toggleFree, enabled, loading, refreshing, error, data } = arrivals;
  const { ref, onPointerDown } = useFloatingWindow({ id: "arrivals", dock: "bottom-right", enabled: open });
  const [min, setMin] = useState(() => read(MIN_KEY, "0") === "1");
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [target?.lat, target?.lng, cls, free]);
  if (!open) return null;

  const units = data?.units ?? [];
  const pages = Math.max(1, Math.ceil(units.length / PAGE));
  const p = Math.min(page, pages - 1);
  const shown = units.slice(p * PAGE, p * PAGE + PAGE);
  const inRing = (m) => units.filter((u) => u.withinMin != null && u.withinMin <= m).length;
  const hubName = target?.name ?? "the hub";
  const stop = (e) => e.stopPropagation();
  const toggleMin = () => setMin((v) => { write(MIN_KEY, v ? "0" : "1"); return !v; });
  const now = Date.now();

  return (
    <section ref={ref} className={`arw${min ? " arw--min" : ""}`} aria-label="Arrivals at a hub">
      <header className="arw__head" onPointerDown={onPointerDown}>
        <i className="ti ti-target-arrow arw__kind" aria-hidden="true" />
        <span className="arw__title">Arrivals</span>
        <select className="arw__hub" value={point ? POINT : target?.key ?? ""} onChange={(e) => choose(e.target.value)}
                onPointerDown={stop} aria-label="Hub" disabled={!hubs.length}>
          {!hubs.length && <option value="">{loading ? "Loading hubs…" : "No hubs"}</option>}
          {point && <option value={POINT}>Picked spot</option>}
          {hubs.map((h) => <option key={h.key} value={h.key}>{h.name}</option>)}
          {hubs.length > 0 && <option value={PICK}>Pick a spot on the map…</option>}
        </select>
        <span className="arw__tools">
          <button type="button" className="arw__tool" onClick={toggleMin} onPointerDown={stop}
                  aria-expanded={!min} aria-label={min ? "Expand" : "Minimise"} title={min ? "Expand" : "Minimise"}>
            <i className={`ti ti-${min ? "chevron-up" : "minus"}`} aria-hidden="true" />
          </button>
          <button type="button" className="arw__tool" onClick={onClose} onPointerDown={stop}
                  aria-label="Close and clear the map" title="Close and clear the map">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </span>
      </header>

      {!min && (
        <div className="arw__body">
          <div className="arw__modes" role="radiogroup" aria-label="Which units">
            {classes.map(([c, icon, label]) => (
              <button key={c} type="button" role="radio" aria-checked={cls === c} className="arw__mode"
                      onClick={() => setCls(c)} onPointerDown={stop}>
                <i className={`ti ${icon}`} aria-hidden="true" />{label}
              </button>
            ))}
            <button type="button" className="arw__free" role="switch" aria-checked={free} onClick={toggleFree} onPointerDown={stop}
                    title="Only units with a fresh position and no open dispatch">
              <span className="arw__knob" aria-hidden="true" />Free only
            </button>
          </div>
          {refreshing && <span className="arw__live" aria-live="polite">Updating…</span>}

          {picking && (
            <p className="arw__pick" role="status">
              <i className="ti ti-click" aria-hidden="true" />Click the map where a unit is needed.
              <button type="button" className="arw__link" onClick={cancelPick} onPointerDown={stop}>Cancel</button>
            </p>
          )}

          {enabled === false && (
            <p className="arw__msg"><i className="ti ti-info-circle" aria-hidden="true" />Routing is switched off on this server.</p>
          )}
          {error && (
            <p className="arw__msg arw__msg--error" role="alert">
              <i className="ti ti-alert-circle" aria-hidden="true" />Arrivals could not load: {error.message}
            </p>
          )}
          {loading && !data && (
            <div className="arw__skel" aria-busy="true" aria-label="Loading arrivals"><span /><span /><span /><span /></div>
          )}

          {data && (
            <>
              <dl className="arw__rings">
                {MINUTES.map((m) => (
                  <div key={m} className="arw__ring" style={{ "--ring": ARRIVAL_COLOR[m] }}>
                    <dt>Within {m} min</dt><dd>{inRing(m)}</dd>
                  </div>
                ))}
                <div className="arw__ring arw__ring--at"><dt>At {hubName}</dt><dd>{data.atHub.length}</dd></div>
              </dl>

              {units.length === 0 ? (
                <p className="arw__msg">{free ? "No free unit" : "No unit with a recent position"} is within 250 km of {hubName}.</p>
              ) : (
                <>
                <ol className="arw__list" start={p * PAGE + 1}>
                  {shown.map((u, i) => {
                    const best = point && p === 0 && i === 0 && u.status === "free";
                    return (
                      <li key={u.vehicleId}>
                        <button type="button" className="arw__row" onClick={() => onSelectUnit?.(u.vehicleId)}
                                title={`Show ${u.plate ?? "this unit"} on the map`}>
                          <span className="arw__eta" style={{ "--ring": ARRIVAL_COLOR[u.withinMin] ?? "var(--arw-edge-hi)" }}>
                            <b>{mins(u.etaS)}</b><small>{u.band ?? HHMM.format(Date.parse(u.arriveAt))}</small>
                          </span>
                          <span className="arw__unit">
                            <span className="arw__plate">{u.plate ?? "Unnamed unit"}</span>
                            <span className="arw__meta">
                              {km(u.distanceM)} by road
                              {u.delayS >= 60 && <span className={`arw__delay${u.delayS >= 300 ? " arw__delay--hi" : ""}`}>+{mins(u.delayS)} traffic</span>}
                              {u.factor !== 1 && <span title="Google's time for a car on the same road">car {mins(u.googleS)}</span>}
                              {u.status === "busy" && !u.run && <span className="arw__busy">on a run{u.destination ? ` to ${u.destination}` : ""}</span>}
                              {u.status === "stale" && <span className="arw__stale">position {mins((now - Date.parse(u.fixAt)) / 1000)} old</span>}
                            </span>
                          </span>
                          {best ? <span className="arw__run arw__run--best">Best pick</span> : u.run && (
                            <span className={`arw__run arw__run--${u.run}`}>{u.run === "dispatched" ? "Dispatched here" : "Returning"}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ol>
                </>
              )}

              <footer className="arw__foot">
                {pages > 1 && (
                  <span className="arw__pager">
                    <button type="button" className="arw__tool" onClick={() => setPage(Math.max(0, p - 1))} disabled={p === 0} aria-label="Previous page">
                      <i className="ti ti-chevron-left" aria-hidden="true" />
                    </button>
                    <span>{p + 1} / {pages}</span>
                    <button type="button" className="arw__tool" onClick={() => setPage(Math.min(pages - 1, p + 1))} disabled={p >= pages - 1} aria-label="Next page">
                      <i className="ti ti-chevron-right" aria-hidden="true" />
                    </button>
                  </span>
                )}
                <span className="arw__note">
                  Live traffic, {HHMM.format(Date.parse(data.computedAt))}
                  {data.leftOut > 0 && ` · ${data.leftOut} further units not asked`}
                  {data.filteredOut > 0 && ` · ${data.filteredOut} busy or without a recent position hidden`}
                  {data.noRoute > 0 && ` · ${data.noRoute} with no road`}
                </span>
              </footer>
            </>
          )}
        </div>
      )}
    </section>
  );
}
