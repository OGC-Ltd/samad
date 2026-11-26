/**
 * Draw a geofence on the fleet map, or change one (operator, 2026-11-10: "we
 * need to dictate how our geofences look, their name and coordinates and
 * their purpose").
 *
 * The person picks a shape, draws it on the map, and says what it is called,
 * what it is for and what colour it draws in. The coordinates are shown as
 * text beside the drawing and can be typed or pasted instead, so a surveyed
 * boundary goes in exactly rather than by eye.
 *
 * Geometry is turf.js, through lib/fenceShape: the preview of every shape
 * (a circle's ring, a road's corridor), the area and length, edges that
 * cross, and which fence a drawing sits inside or overlaps.
 *
 *   Polygon    click the corners; click the first one (or Finish) to close.
 *   Rectangle  click two opposite corners.
 *   Circle     click the centre, then the edge; or type the radius.
 *   Road       click along the road, Finish, and give its width.
 *
 * Once drawn, corners are dragged to move them, the small dot between two
 * corners is dragged to add one, and a right-click on a corner removes it.
 *
 * A fence drawn here is ours (source "samad", server/fences.go): it can be
 * renamed, reshaped and removed by anyone signed in. IntelliFleet's zones are
 * not opened here: their name and shape are IntelliFleet's.
 *
 * Ported from Rai Track (2026-11-26) without its rules: alerts on our fences
 * are step 2 of the geofence work, so nothing here raises one yet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFence, updateFence, deleteFence } from "../../api/geofences";
import { reloadEstateZones } from "../../hooks/useEstateZones";
import { FENCE_PURPOSES, ZONE_STYLE, zoneColor } from "../../lib/zoneLegend";
import {
  draftOf, fmtArea, fmtLength, formatPoints, measure, metresBetween, notesOf, outlineOf,
  parsePoints, pointsNeeded, problemsOf, shapeOf, toPayload, withBoxes,
} from "../../lib/fenceShape";
import "./GeofenceDrawer.scss";

const SHAPES = [
  { id: "polygon",   label: "Polygon",   icon: "ti-polygon" },
  { id: "rectangle", label: "Rectangle", icon: "ti-square" },
  { id: "circle",    label: "Circle",    icon: "ti-circle" },
  { id: "corridor",  label: "Road",      icon: "ti-road" },
];

const HINT = {
  polygon:   "Click the corners on the map. Click the first corner, or Finish, to close it.",
  rectangle: "Click two opposite corners on the map.",
  circle:    "Click the centre, then click the edge. Or type the radius.",
  corridor:  "Click along the road, then Finish and set its width.",
};

/** Colours to choose from besides the purpose's own. */
const SWATCHES = ["#dc2626", "#ea580c", "#d97706", "#65a30d", "#059669", "#0891b2", "#2563eb", "#7c3aed", "#db2777", "#475569"];

/** How close (px) a click must land to a corner to count as that corner. */
const SNAP_PX = 12;

const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName ?? "") || e.target?.isContentEditable;
const plain = (ll) => ({ lat: typeof ll.lat === "function" ? ll.lat() : ll.lat, lng: typeof ll.lng === "function" ? ll.lng() : ll.lng });

/**
 * @param {{
 *   map: object, maps: object, DomMarker: Function, orgId: string,
 *   fences: object[],            // the org's geofences (GeoJSON features)
 *   editing: object|null,        // the fence being changed, or null for a new one
 *   canDelete: boolean,
 *   clickRef: { current: Function|null },   // FleetMap forwards clicks that land on a fence
 *   onClose: () => void,
 * }} props
 */
export default function GeofenceDrawer({ map, maps, DomMarker, orgId, fences, editing, canDelete, clickRef, onClose }) {
  const props0 = editing?.properties ?? {};
  const locked = Boolean(editing) && props0.source === "provider";
  const start = editing ? draftOf(editing) : null;

  const [kind, setKind] = useState(start?.kind ?? "polygon");
  const [points, setPoints] = useState(start?.points ?? []);
  const [radiusM, setRadiusM] = useState(start?.radiusM ?? 100);
  const [widthM, setWidthM] = useState(start?.widthM ?? 20);
  const [done, setDone] = useState(Boolean(start));
  const [cursor, setCursor] = useState(null);
  const [name, setName] = useState(props0.name ?? "");
  const [purpose, setPurpose] = useState(
    FENCE_PURPOSES.includes(props0.purpose) ? props0.purpose
      : editing && FENCE_PURPOSES.includes(props0.category) ? props0.category : "",
  );
  const [color, setColor] = useState(props0.color ?? null);
  const [coordsText, setCoordsText] = useState(null);   // null = follow the drawing
  const [coordsErr, setCoordsErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [confirmDel, setConfirmDel] = useState(false);

  const draft = useMemo(() => ({ kind, points, radiusM: Number(radiusM), widthM: Number(widthM) }), [kind, points, radiusM, widthM]);
  const shown = color ?? (purpose ? zoneColor(purpose) : "#1d4ed8");
  const boxed = useMemo(() => withBoxes(fences ?? []), [fences]);
  const problems = useMemo(() => problemsOf(draft), [draft]);
  const notes = useMemo(() => (problems.length ? [] : notesOf(draft, boxed, props0.id ?? null)), [draft, boxed, problems, props0.id]);
  const size = useMemo(() => measure(draft), [draft]);

  /* ── drawing on the map ─────────────────────────────────────────────── */

  const proj = useCallback(() => map?._proj ?? null, [map]);
  const px = useCallback((a, b) => {
    const p = proj();
    if (!p) return Infinity;
    const q1 = p.fromLatLngToContainerPixel(a), q2 = p.fromLatLngToContainerPixel(b);
    return Math.hypot(q1.x - q2.x, q1.y - q2.y);
  }, [proj]);

  const pointsRef = useRef(points);
  pointsRef.current = points;
  const finish = useCallback(() => {
    if (pointsRef.current.length >= pointsNeeded(kind)) setDone(true);
  }, [kind]);

  // Latest state for the listeners, which are bound once.
  const live = useRef({});
  live.current = { kind, points, done, locked, px, finish };
  const swallowClick = useRef(0);

  const onPoint = useCallback((ll) => {
    const { kind: k, points: pts, done: d, locked: lk, px: dist } = live.current;
    if (lk || d || Date.now() < swallowClick.current) return;
    setCoordsText(null);
    setCoordsErr(null);
    if (k === "rectangle" || k === "circle") {
      if (pts.length === 0) { setPoints([ll]); return; }
      if (k === "rectangle") setPoints([pts[0], ll]);
      else setRadiusM(Math.max(1, Math.round(metresBetween(pts[0], ll))));
      setDone(true);
      return;
    }
    // Polygon and road: a click on the first corner closes a polygon, a click
    // on the last point again finishes either.
    if (k === "polygon" && pts.length >= 3 && dist(pts[0], ll) <= SNAP_PX) { setDone(true); return; }
    if (pts.length >= pointsNeeded(k) && dist(pts[pts.length - 1], ll) <= SNAP_PX) { setDone(true); return; }
    setPoints([...pts, ll]);
  }, []);

  useEffect(() => {
    if (!clickRef) return undefined;
    clickRef.current = onPoint;
    return () => { clickRef.current = null; };
  }, [clickRef, onPoint]);

  useEffect(() => {
    if (!map) return undefined;
    map.setOptions({ disableDoubleClickZoom: true });
    const click = map.addListener("click", (e) => e?.latLng && onPoint(plain(e.latLng)));
    const move = map.addListener("mousemove", (e) => e?.latLng && setCursor(plain(e.latLng)));
    const out = map.addListener("mouseout", () => setCursor(null));
    return () => {
      click.remove(); move.remove(); out.remove();
      map.setOptions({ disableDoubleClickZoom: false });
    };
  }, [map, onPoint]);

  // Keys: Enter finishes, Backspace takes the last point back, Escape stops
  // the drawing (and closes the tool when there is nothing to stop).
  useEffect(() => {
    const onKey = (e) => {
      if (typing(e)) return;
      const { done: d, points: pts, locked: lk } = live.current;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!lk && !d && pts.length) { setPoints([]); setCursor(null); } else onClose();
      } else if (lk) {
        return;
      } else if (e.key === "Enter" && !d) {
        e.preventDefault(); live.current.finish();
      } else if (e.key === "Backspace" && !d && pts.length) {
        e.preventDefault(); setPoints(pts.slice(0, -1));
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // What the map shows: the drawing so far, with the pointer as its next point.
  const preview = useMemo(() => {
    if (done || !cursor || locked) return draft;
    if (kind === "rectangle" && points.length === 1) return { ...draft, points: [points[0], cursor] };
    if (kind === "circle" && points.length === 1) return { ...draft, radiusM: metresBetween(points[0], cursor) };
    if (kind === "polygon" || kind === "corridor") return { ...draft, points: [...points, cursor] };
    return draft;
  }, [draft, done, cursor, kind, points, locked]);

  // The shape: filled, in its colour, never taking the pointer.
  useEffect(() => {
    if (!map || !maps) return undefined;
    const out = [];
    const shape = shapeOf(preview);
    if (shape) {
      out.push(new maps.Polygon({
        map, paths: outlineOf(shape), clickable: false, zIndex: 950,
        strokeColor: shown, strokeOpacity: 1, strokeWeight: 2.5, fillColor: shown, fillOpacity: 0.22,
      }));
    }
    // The line being drawn, and a road's centre-line.
    const open = !done && (kind === "polygon" || kind === "corridor");
    if ((open || kind === "corridor") && preview.points.length >= 2) {
      out.push(new maps.Polyline({
        map, path: preview.points, clickable: false, zIndex: 951,
        strokeColor: shown, strokeOpacity: 0.95, strokeWeight: kind === "corridor" ? 2 : 2.5,
      }));
    }
    return () => out.forEach((s) => s.setMap(null));
  }, [map, maps, preview, shown, done, kind]);

  // Handles: a dot per corner, a smaller one between corners to add one, and
  // a circle's edge handle for its radius.
  useEffect(() => {
    if (!map || !DomMarker || locked) return undefined;
    const out = [];
    const add = (position, html) => { const m = new DomMarker({ position, html, anchor: "center", zIndex: 960 }); m.setMap(map); out.push(m); };
    const style = `style="--gfd:${shown}"`;
    const pts = kind === "rectangle" && points.length === 2
      ? [points[0], { lat: points[0].lat, lng: points[1].lng }, points[1], { lat: points[1].lat, lng: points[0].lng }]
      : points;
    pts.forEach((p, i) => {
      const first = kind === "polygon" && i === 0 && !done && points.length >= 3;
      add(p, `<div class="gfd-handle${first ? " gfd-handle--close" : ""}" data-gfd-vertex="${i}" ${style} title="${done ? "Drag to move. Right-click to remove." : first ? "Click to close the shape" : ""}"></div>`);
    });
    if (done && (kind === "polygon" || kind === "corridor")) {
      const n = points.length;
      const edges = kind === "polygon" ? n : n - 1;
      for (let i = 0; i < edges; i++) {
        const a = points[i], b = points[(i + 1) % n];
        add({ lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, `<div class="gfd-mid" data-gfd-mid="${i}" ${style} title="Drag to add a corner"></div>`);
      }
    }
    if (kind === "circle" && points.length === 1 && done) {
      const shape = shapeOf(draft);
      // A quarter of the way round turf's 64-step ring.
      const edge = shape?.geometry.coordinates[0][16];
      if (edge) add({ lat: edge[1], lng: edge[0] }, `<div class="gfd-handle gfd-handle--edge" data-gfd-radius="1" ${style} title="Drag to change the radius"></div>`);
    }
    return () => out.forEach((m) => m.setMap(null));
  }, [map, DomMarker, locked, kind, points, done, shown, draft]);

  // Dragging a handle. Caught on the way DOWN to the map, so the map does not
  // pan under it, and the click that ends a drag is not taken as a new point.
  useEffect(() => {
    const div = map?.getDiv?.();
    if (!div || locked) return undefined;
    let drag = null;
    const at = (e) => {
      const r = div.getBoundingClientRect();
      const p = proj()?.fromContainerPixelToLatLng({ x: e.clientX - r.left, y: e.clientY - r.top });
      return p ? plain(p) : null;
    };
    const handleOf = (e) => e.target?.closest?.("[data-gfd-vertex],[data-gfd-mid],[data-gfd-radius]");
    const down = (e) => {
      const h = handleOf(e);
      if (!h || e.button > 0) return;
      const { kind: k, points: pts, done: d } = live.current;
      // While drawing, pressing a corner is a click on it (close or finish).
      if (!d && h.dataset.gfdVertex != null) return;
      e.stopPropagation(); e.preventDefault();
      if (h.dataset.gfdMid != null) {
        const i = Number(h.dataset.gfdMid) + 1;
        const ll = at(e);
        if (!ll) return;
        setPoints([...pts.slice(0, i), ll, ...pts.slice(i)]);
        drag = { index: i };
      } else if (h.dataset.gfdRadius != null) {
        drag = { radius: true };
      } else {
        const i = Number(h.dataset.gfdVertex);
        // A rectangle's handles are its four corners; it is kept as two.
        drag = k === "rectangle" ? { rect: i } : { index: i };
      }
      map.setOptions({ draggable: false });
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up, { once: true });
    };
    const move = (e) => {
      const ll = at(e);
      if (!ll || !drag) return;
      setCoordsText(null);
      if (drag.radius) {
        const c = live.current.points[0];
        setRadiusM(Math.max(1, Math.round(metresBetween(c, ll))));
      } else if (drag.rect != null) {
        setPoints(([a, b]) => {
          // Corners 0..3 go round the box; each moves the edges it sits on.
          const i = drag.rect;
          if (i === 0) return [ll, b];
          if (i === 2) return [a, ll];
          if (i === 1) return [{ lat: ll.lat, lng: a.lng }, { lat: b.lat, lng: ll.lng }];
          return [{ lat: a.lat, lng: ll.lng }, { lat: ll.lat, lng: b.lng }];
        });
      } else {
        setPoints((pts) => pts.map((p, j) => (j === drag.index ? ll : p)));
      }
    };
    const up = () => {
      drag = null;
      swallowClick.current = Date.now() + 350;
      window.removeEventListener("pointermove", move);
      map.setOptions({ draggable: true });
    };
    // Mouse events too: Leaflet starts a pan on mousedown, not pointerdown.
    const block = (e) => { if (handleOf(e) && live.current.done) { e.stopPropagation(); e.preventDefault(); } };
    // A right-click on a corner removes it, while enough are left.
    const context = (e) => {
      const h = e.target?.closest?.("[data-gfd-vertex]");
      if (!h) return;
      e.preventDefault(); e.stopPropagation();
      const { kind: k, points: pts } = live.current;
      if (k !== "polygon" && k !== "corridor") return;
      if (pts.length <= pointsNeeded(k)) return;
      const i = Number(h.dataset.gfdVertex);
      setCoordsText(null);
      setPoints(pts.filter((_, j) => j !== i));
    };
    div.addEventListener("pointerdown", down, true);
    div.addEventListener("mousedown", block, true);
    div.addEventListener("contextmenu", context, true);
    return () => {
      div.removeEventListener("pointerdown", down, true);
      div.removeEventListener("mousedown", block, true);
      div.removeEventListener("contextmenu", context, true);
      window.removeEventListener("pointermove", move);
      map.setOptions({ draggable: true });
    };
  }, [map, locked, proj]);

  // The map frames a fence that is opened for a change.
  useEffect(() => {
    if (!map || !maps || !editing) return;
    const shape = shapeOf(start);
    if (!shape) return;
    const b = new maps.LatLngBounds();
    for (const [lng, lat] of shape.geometry.coordinates[0]) b.extend({ lat, lng });
    map.fitBounds(b, 120);
    // Once, when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, maps, editing?.properties?.id]);

  /* ── the panel ──────────────────────────────────────────────────────── */

  const pickShape = (k) => {
    if (k === kind) return;
    setKind(k);
    setPoints([]); setDone(false); setCoordsText(null); setCoordsErr(null); setErr(null);
  };
  const redraw = () => { setPoints([]); setDone(false); setCoordsText(null); setCoordsErr(null); };

  const coordsShown = coordsText ?? (kind === "rectangle" && points.length === 2
    ? formatPoints([points[0], { lat: points[0].lat, lng: points[1].lng }, points[1], { lat: points[1].lat, lng: points[0].lng }])
    : formatPoints(points));

  const applyCoords = () => {
    if (coordsText == null) return;
    const { points: pts, error } = parsePoints(coordsText);
    if (error) { setCoordsErr(error); return; }
    setCoordsErr(null);
    // Typed corners make a polygon, even where a rectangle was being drawn.
    const k = kind === "rectangle" ? "polygon" : kind;
    const next = k === "circle" ? pts.slice(0, 1) : pts;
    setKind(k);
    setPoints(next);
    setDone(next.length >= pointsNeeded(k));
    setCoordsText(null);
    if (map && maps && next.length) {
      const b = new maps.LatLngBounds();
      next.forEach((p) => b.extend(p));
      if (next.length === 1) map.setView(next[0], Math.max(map.getZoom(), 15));
      else map.fitBounds(b, 120);
    }
  };

  const missing = !name.trim() ? "Give the geofence a name."
    : !purpose ? "Choose what the geofence is for."
    : null;
  const canSave = !busy && !missing && !locked && done && problems.length === 0;

  const save = async () => {
    if (!canSave) return;
    setBusy(true); setErr(null);
    try {
      const body = toPayload(draft, { name, purpose, color });
      if (editing) await updateFence(orgId, props0.id, { ...body, color: color ?? null });
      else await createFence(orgId, body);
      await reloadEstateZones(orgId).catch(() => {});
      onClose({ saved: true });
    } catch (e) {
      setErr(e?.message ?? "The geofence could not be saved.");
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirmDel) { setConfirmDel(true); return; }
    setBusy(true); setErr(null);
    try {
      await deleteFence(orgId, props0.id);
      await reloadEstateZones(orgId).catch(() => {});
      onClose({ saved: true });
    } catch (e) {
      setErr(e?.message ?? "The geofence could not be removed.");
      setBusy(false);
    }
  };

  const title = editing ? (locked ? "Geofence from IntelliFleet" : "Change geofence") : "New geofence";

  return (
    <section className="gfd" aria-label={title}>
      <header className="gfd__head">
        <h2 className="gfd__title">{title}</h2>
        <button type="button" className="gfd__x" onClick={() => onClose()} aria-label="Close" title="Close (Esc)">
          <i className="ti ti-x" aria-hidden="true" />
        </button>
      </header>

      <div className="gfd__body">
        {locked ? (
          <p className="gfd__note">This geofence comes from IntelliFleet, so it is changed there, not here.</p>
        ) : (
          <>
            <div className="gfd__shapes" role="radiogroup" aria-label="Shape">
              {SHAPES.map((s) => (
                <button key={s.id} type="button" role="radio" aria-checked={kind === s.id}
                        className="gfd__shape" onClick={() => pickShape(s.id)}>
                  <i className={`ti ${s.icon}`} aria-hidden="true" />{s.label}
                </button>
              ))}
            </div>
            {!done && <p className="gfd__hint">{HINT[kind]}</p>}
          </>
        )}

        {!locked && kind === "circle" && (
          <label className="gfd__field gfd__field--inline">
            <span>Radius</span>
            <input type="number" min="10" max="100000" step="1" value={radiusM}
                   onChange={(e) => setRadiusM(e.target.value)} />
            <span className="gfd__unit">m</span>
          </label>
        )}
        {!locked && kind === "corridor" && (
          <label className="gfd__field gfd__field--inline">
            <span>Width</span>
            <input type="number" min="2" max="2000" step="1" value={widthM}
                   onChange={(e) => setWidthM(e.target.value)} />
            <span className="gfd__unit">m</span>
          </label>
        )}

        <label className="gfd__field">
          <span>Name</span>
          <input type="text" value={name} maxLength={120} disabled={locked}
                 placeholder="Athi River · Yard"
                 onChange={(e) => setName(e.target.value)} />
        </label>

        <label className="gfd__field">
          <span>Purpose</span>
          <select value={purpose} onChange={(e) => setPurpose(e.target.value)}>
            <option value="" disabled>Choose what it is for</option>
            {FENCE_PURPOSES.map((k) => <option key={k} value={k}>{ZONE_STYLE[k]?.label ?? k}</option>)}
          </select>
        </label>

        <fieldset className="gfd__field gfd__colours">
          <legend>Colour</legend>
          <div className="gfd__swatches">
            <button type="button" className="gfd__swatch gfd__swatch--purpose"
                    aria-pressed={color == null} style={{ "--sw": purpose ? zoneColor(purpose) : "#94a3b8" }}
                    title="The purpose's own colour" onClick={() => setColor(null)}>
              <span>Purpose</span>
            </button>
            {SWATCHES.map((c) => (
              <button key={c} type="button" className="gfd__swatch" aria-pressed={color === c}
                      style={{ "--sw": c }} title={c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} />
            ))}
            <label className="gfd__custom" title="Any colour">
              <input type="color" value={color ?? shown} onChange={(e) => setColor(e.target.value)} aria-label="Any colour" />
              <i className="ti ti-palette" aria-hidden="true" />
            </label>
          </div>
        </fieldset>

        {!locked && (
          <label className="gfd__field">
            <span>{kind === "circle" ? "Centre (latitude, longitude)" : kind === "corridor" ? "Points along the road (latitude, longitude)" : "Corners (latitude, longitude)"}</span>
            <textarea rows={Math.min(8, Math.max(3, points.length + 1))} spellCheck={false}
                      value={coordsShown}
                      placeholder={"-1.310800, 36.852200\n-1.311500, 36.853000\n…or paste GeoJSON"}
                      onChange={(e) => setCoordsText(e.target.value)}
                      onBlur={applyCoords}
                      onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); applyCoords(); } }} />
            {coordsText != null && !coordsErr && <span className="gfd__sub">Click outside the box, or Ctrl+Enter, to draw these.</span>}
            {coordsErr && <span className="gfd__bad">{coordsErr}</span>}
          </label>
        )}

        {(size.areaHa > 0 || size.lengthM) && (
          <dl className="gfd__size">
            {size.areaHa > 0 && <div><dt>Area</dt><dd>{fmtArea(size.areaHa)}</dd></div>}
            {kind === "corridor" && size.lengthM ? <div><dt>Length</dt><dd>{fmtLength(size.lengthM)}</dd></div>
              : size.perimeterM > 0 && <div><dt>Perimeter</dt><dd>{fmtLength(size.perimeterM)}</dd></div>}
          </dl>
        )}

        {!locked && done && problems.map((p) => <p key={p} className="gfd__bad" role="alert">{p}</p>)}
        {!locked && notes.map((n) => <p key={n} className="gfd__sub">{n}</p>)}
        {err && <p className="gfd__bad" role="alert">{err}</p>}
      </div>

      <footer className="gfd__foot">
        {editing && !locked && canDelete && (
          <button type="button" className={`gfd__btn gfd__btn--danger${confirmDel ? " gfd__btn--armed" : ""}`}
                  disabled={busy} onClick={remove} onBlur={() => setConfirmDel(false)}>
            {confirmDel ? "Remove it" : "Remove"}
          </button>
        )}
        <span className="gfd__spacer" />
        {!locked && !done && points.length >= pointsNeeded(kind) && (kind === "polygon" || kind === "corridor") && (
          <button type="button" className="gfd__btn" onClick={finish}>Finish</button>
        )}
        {!locked && done && <button type="button" className="gfd__btn" onClick={redraw}>Redraw</button>}
        <button type="button" className="gfd__btn gfd__btn--primary" disabled={!canSave} onClick={save}
                title={missing ?? (!locked && !done ? "Finish drawing first" : problems[0] ?? "")}>
          {busy ? "Saving…" : "Save"}
        </button>
      </footer>
    </section>
  );
}
