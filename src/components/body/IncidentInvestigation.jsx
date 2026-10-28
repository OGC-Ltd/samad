/**
 * A fuel alert's investigation, drawn on the live map while its incident
 * window is open (operator, 2026-10-15: "it should run automatically on the
 * map, hence no need for extra modals"), in the style the operator showed
 * (route with P stops and their came / left / duration; a playback bar with
 * time, speed and mileage).
 * From /fuel/thefts/:id/investigation:
 *
 *   the point   where the unit stood as the fuel began to fall: a pin in a
 *               white square
 *   the route   the RECORDED fixes an hour either side; silences dotted, never
 *               drawn as a road; A at the start, B at the end
 *   stops       every halt of 3 min or more on that route, a P marker whose
 *               popup gives the address, position, came, left and duration
 *   playback    a pin that walks the route, with time, speed and mileage
 *
 * The road-matched copy of the track is drawn only when the window's "Match
 * to roads" is on, and then the recorded fixes stay beneath it, faint.
 *
 * The 5/10/15-minute drive zones (Google Isochrones) were removed on request,
 * 2026-10-19.
 *
 * Opening an alert frames the route and the point once; after that the
 * camera is the operator's. Closing the window clears it all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getTheftInvestigation, getHaltInvestigation } from "../../api/fuelInvestigation";
import { useFloatingWindow } from "../../hooks/useFloatingWindow";
import "./IncidentInvestigation.scss";

const TZ = "Africa/Nairobi";
const HHMM = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: TZ });
const HHMMSS = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: TZ });
const STAMP = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: TZ });

/* Fixed colours: drawn on map tiles, which do not follow the theme. */
export const INVESTIGATION_COLOR = {
  track: "#2563eb",
  gap: "#94a3b8",
  point: "#0f172a",
  stop: "#1d4ed8",
  start: "#16a34a",
  end: "#dc2626",
};
const C = INVESTIGATION_COLOR;

/** A halt this long or longer is a stop. */
const STOP_MIN_MS = 3 * 60_000;
/** Below this the unit is standing. */
const STILL_KMH = 3;
/** Playback: simulated seconds per real second. */
const PLAY_RATE = 120;

function metresBetween(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const metres = (m) => (m == null ? "-" : m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);
const duration = (ms) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** An SVG as a marker icon. */
const svgIcon = (svg, w, h, ax, ay) => ({
  url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
  size: { width: w, height: h }, scaledSize: { width: w, height: h }, anchor: { x: ax, y: ay },
});
const PIN_SQUARE = svgIcon(
  '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">' +
  '<rect x="1" y="1" width="32" height="32" rx="3" fill="#fff" stroke="#cbd5e1"/>' +
  '<path d="M17 26s-7-6.6-7-11.6a7 7 0 0 1 14 0C24 19.4 17 26 17 26Z" fill="none" stroke="#0f172a" stroke-width="2.2" stroke-linejoin="round"/>' +
  '<circle cx="17" cy="14.4" r="2.6" fill="none" stroke="#0f172a" stroke-width="2.2"/></svg>', 34, 34, 17, 17);
const letter = (ch, fill) => svgIcon(
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><rect x="1" y="1" width="22" height="22" rx="4" fill="${fill}" stroke="#fff" stroke-width="2"/>` +
  `<text x="12" y="16.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="700" fill="#fff">${ch}</text></svg>`, 24, 24, 12, 12);
const STOP_ICON = letter("P", C.stop);
const START_ICON = letter("A", C.start);
const END_ICON = letter("B", C.end);
/** The route's shape: stretches, silences, stops, and mileage at each fix. */
function shape(track) {
  const runs = [];
  const holes = [];
  const km = new Array(track.length).fill(0);
  let d = 0;
  track.forEach((p, i) => {
    if (p.gapBefore && i > 0) holes.push([track[i - 1], p]);
    if (p.gapBefore || !runs.length) runs.push([p]);
    else { d += metresBetween(track[i - 1], p); runs[runs.length - 1].push(p); }
    km[i] = d / 1000;
  });
  const stops = [];
  let s = null;
  const close = (endT) => {
    if (s && endT - s.came >= STOP_MIN_MS) stops.push({ ...s, left: endT, ms: endT - s.came });
    s = null;
  };
  track.forEach((p, i) => {
    const still = (p.spd ?? 0) < STILL_KMH && !(i > 0 && metresBetween(track[i - 1], p) > 60);
    if (still && !p.gapBefore) { if (!s) s = { came: p.t, lat: p.lat, lng: p.lng }; }
    else close(p.t);
  });
  if (s) close(track[track.length - 1].t);
  return { runs, holes, stops, km, travelledM: Math.round(d) };
}

/** The stop's popup, in the map's own InfoWindow. */
function stopCard(stop, plate, onClose) {
  const div = document.createElement("div");
  div.className = "ivp";
  div.innerHTML =
    `<button type="button" class="ivp__x" aria-label="Close">×</button>` +
    `<dl>` +
    `<div><dt>Object</dt><dd>${esc(plate ?? "-")}</dd></div>` +
    `<div><dt>Address</dt><dd class="ivp__addr">Looking up…</dd></div>` +
    `<div><dt>Position</dt><dd>${stop.lat.toFixed(6)}°, ${stop.lng.toFixed(6)}°</dd></div>` +
    `<div><dt>Came</dt><dd>${STAMP.format(stop.came)}</dd></div>` +
    `<div><dt>Left</dt><dd>${STAMP.format(stop.left)}</dd></div>` +
    `<div><dt>Duration</dt><dd>${duration(stop.ms)}</dd></div>` +
    `</dl>`;
  div.querySelector(".ivp__x").addEventListener("click", onClose);
  return div;
}

const addresses = new Map();

const ROADS_KEY = "ft-ivw-roads";
const readRoads = () => { try { return localStorage.getItem(ROADS_KEY) === "1"; } catch { return false; } };

/**
 * Draws the alert's investigation on `map` while `theftId` is set.
 * Returns what the key and the playback bar need.
 */
export function useIncidentInvestigation({ map, maps, ready, orgId, subject }) {
  // A fuel alert (`{ kind: "fuel", theftId }`) or a halted unit
  // (`{ kind: "halt", vehicleId, sinceMs }`, its database id and when it
  // stopped). Both answer in the same shape; `theftId` names the answer.
  // (A unit's trip from its yard was removed on request, 2026-10-19.)
  const kind = subject?.kind ?? null;
  const theftId = !subject ? null
    : kind === "halt" ? `halt:${subject.vehicleId}:${subject.sinceMs}` : subject.theftId;
  // "Match to roads": a fuel alert carries its road match already.
  const [roads, setRoads] = useState(readRoads);
  const toggleRoads = useCallback(() => setRoads((r) => {
    try { localStorage.setItem(ROADS_KEY, r ? "0" : "1"); } catch { /* a remembered choice only */ }
    return !r;
  }), []);
  const q = useQuery({
    queryKey: ["fuel-investigation", orgId, theftId],
    queryFn: ({ signal }) => (kind === "halt"
      ? getHaltInvestigation(orgId, subject.vehicleId, subject.sinceMs, { signal })
      : getTheftInvestigation(orgId, subject.theftId, { signal })),
    enabled: Boolean(orgId && theftId),
    // A saved fuel investigation never changes; a halt is still going on.
    staleTime: kind === "halt" ? 5 * 60_000 : Infinity,
    retry: 0,
  });
  const inv = theftId && q.data?.theftId === theftId ? q.data : null;
  const canRoads = (inv?.snapped?.segments?.length ?? 0) > 0;
  const roadsOn = roads && canRoads && (inv?.snapped?.segments?.length ?? 0) > 0;
  const shaped = useMemo(() => (inv ? shape(inv.track) : null), [inv]);
  const framed = useRef(null);
  const cursorMarker = useRef(null);

  // ── playback ──
  const [cursor, setCursor] = useState(null); // ms, or null = not started
  const [playing, setPlaying] = useState(false);
  useEffect(() => { setCursor(null); setPlaying(false); }, [inv]);
  const t0 = inv?.track[0]?.t ?? null;
  const t1 = inv?.track[inv.track.length - 1]?.t ?? null;
  useEffect(() => {
    if (!playing || t0 == null) return undefined;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const step = (now - last) * PLAY_RATE;
      last = now;
      setCursor((c) => {
        const next = (c ?? t0) + step;
        if (next >= t1) { setPlaying(false); return t1; }
        return next;
      });
    }, 100);
    return () => clearInterval(id);
  }, [playing, t0, t1]);
  const toggle = useCallback(() => {
    setPlaying((p) => {
      if (!p && (cursor == null || cursor >= t1)) setCursor(t0);
      return !p;
    });
  }, [cursor, t0, t1]);
  const seek = useCallback((t) => { setCursor(t); }, []);
  // The last fix at or before the cursor.
  const hereIdx = useMemo(() => {
    if (!inv || cursor == null) return -1;
    const tr = inv.track;
    let lo = 0, hi = tr.length - 1, ans = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (tr[mid].t <= cursor) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }, [inv, cursor]);
  const here = hereIdx >= 0 ? inv.track[hereIdx] : null;

  // ── the static layers ──
  useEffect(() => {
    if (!ready || !map || !maps || !inv || !shaped) return undefined;
    const drawn = [];
    const add = (x) => { drawn.push(x); return x; };
    const ll = (p) => ({ lat: p.lat, lng: p.lng });
    const { runs, holes, stops } = shaped;
    const track = inv.track;

    // The route: white casing, then the line; silences dotted. Matched to
    // roads, the record stays beneath it, faint, so the two are never
    // mistaken for one another.
    if (roadsOn) {
      for (const r of runs) {
        if (r.length < 2) continue;
        add(new maps.Polyline({ map, path: r.map(ll), strokeColor: C.track, strokeOpacity: 0.35, strokeWeight: 2, zIndex: 39 }));
      }
      for (const seg of inv.snapped.segments) {
        const path = seg.map(([lat, lng]) => ({ lat, lng }));
        add(new maps.Polyline({ map, path, strokeColor: "#ffffff", strokeOpacity: 0.9, strokeWeight: 8, zIndex: 40 }));
        add(new maps.Polyline({ map, path, strokeColor: C.track, strokeOpacity: 1, strokeWeight: 5, zIndex: 41 }));
      }
    } else {
      for (const r of runs) {
        if (r.length < 2) continue;
        add(new maps.Polyline({ map, path: r.map(ll), strokeColor: "#ffffff", strokeOpacity: 0.9, strokeWeight: 8, zIndex: 40 }));
        add(new maps.Polyline({ map, path: r.map(ll), strokeColor: C.track, strokeOpacity: 1, strokeWeight: 5, zIndex: 41 }));
      }
    }
    for (const [a, b] of holes) {
      add(new maps.Polyline({
        map, path: [ll(a), ll(b)], strokeOpacity: 0, zIndex: 40,
        icons: [{ icon: { path: maps.SymbolPath.CIRCLE, scale: 1.5, fillColor: C.gap, fillOpacity: 1, strokeOpacity: 0 }, repeat: "8px" }],
      }));
    }

    // Stops, each with its popup.
    const popup = new maps.InfoWindow({});
    const geocoder = new maps.Geocoder();
    for (const s of stops) {
      const mk = add(new maps.Marker({ map, position: ll(s), icon: STOP_ICON, zIndex: 58, title: `Stopped ${duration(s.ms)} from ${HHMM.format(s.came)}` }));
      mk.addListener("click", () => {
        const card = stopCard(s, inv.plate, () => popup.close());
        popup.setContent(card);
        popup.open({ map, anchor: mk });
        const key = `${s.lat.toFixed(4)},${s.lng.toFixed(4)}`;
        const fill = (txt) => { const el = card.querySelector(".ivp__addr"); if (el) el.textContent = txt; };
        if (addresses.has(key)) fill(addresses.get(key));
        else geocoder.geocode({ location: ll(s) }, (res, status) => {
          const txt = status === "OK" && res[0] ? res[0].formatted_address : "No address found";
          addresses.set(key, txt);
          fill(txt);
        });
      });
    }

    if (track.length > 1) {
      add(new maps.Marker({ map, position: ll(track[0]), icon: START_ICON, zIndex: 59, title: `Start of the window, ${HHMM.format(track[0].t)}` }));
      add(new maps.Marker({ map, position: ll(track[track.length - 1]), icon: END_ICON, zIndex: 59, title: `End of the window, ${HHMM.format(track[track.length - 1].t)}` }));
    }
    if (inv.point) add(new maps.Marker({
      map, position: ll(inv.point), icon: PIN_SQUARE, zIndex: 62,
      title: inv.kind === "halt" ? `Halted here since ${HHMM.format(Date.parse(inv.beganAt))}`
        : `Fuel began to fall here, ${HHMM.format(Date.parse(inv.beganAt))}`,
    }));

    // Frame once per alert: the route and the point.
    if (framed.current !== inv.theftId) {
      framed.current = inv.theftId;
      const b = new maps.LatLngBounds();
      let any = false;
      for (const p of track) { b.extend(ll(p)); any = true; }
      if (inv.point) { b.extend(ll(inv.point)); any = true; }
      if (any) {
        // Measured first: a map whose box changed since it last looked fits
        // against the old size and lands far too wide.
        maps.event.trigger(map, "resize");
        map.fitBounds(b, 60);
        if (map.getZoom() > 16) map.setZoom(16);
      }
    }

    return () => {
      popup.close();
      for (const x of drawn) x.setMap(null);
    };
  }, [ready, map, maps, inv, shaped, roadsOn]);

  // ── the playback pin ──
  useEffect(() => {
    if (!ready || !map || !maps) return undefined;
    if (!here) { cursorMarker.current?.setMap(null); return undefined; }
    if (!cursorMarker.current) cursorMarker.current = new maps.Marker({ zIndex: 70, clickable: false });
    cursorMarker.current.setPosition({ lat: here.lat, lng: here.lng });
    if (cursorMarker.current.getMap() !== map) cursorMarker.current.setMap(map);
    return undefined;
  }, [ready, map, maps, here]);
  useEffect(() => () => { cursorMarker.current?.setMap(null); cursorMarker.current = null; }, [theftId]);

  // A closed window lets the next opening of the same alert frame again.
  useEffect(() => { if (!theftId) framed.current = null; }, [theftId]);

  return {
    kind, inv, shaped, loading: Boolean(theftId) && !inv && q.isLoading, error: theftId ? q.error : null,
    roads: { on: roads, available: canRoads, loading: false, toggle: toggleRoads },
    playback: {
      t0, t1, cursor, playing, toggle, seek, here,
      km: hereIdx >= 0 ? shaped?.km[hereIdx] ?? 0 : null,
    },
  };
}

const MIN_KEY = "ft-ivw-min";
const readMin = () => { try { return localStorage.getItem(MIN_KEY) === "1"; } catch { return false; } };

/** How long from the event to the cursor, in words for the readout. */
const span = (min) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`);
const KINDS = {
  fuel: { icon: "gas-station", title: "Fuel alert", label: "Fuel alert on the map", at: "At the fall", event: "Fuel fell", noun: "alert" },
  halt: { icon: "hand-stop", title: "Halted", label: "Halted unit on the map", at: "At the halt", event: "Halted", noun: "halt" },
};

/** Where `t` falls along the window, 0–100, for the rail's marks. */
const pct = (t, t0, t1) => (t1 > t0 ? Math.min(100, Math.max(0, ((t - t0) / (t1 - t0)) * 100)) : 0);

/**
 * The investigation's own floating window over the map (Hallmark redesign,
 * operator 2026-10-15: draggable, minimisable, closable). Placed, dragged and
 * remembered by useFloatingWindow, like the Halted and incident windows; it
 * outlives the window that opened it and closes only by its own ×.
 *
 *   head       the drag handle: what it is, which unit, minimise, close
 *   readout    the time at the cursor, its speed and the distance so far
 *   transport  play and a scrubber whose rail marks the fall (or the halt)
 *              in red and every stop in blue
 *   legend     what is drawn on the map
 */
export function InvestigationWindow({ kind: subjectKind, inv, shaped, loading, error, playback, roads, onClose }) {
  const open = Boolean(loading || error || inv);
  const { ref, onPointerDown } = useFloatingWindow({ id: "investigation", dock: "bottom-center", enabled: open });
  const [min, setMin] = useState(readMin);
  const toggleMin = () => setMin((m) => {
    try { localStorage.setItem(MIN_KEY, m ? "0" : "1"); } catch { /* a remembered choice only */ }
    return !m;
  });
  if (!open) return null;

  const kindKey = inv?.kind ?? subjectKind ?? "fuel";
  const K = KINDS[kindKey] ?? KINDS.fuel;
  const p = playback;
  const tr = inv?.track ?? [];
  const canPlay = tr.length > 1;
  const eventT = inv ? Date.parse(inv.beganAt) : null;
  const rel = p?.here && eventT != null ? Math.round((p.here.t - eventT) / 60_000) : null;
  const relText = rel == null ? null : rel === 0 ? K.at
    : rel < 0 ? `${span(-rel)} before` : `${span(rel)} after`;
  const snapNote = roads?.on && inv && !roads.loading && inv.snapped?.reason
    && !/^(Asked for separately|The unit did not move)/.test(inv.snapped.reason) ? inv.snapped.reason : null;
  const still = (shaped?.travelledM ?? 0) < 200;
  const stop = (e) => e.stopPropagation();

  const play = (
    <button type="button" className="ivw__play" onClick={p?.toggle} onPointerDown={stop} disabled={!canPlay}
            aria-label={p?.playing ? "Pause" : "Play"} title={canPlay ? (p?.playing ? "Pause" : "Play the route") : "No route to play"}>
      <i className={`ti ti-player-${p?.playing ? "pause" : "play"}-filled`} aria-hidden="true" />
    </button>
  );

  return (
    <section ref={ref} className={`ivw${min ? " ivw--min" : ""}`} data-kind={kindKey} aria-label={K.label}>
      <header className="ivw__head" onPointerDown={onPointerDown}>
        <i className={`ti ti-${K.icon} ivw__kind`} aria-hidden="true" />
        <span className="ivw__title">{K.title}</span>
        {inv?.plate && <span className="ivw__plate" title={inv.plate}>{inv.plate}</span>}
        {min && inv && canPlay && (
          <span className="ivw__mini">
            {play}
            <b>{p.here ? HHMMSS.format(p.here.t) : HHMM.format(eventT)}</b>
          </span>
        )}
        <span className="ivw__tools">
          <button type="button" className="ivw__tool" onClick={toggleMin} onPointerDown={stop}
                  aria-expanded={!min} aria-label={min ? "Expand" : "Minimise"} title={min ? "Expand" : "Minimise"}>
            <i className={`ti ti-${min ? "chevron-up" : "minus"}`} aria-hidden="true" />
          </button>
          <button type="button" className="ivw__tool" onClick={onClose} onPointerDown={stop}
                  aria-label="Close and clear the map" title="Close and clear the map">
            <i className="ti ti-x" aria-hidden="true" />
          </button>
        </span>
      </header>

      {!min && (
        <div className="ivw__body">
          {loading && (
            <div className="ivw__skel" aria-busy="true" aria-label="Loading the route">
              <span /><span /><span />
            </div>
          )}
          {error && (
            <p className="ivw__msg ivw__msg--error" role="alert">
              <i className="ti ti-alert-circle" aria-hidden="true" />
              The route could not load: {error.message}
            </p>
          )}
          {inv && (
            <>
              <dl className="ivw__read">
                <div className="ivw__cell ivw__cell--time">
                  <dt>{p.here ? relText : K.event}</dt>
                  <dd>{p.here ? HHMMSS.format(p.here.t) : HHMM.format(eventT)}</dd>
                </div>
                <div className="ivw__cell">
                  <dt>Speed</dt>
                  <dd>{p.here?.spd != null ? p.here.spd.toFixed(1) : "-"}<small>km/h</small></dd>
                </div>
                <div className="ivw__cell">
                  <dt>Distance</dt>
                  <dd>{p.here ? (p.km ?? 0).toFixed(2) : ((shaped?.travelledM ?? 0) / 1000).toFixed(2)}<small>km</small></dd>
                </div>
              </dl>

              {canPlay ? (
                <div className="ivw__transport">
                  {play}
                  <div className="ivw__scrub">
                    <div className="ivw__rail" aria-hidden="true">
                      {shaped.stops.map((s) => (
                        <i key={s.came} className="ivw__mark ivw__mark--stop"
                           style={{ left: `${pct(s.came, p.t0, p.t1)}%`, width: `${Math.max(0.8, pct(s.left, p.t0, p.t1) - pct(s.came, p.t0, p.t1))}%` }} />
                      ))}
                      <i className="ivw__mark ivw__mark--event" style={{ left: `${pct(eventT, p.t0, p.t1)}%` }} />
                    </div>
                    <input type="range" className="ivw__range" min={p.t0} max={p.t1} step={1000}
                           value={p.cursor ?? p.t0} onPointerDown={stop}
                           aria-label="Time along the route" aria-valuetext={p.here ? HHMMSS.format(p.here.t) : undefined}
                           onChange={(e) => p.seek(Number(e.target.value))} />
                    <div className="ivw__ends" aria-hidden="true">
                      <span>{HHMM.format(p.t0)}</span><span>{HHMM.format(p.t1)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="ivw__msg">No GPS fixes around this {K.noun} to play.</p>
              )}

              <ul className="ivw__legend">
                {inv.point && <li><i className="ivw__sw ivw__sw--pin" aria-hidden="true" />{kindKey === "halt" ? "Halt" : "Fuel fell"}</li>}
                <li><i className="ivw__sw ivw__sw--route" aria-hidden="true" />{tr.length === 0 ? "No route" : still ? "Stood still" : `Route ${metres(shaped.travelledM)}`}</li>
                {shaped?.stops.length > 0 && <li><i className="ivw__sw ivw__sw--stop" aria-hidden="true">P</i>{shaped.stops.length} {shaped.stops.length === 1 ? "stop" : "stops"}</li>}
              </ul>
              {roads?.available && tr.length > 1 && !still && (
                <div className="ivw__opt">
                  <button type="button" className="ivw__switch" role="switch" aria-checked={roads.on}
                          onClick={roads.toggle} onPointerDown={stop} disabled={roads.loading}>
                    <span className="ivw__knob" aria-hidden="true" />
                    {roads.loading ? "Matching to roads…" : "Match to roads"}
                  </button>
                  <span className="ivw__hint">{roads.on ? "Google's road match; the recorded fixes stay faint beneath." : "The recorded GPS fixes, as sent."}</span>
                </div>
              )}
              {snapNote && (
                <p className="ivw__note"><i className="ti ti-info-circle" aria-hidden="true" />No road match. {snapNote}.</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

