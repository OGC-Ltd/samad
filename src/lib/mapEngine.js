// The map engine: Leaflet, behind the slice of the Google Maps JS API this app
// was written against.
//
// Operator, 2026-10-04: "remove the Google from there, we are openstreetmap
// now". Google's logo cannot be hidden while Google's engine draws the map, so
// the engine went. FleetMap is ~7k lines of camera choreography, a bespoke
// OverlayView marker with a tween loop, clustering, replay, zone and plan
// layers, all written against google.maps; rewriting every call site would
// have been a second product. Instead this module implements exactly the API
// surface those files use — no more — on top of Leaflet, and they keep their
// logic. The namespace returned by loadMapEngine() stands where
// `window.google.maps` used to.
//
// Covered: Map, OverlayView, Marker, Polyline, Polygon, Data, InfoWindow,
// LatLng, LatLngBounds, Size, Point, SymbolPath, Geocoder (OSM Nominatim) and
// `event`. Behaviour differences worth knowing:
//   - `zoom_changed` fires when a zoom SETTLES (Leaflet's zoomend), not when
//     it starts. getZoom() during a zoom animation returns the target zoom.
//   - Overlays get draw() on zoom, on the zoom animation's target frame and
//     after every move — div pixels are stable while panning, as in Google.
//   - Zoom is fractional (zoomSnap 0) so the wheel can stop between levels;
//     fitBounds still lands on whole levels. A wheel gesture fires
//     zoom_changed and idle once, when it ends.
//   - No rotation or tilt. setHeading / setTilt do not exist (callers use ?.).

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./mapEngine.css";

// ── geometry primitives ─────────────────────────────────────────────────────

export class LatLng {
  constructor(lat, lng) {
    if (lat && typeof lat === "object") { lng = typeof lat.lng === "function" ? lat.lng() : lat.lng; lat = typeof lat.lat === "function" ? lat.lat() : lat.lat; }
    this._lat = Number(lat);
    this._lng = Number(lng);
  }
  lat() { return this._lat; }
  lng() { return this._lng; }
  toJSON() { return { lat: this._lat, lng: this._lng }; }
  equals(o) { return !!o && Math.abs(toLL(o).lat - this._lat) < 1e-9 && Math.abs(toLL(o).lng - this._lng) < 1e-9; }
  toString() { return `(${this._lat}, ${this._lng})`; }
}

/** Anything Google accepted as a position → a Leaflet LatLng. */
function toLL(p) {
  if (!p) return null;
  if (p instanceof L.LatLng) return p;
  if (typeof p.lat === "function") return L.latLng(p.lat(), p.lng());
  return L.latLng(p.lat, p.lng);
}
const fromLL = (ll) => (ll ? new LatLng(ll.lat, ll.lng) : null);

export class LatLngBounds {
  constructor(sw, ne) {
    this._b = null;
    if (sw) this.extend(sw);
    if (ne) this.extend(ne);
  }
  extend(p) {
    const ll = p instanceof LatLngBounds ? p._b : toLL(p);
    if (!ll) return this;
    if (!this._b) this._b = ll instanceof L.LatLngBounds ? L.latLngBounds(ll.getSouthWest(), ll.getNorthEast()) : L.latLngBounds(ll, ll);
    else this._b.extend(ll);
    return this;
  }
  union(b) { return this.extend(b); }
  isEmpty() { return !this._b; }
  contains(p) { return !!this._b && this._b.contains(toLL(p)); }
  getNorthEast() { return this._b ? fromLL(this._b.getNorthEast()) : null; }
  getSouthWest() { return this._b ? fromLL(this._b.getSouthWest()) : null; }
  getCenter() { return this._b ? fromLL(this._b.getCenter()) : null; }
  toJSON() {
    if (!this._b) return null;
    return { north: this._b.getNorth(), south: this._b.getSouth(), east: this._b.getEast(), west: this._b.getWest() };
  }
  static _from(lb) { const b = new LatLngBounds(); if (lb) b._b = L.latLngBounds(lb.getSouthWest(), lb.getNorthEast()); return b; }
}

export class Size {
  constructor(width, height) { this.width = width; this.height = height; }
  equals(o) { return !!o && o.width === this.width && o.height === this.height; }
}
export class Point {
  constructor(x, y) { this.x = x; this.y = y; }
  equals(o) { return !!o && o.x === this.x && o.y === this.y; }
}

export const SymbolPath = { CIRCLE: 0, FORWARD_CLOSED_ARROW: 1, FORWARD_OPEN_ARROW: 2, BACKWARD_CLOSED_ARROW: 3, BACKWARD_OPEN_ARROW: 4 };

// ── events ──────────────────────────────────────────────────────────────────

class Evented {
  constructor() { this._ls = new globalThis.Map(); }
  addListener(name, fn) {
    if (!this._ls.has(name)) this._ls.set(name, new Set());
    this._ls.get(name).add(fn);
    this._onListen?.(name);
    return { remove: () => this._ls.get(name)?.delete(fn) };
  }
  _emit(name, ...args) {
    const s = this._ls.get(name);
    if (s) for (const fn of [...s]) fn(...args);
  }
  _clearListeners() { this._ls.clear(); }
}

/** A Google MapMouseEvent from a Leaflet mouse event. */
const mouseEvent = (le, extra) => ({
  latLng: le?.latlng ? fromLL(le.latlng) : null,
  domEvent: le?.originalEvent ?? null,
  stop() { le?.originalEvent?.stopPropagation?.(); },
  ...extra,
});

export const event = {
  addListener: (obj, name, fn) => obj.addListener(name, fn),
  addListenerOnce(obj, name, fn) {
    const h = obj.addListener(name, (...a) => { h.remove(); fn(...a); });
    return h;
  },
  removeListener: (h) => h?.remove?.(),
  clearInstanceListeners: (obj) => obj?._clearListeners?.(),
  trigger(obj, name, ...args) {
    if (obj instanceof Map && name === "resize") { obj._l.invalidateSize({ pan: false }); return; }
    obj?._emit?.(name, ...args);
  },
};

// ── the map ─────────────────────────────────────────────────────────────────

/** Google's overlay panes, as Leaflet panes above the vector layer (400). */
const PANES = [
  ["overlayLayer", 420, false],
  ["markerLayer", 610, false],
  ["overlayMouseTarget", 620, true],
  ["floatPane", 700, true],
];

/** Google event name → Leaflet event(s) on the map. */
const MAP_EVENTS = {
  click: "click", dblclick: "dblclick", rightclick: "contextmenu",
  mousemove: "mousemove", mouseout: "mouseout", mouseover: "mouseover",
  dragstart: "dragstart", drag: "drag", dragend: "dragend",
  zoom_changed: "zoomend", center_changed: "move", bounds_changed: "move zoomend",
};

/** Google-style MapType (getTile/releaseTile) as a Leaflet GridLayer. */
const TypeLayer = L.GridLayer.extend({
  initialize(type, opts) {
    this._type = type;
    L.GridLayer.prototype.initialize.call(this, opts);
    this.on("tileunload", (e) => type.releaseTile?.(e.tile));
  },
  createTile(coords) {
    return this._type.getTile({ x: coords.x, y: coords.y }, coords.z, document);
  },
});

// Wheel zoom (operator, 2026-10-15): glide, follow the wheel only while it
// turns, and stay calm on a trackball. Leaflet's own handler rounds every
// wheel burst UP to a whole level (zoomSnap 1), so the smallest trackball nudge
// was a full 2× jump, animated after the wheel had already stopped.
const WHEEL_PX_PER_LEVEL = 240;   // one ~100 px mouse notch ≈ 0.4 of a level
const WHEEL_MAX_EVENT_PX = 120;   // a fast flick or trackball spin counts as one notch per event at most
const WHEEL_MAX_AHEAD = 1;        // the camera never trails the wheel by more than a level
const WHEEL_EASE = 0.3;           // share of the remaining distance covered per 60 fps frame
const WHEEL_END_MS = 160;         // this long without a wheel event ends the gesture
// A scroll begun OFF the map (a panel, a list) still owns the wheel when the
// pointer then crosses onto the map — a trackball spun in a sidebar keeps
// coasting. The map takes the wheel only after this long without any wheel
// event elsewhere (operator, 2026-10-15).
const WHEEL_FOREIGN_MS = 350;
let lastForeignWheel = -Infinity;
const wheelMaps = new Set();
if (typeof document !== "undefined") {
  document.addEventListener("wheel", (e) => {
    for (const el of wheelMaps) if (el.contains(e.target)) return;
    lastForeignWheel = e.timeStamp;
  }, { capture: true, passive: true });
}

/**
 * Smooth wheel zoom about the pointer. Each frame moves the map with Leaflet's
 * `_move` (the same primitive its pinch zoom uses), keeping the place under the
 * pointer under the pointer; `zoom_changed` / `idle` fire once, when the
 * gesture ends, so clustering and labels re-run once and not every frame.
 * Zoom is fractional here — the map is built with zoomSnap 0.
 */
const SmoothWheelZoom = L.Handler.extend({
  addHooks() {
    const el = this._map.getContainer();
    wheelMaps.add(el);
    L.DomEvent.on(el, "wheel", this._onWheel, this);
  },
  removeHooks() {
    const el = this._map.getContainer();
    wheelMaps.delete(el);
    L.DomEvent.off(el, "wheel", this._onWheel, this);
    this._finish();
  },

  _onWheel(e) {
    L.DomEvent.stop(e);
    const map = this._map;
    // Still the tail of a scroll that began elsewhere: swallow it, and keep
    // swallowing until the wheel pauses. Not mid-gesture: once the map has
    // the wheel it keeps it.
    if (!this._raf && e.timeStamp - lastForeignWheel < WHEEL_FOREIGN_MS) {
      lastForeignWheel = e.timeStamp;
      return;
    }
    // A programmatic zoom animation owns the camera until it lands.
    if (map._animatingZoom) return;
    if (!this._raf) {
      map._stop();                       // the reader takes over from any pan in flight
      this._zoom = map.getZoom();
      this._target = this._zoom;
      this._last = performance.now();
      this._raf = requestAnimationFrame(this._frame);
    }
    let px = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 100 : 1);
    if (e.ctrlKey) px *= 2;              // touchpad pinch: small deltas
    px = Math.max(-WHEEL_MAX_EVENT_PX, Math.min(WHEEL_MAX_EVENT_PX, px));
    const z = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), this._target - px / WHEEL_PX_PER_LEVEL));
    this._target = Math.max(this._zoom - WHEEL_MAX_AHEAD, Math.min(this._zoom + WHEEL_MAX_AHEAD, z));
    this._pt = map.mouseEventToContainerPoint(e);
    this._anchor = map.containerPointToLatLng(this._pt);
    this._quiet = false;
    clearTimeout(this._endTimer);
    this._endTimer = setTimeout(() => { this._quiet = true; }, WHEEL_END_MS);
  },

  _frame: null,
  initialize(map) {
    L.Handler.prototype.initialize.call(this, map);
    this._frame = (now) => {
      this._raf = 0;
      const map = this._map;
      // Someone else moved the camera mid-gesture (a drag, a fly-to): let them have it.
      if (map._animatingZoom || map.dragging?._draggable?._moving || (this._moving && map.getZoom() !== this._zoom)) {
        this._finish();
        return;
      }
      const k = 1 - Math.pow(1 - WHEEL_EASE, Math.min(4, (now - this._last) / 16.7));
      this._last = now;
      let z = this._zoom + (this._target - this._zoom) * k;
      if (Math.abs(this._target - z) < 0.002) z = this._target;
      if (z !== this._zoom) {
        if (!this._moving) { this._moving = true; this._startZoom = this._zoom; map._moveStart(true, false); }
        const half = map.getSize().divideBy(2);
        map._move(map.unproject(map.project(this._anchor, z).subtract(this._pt).add(half), z), z);
        this._zoom = z;
      }
      if (this._quiet && z === this._target) this._finish();
      else this._raf = requestAnimationFrame(this._frame);
    };
  },

  _finish() {
    cancelAnimationFrame(this._raf);
    clearTimeout(this._endTimer);
    this._raf = 0;
    if (this._moving) {
      this._moving = false;
      this._map._moveEnd(this._map.getZoom() !== this._startZoom);
    }
  },
});

export class Map extends Evented {
  constructor(div, opts = {}) {
    super();
    // Google lets a container be handed to a new Map; Leaflet refuses one it
    // already owns. A remount (StrictMode, hot reload) replaces the old map.
    // Kept on the element rather than in a module-level map, so a hot reload
    // of this module (a fresh, empty copy) still finds the old one.
    div.__engineMap?._destroy();
    div.__engineMap = this;
    const l = L.map(div, {
      center: toLL(opts.center) ?? [0, 0],
      zoom: opts.zoom ?? 3,
      minZoom: opts.minZoom ?? 1,
      maxZoom: opts.maxZoom ?? 21,
      zoomControl: false,
      attributionControl: false,
      doubleClickZoom: !opts.disableDoubleClickZoom,
      keyboard: opts.keyboardShortcuts !== false,
      scrollWheelZoom: false,          // SmoothWheelZoom, below
      dragging: opts.gestureHandling !== "none" && opts.draggable !== false,
      // Fractional zoom, so a wheel gesture can stop between levels and stay
      // there. Fits still land on whole levels — see fitBounds.
      zoomSnap: 0,
    });
    l.addHandler("smoothWheelZoom", SmoothWheelZoom);
    if (opts.gestureHandling !== "none" && opts.scrollwheel !== false) l.smoothWheelZoom.enable();
    this._l = l;
    this._overlays = new Set();
    this._vectors = new Set();
    this._anim = null;
    this._typeId = null;
    this._typeLayer = null;

    this._panes = {};
    for (const [name, z, interactive] of PANES) {
      const p = l.createPane(`g-${name}`);
      p.style.zIndex = String(z);
      p.classList.add("gpane");
      if (!interactive) p.style.pointerEvents = "none";
      this._panes[name] = p;
    }
    l.createPane("g-data").style.zIndex = "390";
    // Raster overlays (traffic): over the base map, under everything drawn.
    const tp = l.createPane("g-tiles");
    tp.style.zIndex = "250";
    tp.style.pointerEvents = "none";
    this._dataRenderer = L.canvas({ pane: "g-data", padding: 0.3 });

    const types = {};
    this.mapTypes = {
      set: (id, type) => { types[id] = type; if (id === this._typeId) this._applyType(); },
      get: (id) => types[id],
    };
    this._types = types;

    if (opts.zoomControl) L.control.zoom({ position: "bottomright" }).addTo(l);
    if (opts.fullscreenControl) fullscreenControl().addTo(l);

    // Div-pixel and world projections, Google-shaped.
    const self = this;
    this._proj = {
      fromLatLngToDivPixel(ll) {
        const p = self._anim
          ? l._latLngToNewLayerPoint(toLL(ll), self._anim.zoom, self._anim.center)
          : l.latLngToLayerPoint(toLL(ll));
        return new Point(p.x, p.y);
      },
      fromLatLngToContainerPixel(ll) { const p = l.latLngToContainerPoint(toLL(ll)); return new Point(p.x, p.y); },
      fromContainerPixelToLatLng(pt) { return fromLL(l.containerPointToLatLng([pt.x, pt.y])); },
      fromDivPixelToLatLng(pt) { return fromLL(l.layerPointToLatLng([pt.x, pt.y])); },
      fromLatLngToPoint(ll) { const p = L.CRS.EPSG3857.latLngToPoint(toLL(ll), 0); return new Point(p.x, p.y); },
      fromPointToLatLng(pt) { return fromLL(L.CRS.EPSG3857.pointToLatLng(L.point(pt.x, pt.y), 0)); },
    };
    this._worldProj = { fromLatLngToPoint: this._proj.fromLatLngToPoint, fromPointToLatLng: this._proj.fromPointToLatLng };

    const drawAll = () => { for (const o of [...this._overlays]) o.draw?.(); };
    l.on("zoomanim", (e) => { this._anim = { zoom: e.zoom, center: e.center }; drawAll(); });
    l.on("zoom viewreset", () => { this._anim = null; drawAll(); });
    // Idle first, so a listener that refreshes shared state (FleetMap's cull
    // rectangle) does it before the overlays redraw against it.
    //
    // Emitted a microtask after moveend, as Google's idle is always async. A
    // fit or setView that does not move the map makes Leaflet fire moveend
    // synchronously, inside the call — before the `addListenerOnce("idle")`
    // the caller attaches next (FleetMap's zoom caps). That listener then sat
    // armed and clamped the reader's NEXT wheel zoom back to the cap: the
    // "zoom resets by itself" reports.
    let idleQueued = false;
    l.on("moveend", () => {
      this._anim = null;
      if (idleQueued) return;
      idleQueued = true;
      queueMicrotask(() => { idleQueued = false; if (!this._l._loaded) return; this._emit("idle"); drawAll(); });
    });
    requestAnimationFrame(() => this._emit("idle"));

    // Google re-measures its container by itself; Leaflet has to be told.
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => l.invalidateSize({ pan: false }));
      this._ro.observe(div);
    }

    if (opts.mapTypeId) this.setMapTypeId(opts.mapTypeId);
  }

  _destroy() {
    this._ro?.disconnect();
    for (const o of [...this._overlays]) o.setMap(null);
    this._l.remove();
  }

  _onListen(name) {
    if (this._bound?.has(name)) return;
    (this._bound ??= new Set()).add(name);
    const le = MAP_EVENTS[name];
    if (!le) return;
    const wrap = name === "click" || name === "dblclick" || name === "rightclick" || name.startsWith("mouse");
    this._l.on(le, (e) => this._emit(name, wrap ? mouseEvent(e) : undefined));
  }

  _applyType() {
    const type = this._types[this._typeId];
    if (this._typeLayer) { this._typeLayer.remove(); this._typeLayer = null; }
    if (!type) return;
    // A type that brings its own Leaflet layer (lib/googleBase: Google's map
    // drawn by its own JS API) is mounted as-is instead of tiled through getTile.
    if (type.leafletLayer) { this._typeLayer = type.leafletLayer().addTo(this._l); return; }
    this._typeLayer = new TypeLayer(type, {
      tileSize: type.tileSize?.width ?? 256,
      minZoom: type.minZoom ?? 0,
      maxZoom: type.maxZoom ?? 21,
      keepBuffer: 3,
      updateWhenZooming: false,
    }).addTo(this._l);
  }

  // camera
  getZoom() { return this._l._animatingZoom ? this._l._animateToZoom : this._l.getZoom(); }
  setZoom(z) { this._l.setZoom(z); }
  getCenter() { return fromLL(this._l._animatingZoom ? this._l._animateToCenter : this._l.getCenter()); }
  setCenter(c) { this._l.setView(toLL(c), this._l.getZoom(), { animate: false }); }
  panTo(c) { this._l.panTo(toLL(c)); }
  /**
   * Centre AND zoom in one move. Never panTo then setZoom: Leaflet's setZoom
   * stops a pan still under way and zooms about where the map was, so the
   * pair landed beside the unit (operator, 2026-10-13: "we have to double do
   * the process") and only a second try, starting nearer, arrived.
   */
  setView(c, z) { this._l.setView(toLL(c), z); }
  panBy(x, y) { this._l.panBy([x, y]); }
  getBounds() {
    const l = this._l;
    if (this._anim) {
      // Where the zoom animation is going, so a viewport cull taken mid-zoom
      // culls against the frame being animated to.
      const { center, zoom } = this._anim;
      const c = l.project(center, zoom), half = l.getSize().divideBy(2);
      return LatLngBounds._from(L.latLngBounds(l.unproject(c.add([-half.x, half.y]), zoom), l.unproject(c.add([half.x, -half.y]), zoom)));
    }
    return LatLngBounds._from(l.getBounds());
  }
  fitBounds(bounds, padding = 0) {
    const b = bounds instanceof LatLngBounds ? bounds._b : bounds?.north != null
      ? L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]) : null;
    if (!b) return;
    const p = typeof padding === "number" ? { top: padding, right: padding, bottom: padding, left: padding } : { top: 0, right: 0, bottom: 0, left: 0, ...padding };
    // Whole levels for a fit, as before fractional zoom: tiles are sharpest there.
    const o = this._l.options;
    o.zoomSnap = 1;
    try {
      this._l.fitBounds(b, { paddingTopLeft: [p.left, p.top], paddingBottomRight: [p.right, p.bottom] });
    } finally {
      o.zoomSnap = 0;
    }
  }
  getDiv() { return this._l.getContainer(); }
  getProjection() { return this._worldProj; }
  setMapTypeId(id) {
    if (id === this._typeId) return;
    this._typeId = id;
    this._applyType();
    this._emit("maptypeid_changed");
  }
  getMapTypeId() { return this._typeId; }
  setOptions(o = {}) {
    if (o.minZoom != null) this._l.setMinZoom(o.minZoom);
    if (o.maxZoom != null) this._l.setMaxZoom(o.maxZoom);
    if (o.mapTypeId) this.setMapTypeId(o.mapTypeId);
    if (o.draggable === false) this._l.dragging.disable();
    if (o.draggable === true) this._l.dragging.enable();
    if (o.disableDoubleClickZoom === true) this._l.doubleClickZoom.disable();
    if (o.disableDoubleClickZoom === false) this._l.doubleClickZoom.enable();
  }

  /** Vector layers stack by zIndex; Leaflet's SVG stacks by insertion. */
  _stack(layer) {
    this._vectors.add(layer);
    if (this._stackQueued) return;
    this._stackQueued = true;
    requestAnimationFrame(() => {
      this._stackQueued = false;
      const live = [...this._vectors].filter((v) => v._map === this && v._l?._map);
      this._vectors = new Set(live);
      const zs = new Set(live.map((v) => v._z));
      if (zs.size < 2) return;
      live.sort((a, b) => a._z - b._z).forEach((v) => v._l.bringToFront());
    });
  }
}

function fullscreenControl() {
  const C = L.Control.extend({
    options: { position: "topright" },
    onAdd(map) {
      const btn = L.DomUtil.create("button", "gfs-btn");
      btn.type = "button";
      btn.title = "Full screen";
      btn.setAttribute("aria-label", "Full screen");
      btn.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
      L.DomEvent.disableClickPropagation(btn);
      L.DomEvent.on(btn, "click", () => {
        const el = map.getContainer().parentElement ?? map.getContainer();
        if (document.fullscreenElement) document.exitFullscreen?.();
        else el.requestFullscreen?.();
      });
      return btn;
    },
  });
  return new C();
}

// ── OverlayView ─────────────────────────────────────────────────────────────

export class OverlayView extends Evented {
  setMap(map) {
    map = map || null;
    if (map === this._map) return;
    if (this._map) { this._map._overlays.delete(this); this.onRemove?.(); }
    this._map = map;
    if (map) {
      map._overlays.add(this);
      this.onAdd?.();
      this.draw?.();
    }
  }
  getMap() { return this._map ?? null; }
  getPanes() { return this._map?._panes ?? null; }
  getProjection() { return this._map?._proj ?? null; }
}

// ── Marker ──────────────────────────────────────────────────────────────────

/** A Google marker icon as positioned HTML, plus its geometry. */
function iconHtml(icon, label) {
  let w, h, ax, ay, body;
  if (icon && typeof icon === "object" && icon.path === SymbolPath.CIRCLE) {
    const r = icon.scale ?? 5, sw = icon.strokeWeight ?? 1;
    w = h = Math.ceil(2 * r + sw * 2);
    ax = ay = w / 2;
    body = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block"><circle cx="${w / 2}" cy="${h / 2}" r="${r}" ` +
      `fill="${icon.fillColor ?? "#000"}" fill-opacity="${icon.fillOpacity ?? 1}" stroke="${icon.strokeColor ?? icon.fillColor ?? "#000"}" ` +
      `stroke-opacity="${icon.strokeOpacity ?? 1}" stroke-width="${sw}"/></svg>`;
  } else if (icon) {
    const o = typeof icon === "string" ? { url: icon } : icon;
    const sz = o.size ?? o.scaledSize;
    w = sz?.width ?? 26; h = sz?.height ?? 26;
    ax = o.anchor?.x ?? w / 2; ay = o.anchor?.y ?? h;
    body = o.origin
      ? `<div style="width:${w}px;height:${h}px;background:url('${o.url}') no-repeat;` +
        `background-size:${o.scaledSize ? `${o.scaledSize.width}px ${o.scaledSize.height}px` : "auto"};` +
        `background-position:${-o.origin.x}px ${-o.origin.y}px"></div>`
      : `<img src="${o.url}" width="${w}" height="${h}" alt="" draggable="false" style="display:block">`;
  } else {
    // Google's default pin, simplified.
    w = 22; h = 32; ax = 11; ay = 32;
    body = '<svg width="22" height="32" viewBox="0 0 22 32" style="display:block"><path d="M11 31C11 31 1 18.5 1 11a10 10 0 0 1 20 0c0 7.5-10 20-10 20Z" fill="#ea4335" stroke="#a52714"/><circle cx="11" cy="11" r="3.6" fill="#a52714"/></svg>';
  }
  const lab = typeof label === "string" ? { text: label } : label;
  const labHtml = lab?.text
    ? `<span class="gmk__label" style="color:${lab.color ?? "#000"};font-size:${lab.fontSize ?? "14px"};font-weight:${lab.fontWeight ?? 400}">${lab.text}</span>`
    : "";
  return {
    html: `<div class="gmk__body" style="left:${-ax}px;top:${-ay}px;width:${w}px;height:${h}px">${body}${labHtml}</div>`,
    top: ay,
  };
}

export class Marker extends Evented {
  constructor(opts = {}) {
    super();
    this._opts = { ...opts };
    this._pos = opts.position ? toLL(opts.position) : null;
    this._visible = opts.visible !== false;
    this._l = L.marker(this._pos ?? [0, 0], {
      icon: this._divIcon(),
      title: opts.title ?? "",
      interactive: opts.clickable !== false,
      keyboard: false,
      zIndexOffset: (opts.zIndex ?? 0) * 1000,
      bubblingMouseEvents: false,
    });
    this._l.on("click mouseover mouseout dblclick", (e) => this._emit(e.type, mouseEvent(e)));
    this._map = null;
    if (opts.map) this.setMap(opts.map);
  }
  _divIcon() {
    const { html, top } = iconHtml(this._opts.icon, this._opts.label);
    this._top = top;
    return L.divIcon({ html, className: "gmk", iconSize: [0, 0], iconAnchor: [0, 0] });
  }
  _sync() {
    const want = this._map && this._visible && this._pos;
    if (want && !this._l._map) this._l.setLatLng(this._pos).addTo(this._map._l);
    else if (!want && this._l._map) this._l.remove();
  }
  setMap(map) { this._map = map || null; if (this._l._map && this._l._map !== this._map?._l) this._l.remove(); this._sync(); }
  getMap() { return this._map; }
  setPosition(p) { this._pos = toLL(p); if (this._pos) this._l.setLatLng(this._pos); this._sync(); }
  getPosition() { return fromLL(this._pos); }
  setIcon(icon) { this._opts.icon = icon; this._l.setIcon(this._divIcon()); }
  setLabel(label) { this._opts.label = label; this._l.setIcon(this._divIcon()); }
  setTitle(t) { this._opts.title = t; this._l.options.title = t; this._l.getElement()?.setAttribute("title", t ?? ""); }
  setVisible(v) { this._visible = !!v; this._sync(); }
  getVisible() { return this._visible; }
  setZIndex(z) { this._l.setZIndexOffset((z ?? 0) * 1000); }
  setOptions(o = {}) {
    if ("icon" in o || "label" in o) { Object.assign(this._opts, o); this._l.setIcon(this._divIcon()); }
    if ("position" in o) this.setPosition(o.position);
    if ("zIndex" in o) this.setZIndex(o.zIndex);
    if ("visible" in o) this.setVisible(o.visible);
    if ("map" in o) this.setMap(o.map);
  }
  /** Pixels from the anchor point up to the icon's top (InfoWindow anchoring). */
  _anchorTop() { return this._top ?? 0; }
}

// ── Polyline / Polygon ──────────────────────────────────────────────────────

function pathStyle(o, closed) {
  const dots = o.icons?.find((i) => i.icon?.path === SymbolPath.CIRCLE);
  if (dots && (o.strokeOpacity ?? 1) === 0) {
    const ic = dots.icon;
    return {
      color: ic.fillColor ?? ic.strokeColor ?? o.strokeColor ?? "#000",
      opacity: ic.fillOpacity ?? 1,
      weight: Math.max(2, (ic.scale ?? 2) * 2),
      dashArray: `0 ${parseFloat(dots.repeat) || 10}`,
      lineCap: "round",
      fill: false,
    };
  }
  // Google's dashed line: an invisible stroke repeating a short line symbol
  // ("M 0,-1 0,1") — a Leaflet dash of the symbol's length.
  const dash = o.icons?.find((i) => i.icon?.path && i.icon.path !== SymbolPath.CIRCLE);
  if (dash && (o.strokeOpacity ?? 1) === 0) {
    const ic = dash.icon;
    const len = (ic.scale ?? 2) * 2;
    return {
      color: ic.strokeColor ?? o.strokeColor ?? "#000",
      opacity: ic.strokeOpacity ?? 1,
      weight: ic.strokeWeight ?? 2,
      dashArray: `${len} ${Math.max(2, (parseFloat(dash.repeat) || 12) - len)}`,
      lineCap: "butt",
      fill: false,
    };
  }
  const s = {
    color: o.strokeColor ?? "#000",
    opacity: o.strokeOpacity ?? 1,
    weight: o.strokeWeight ?? 3,
    lineCap: "round",
    lineJoin: "round",
    dashArray: null,
  };
  s.stroke = s.weight > 0 && s.opacity > 0;
  if (closed) { s.fill = true; s.fillColor = o.fillColor ?? "#000"; s.fillOpacity = o.fillOpacity ?? 0.3; }
  return s;
}

/** Google's MVCArray, enough of it for a polyline's path. */
class PathArray {
  constructor(shape) { this._s = shape; }
  getLength() { return this._s._l.getLatLngs().length; }
  getAt(i) { return fromLL(this._s._l.getLatLngs()[i]); }
  getArray() { return this._s._l.getLatLngs().map(fromLL); }
  push(p) { this._s._l.addLatLng(toLL(p)); return this.getLength(); }
  forEach(cb) { this._s._l.getLatLngs().forEach((ll, i) => cb(fromLL(ll), i)); }
  clear() { this._s._l.setLatLngs([]); }
}

class Shape extends Evented {
  constructor(opts, closed) {
    super();
    this._o = { ...opts };
    this._closed = closed;
    this._z = opts.zIndex ?? 0;
    this._visible = opts.visible !== false;
    this._map = null;
    this._build();
    if (opts.map) this.setMap(opts.map);
  }
  _latlngs() {
    if (this._closed) {
      const ps = this._o.paths ?? this._o.path ?? [];
      const nested = Array.isArray(ps[0]) || (ps[0] && typeof ps[0].getArray === "function");
      return nested ? ps.map((r) => (r.getArray ? r.getArray() : r).map(toLL)) : ps.map(toLL);
    }
    const p = this._o.path ?? [];
    return (p.getArray ? p.getArray() : p).map(toLL);
  }
  _build() {
    const Ctor = this._closed ? L.polygon : L.polyline;
    const was = this._l?._map;
    this._l?.remove();
    this._l = Ctor(this._latlngs(), {
      ...pathStyle(this._o, this._closed),
      interactive: this._o.clickable === true || this._ls.size > 0,
      bubblingMouseEvents: false,
    });
    this._l.on("click mouseover mouseout dblclick", (e) => this._emit(e.type, mouseEvent(e)));
    if (was) this._sync();
  }
  _onListen() {
    if (!this._l.options.interactive) this._build();
  }
  _sync() {
    const want = this._map && this._visible;
    if (want && !this._l._map) { this._l.addTo(this._map._l); this._map._stack(this); }
    else if (!want && this._l._map) this._l.remove();
  }
  setMap(map) { this._map = map || null; if (this._l._map && this._l._map !== this._map?._l) this._l.remove(); this._sync(); }
  getMap() { return this._map; }
  setVisible(v) { this._visible = !!v; this._sync(); }
  getVisible() { return this._visible; }
  setPath(p) { this._o.path = p; this._l.setLatLngs(this._latlngs()); }
  getPath() { return new PathArray(this); }
  setPaths(p) { this._o.paths = p; this._l.setLatLngs(this._latlngs()); }
  setOptions(o = {}) {
    Object.assign(this._o, o);
    if ("zIndex" in o) { this._z = o.zIndex ?? 0; if (this._map) this._map._stack(this); }
    if ("path" in o || "paths" in o) this._l.setLatLngs(this._latlngs());
    if ("clickable" in o && o.clickable && !this._l.options.interactive) { this._build(); return; }
    this._l.setStyle(pathStyle(this._o, this._closed));
    if ("visible" in o) this.setVisible(o.visible);
    if ("map" in o) this.setMap(o.map);
  }
}

export class Polyline extends Shape { constructor(opts = {}) { super(opts, false); } }
export class Polygon extends Shape { constructor(opts = {}) { super(opts, true); } }

// ── Data ────────────────────────────────────────────────────────────────────

class Geometry {
  constructor(g) { this._g = g; }
  getType() { return this._g?.type; }
  get() {
    const g = this._g;
    if (g?.type === "Point") return new LatLng(g.coordinates[1], g.coordinates[0]);
    return g?.coordinates ?? null;
  }
  forEachLatLng(cb) {
    const walk = (c) => {
      if (typeof c[0] === "number") cb(new LatLng(c[1], c[0]));
      else c.forEach(walk);
    };
    if (this._g?.coordinates) walk(this._g.coordinates);
    else this._g?.geometries?.forEach((g) => new Geometry(g).forEachLatLng(cb));
  }
}

class Feature {
  constructor(f) {
    this._f = f;
    this._props = { ...(f.properties ?? {}) };
    this._geom = new Geometry(f.geometry);
    this._layer = null;
  }
  getProperty(k) { return this._props[k]; }
  setProperty(k, v) { this._props[k] = v; }
  getId() { return this._f.id; }
  getGeometry() { return this._geom; }
  forEachProperty(cb) { for (const [k, v] of Object.entries(this._props)) cb(v, k); }
}

export class Data extends Evented {
  constructor(opts = {}) {
    super();
    this._features = [];
    this._style = {};
    this._over = new globalThis.Map();
    this._map = null;
    this._group = L.featureGroup();
    if (opts.map) this.setMap(opts.map);
  }
  setMap(map) {
    map = map || null;
    if (map === this._map) return;
    this._group.remove();
    this._map = map;
    if (map) {
      // Paths were built for the old map's canvas renderer — rebuild for this one.
      for (const f of this._features) this._place(f);
      this._group.addTo(map._l);
    }
  }
  getMap() { return this._map; }
  addGeoJson(gj) {
    const list = gj.type === "FeatureCollection" ? gj.features : [gj];
    const added = [];
    for (const raw of list) {
      if (!raw?.geometry) continue;
      const f = new Feature(raw);
      this._features.push(f);
      added.push(f);
      if (this._map) this._place(f);
    }
    return added;
  }
  _computed(f) {
    const base = typeof this._style === "function" ? this._style(f) ?? {} : this._style ?? {};
    const o = this._over.get(f);
    return o ? { ...base, ...o } : base;
  }
  _place(f) {
    if (f._layer) { this._group.removeLayer(f._layer); f._layer = null; }
    const s = this._computed(f);
    const g = f._f.geometry;
    let layer;
    if (g.type === "Point") {
      const { html } = iconHtml(s.icon ?? { path: SymbolPath.CIRCLE, scale: 4, fillColor: s.fillColor ?? "#000", strokeColor: "#fff", strokeWeight: 1 }, s.label);
      layer = L.marker([g.coordinates[1], g.coordinates[0]], {
        icon: L.divIcon({ html, className: "gmk", iconSize: [0, 0], iconAnchor: [0, 0] }),
        title: s.title ?? "",
        keyboard: false,
        interactive: s.clickable !== false,
        zIndexOffset: (s.zIndex ?? 0) * 1000,
        bubblingMouseEvents: false,
      });
    } else {
      layer = L.geoJSON(g, {
        renderer: this._map?._dataRenderer,
        style: () => this._pathStyle(s),
        interactive: true,
        bubblingMouseEvents: false,
      });
      layer.eachLayer((p) => { p.options.interactive = s.clickable !== false && s.visible !== false; });
    }
    layer.on("click mouseover mouseout", (e) => this._emit(e.type, mouseEvent(e, { feature: f })));
    f._layer = layer;
    f._isPoint = g.type === "Point";
    if (s.visible !== false || !f._isPoint) this._group.addLayer(layer);
  }
  _pathStyle(s) {
    const visible = s.visible !== false;
    const w = s.strokeWeight ?? 1;
    return {
      color: s.strokeColor ?? "#000",
      opacity: visible ? (s.strokeOpacity ?? 1) : 0,
      weight: w,
      stroke: visible && w > 0 && (s.strokeOpacity ?? 1) > 0,
      fillColor: s.fillColor ?? "#000",
      fillOpacity: visible ? (s.fillOpacity ?? 0.3) : 0,
      fill: visible,
    };
  }
  _restyle(f) {
    if (!f._layer || !this._map) return;
    const s = this._computed(f);
    if (f._isPoint) { this._place(f); return; }
    const st = this._pathStyle(s);
    f._layer.eachLayer((p) => {
      p.setStyle(st);
      p.options.interactive = s.clickable !== false && s.visible !== false;
    });
  }
  setStyle(style) { this._style = style; for (const f of this._features) this._restyle(f); }
  getStyle() { return this._style; }
  overrideStyle(f, s) { this._over.set(f, { ...(this._over.get(f) ?? {}), ...s }); this._restyle(f); }
  revertStyle(f) {
    if (f) { this._over.delete(f); this._restyle(f); return; }
    const all = [...this._over.keys()];
    this._over.clear();
    all.forEach((x) => this._restyle(x));
  }
  forEach(cb) { [...this._features].forEach(cb); }
  remove(f) {
    const i = this._features.indexOf(f);
    if (i < 0) return;
    this._features.splice(i, 1);
    if (f._layer) this._group.removeLayer(f._layer);
    this._over.delete(f);
  }
  getFeatureById(id) { return this._features.find((f) => f.getId() === id) ?? null; }
}

// ── InfoWindow ──────────────────────────────────────────────────────────────

class InfoOverlay extends OverlayView {
  constructor(win) { super(); this._win = win; this._div = null; }
  onAdd() {
    const div = document.createElement("div");
    div.className = "map-iw";
    div.innerHTML = '<div class="map-iw__c"></div><div class="map-iw__tc"></div>';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);
    this._div = div;
    this._win._fill(div.firstChild);
    this.getPanes().floatPane.appendChild(div);
  }
  draw() {
    const pos = this._win._at();
    if (!this._div || !pos) return;
    const p = this.getProjection().fromLatLngToDivPixel(pos);
    const off = this._win._anchor?._anchorTop?.() ?? 0;
    this._div.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y - off)}px, 0) translate(-50%, -100%)`;
  }
  onRemove() { this._div?.remove(); this._div = null; }
}

export class InfoWindow extends Evented {
  constructor(opts = {}) {
    super();
    this._content = opts.content ?? null;
    this._pos = opts.position ? toLL(opts.position) : null;
    this._autoPan = !opts.disableAutoPan;
    this._anchor = null;
    this._ov = new InfoOverlay(this);
  }
  _at() { return this._anchor?.getPosition?.() ? toLL(this._anchor.getPosition()) : this._pos; }
  _fill(host) {
    if (!host) return;
    host.replaceChildren();
    const c = this._content;
    if (c instanceof Node) host.appendChild(c);
    else if (c != null) host.innerHTML = String(c);
  }
  setContent(c) { this._content = c; this._fill(this._ov._div?.firstChild); }
  getContent() { return this._content; }
  setPosition(p) { this._pos = toLL(p); this._ov.draw(); }
  getPosition() { return fromLL(this._at()); }
  open(mapOrOpts, anchor) {
    let map = mapOrOpts;
    if (mapOrOpts && !(mapOrOpts instanceof Map)) { map = mapOrOpts.map ?? anchor?.getMap?.(); anchor = mapOrOpts.anchor; }
    this._anchor = anchor ?? null;
    if (!map) map = anchor?.getMap?.();
    if (this._ov.getMap() !== map) this._ov.setMap(map);
    else this._ov.draw();
    this._emit("domready");
    if (this._autoPan) requestAnimationFrame(() => this._panIntoView());
  }
  _panIntoView() {
    const map = this._ov.getMap(), div = this._ov._div;
    if (!map || !div) return;
    const box = div.getBoundingClientRect(), area = map.getDiv().getBoundingClientRect();
    const m = 16;
    const dx = box.left < area.left + m ? box.left - area.left - m : box.right > area.right - m ? box.right - area.right + m : 0;
    const dy = box.top < area.top + m ? box.top - area.top - m : box.bottom > area.bottom - m ? box.bottom - area.bottom + m : 0;
    if (dx || dy) map._l.panBy([dx, dy]);
  }
  close() { this._ov.setMap(null); this._emit("closeclick"); }
  getMap() { return this._ov.getMap(); }
}

// ── reverse geocoding: OSM Nominatim ────────────────────────────────────────
// Its usage policy allows one request a second; callers already cache by
// ~11 m, and this queue keeps the pace whatever they do.

let geoChain = Promise.resolve();
export class Geocoder {
  geocode({ location }, cb) {
    const ll = toLL(location);
    geoChain = geoChain.then(async () => {
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=17&lat=${ll.lat}&lon=${ll.lng}`,
          { headers: { "Accept-Language": "en" } });
        const j = r.ok ? await r.json() : null;
        cb(j?.display_name ? [{ formatted_address: j.display_name }] : [], j?.display_name ? "OK" : "ZERO_RESULTS");
      } catch {
        cb([], "ERROR");
      }
      await new Promise((res) => setTimeout(res, 1100));
    });
  }
}

// ── the namespace ───────────────────────────────────────────────────────────

// ── TileOverlay ─────────────────────────────────────────────────────────────
// Not a Google class: a slippy-map raster ({z}/{x}/{y} URL) drawn over the base
// map and under every vector and marker. TomTom's traffic flow and incident
// tiles are the reason it exists.

export class TileOverlay {
  constructor({ url, opacity = 1, zIndex = 0, minZoom = 0, maxZoom = 22, maxNativeZoom = 22, tileSize = 256, zoomOffset = 0, params = {} } = {}) {
    // `params` fills extra {placeholders} in the URL; a function is called per
    // tile, so a cache-buster can change between refreshes.
    this._l = L.tileLayer(url, {
      ...params,
      pane: "g-tiles", opacity, zIndex, minZoom, maxZoom, maxNativeZoom, tileSize, zoomOffset,
      keepBuffer: 2, updateWhenZooming: false, crossOrigin: true,
    });
    this._map = null;
  }
  setMap(map) {
    map = map || null;
    if (map === this._map) return;
    this._l.remove();
    this._map = map;
    if (map) this._l.addTo(map._l);
  }
  getMap() { return this._map; }
  setOpacity(o) { this._l.setOpacity(o); }
  /** Re-fetch every tile, for data that goes stale (live traffic). */
  refresh() { if (this._map) this._l.redraw(); }
  on(name, fn) { this._l.on(name, fn); return () => this._l.off(name, fn); }
}

export const maps = {
  Map, OverlayView, TileOverlay, Marker, Polyline, Polygon, Data, InfoWindow,
  LatLng, LatLngBounds, Size, Point, SymbolPath, Geocoder, event,
};

/** Kept async so callers written for a script loader keep their shape. */
export function loadMapEngine() {
  return Promise.resolve(maps);
}
