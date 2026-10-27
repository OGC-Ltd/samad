// Where a unit can be seen with windows open over the map.
//
// A click on a fuel alert zooms to the unit and opens its incident window and
// its side panel (operator, 2026-09-28: "when the modal is opened then we also
// need to zoom into the vehicle"). The zoom was already there, but it put the
// unit in the middle of the map, which is exactly where the incident window
// sits, with the side panel over the map's right-hand side. The camera moved
// and the unit stayed hidden. Now, once the window and the panel have settled,
// the map glides the unit into the middle of the largest part of the map that
// nothing covers.
//
// The rectangle arithmetic is pure, so it is tested without a DOM. Every rect
// is {left, top, right, bottom} in one pixel scale.

import { rectXY } from './appZoom';

const edges = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
const w = (r) => r.right - r.left;
const h = (r) => r.bottom - r.top;
const overlaps = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * The largest rectangles of `area` that no cover touches. They overlap one
 * another: around a window in the middle there is a full-height strip each
 * side of it and a full-width strip above and below.
 */
export function clearRects(area, covers) {
  let free = [edges(area)];
  for (const c of covers) {
    const next = [];
    for (const r of free) {
      if (!overlaps(r, c)) { next.push(r); continue; }
      if (c.left > r.left) next.push({ ...r, right: c.left });
      if (c.right < r.right) next.push({ ...r, left: c.right });
      if (c.top > r.top) next.push({ ...r, bottom: c.top });
      if (c.bottom < r.bottom) next.push({ ...r, top: c.bottom });
    }
    free = next;
  }
  return free;
}

/** The biggest clear rectangle at least `min` px each way, or null. */
export function clearestRect(area, covers, min = 80) {
  let best = null;
  for (const r of clearRects(area, covers)) {
    if (w(r) < min || h(r) < min) continue;
    if (!best || w(r) * h(r) > w(best) * h(best)) best = r;
  }
  return best;
}

/**
 * How far from the map's centre, in px, the unit now at the centre should be
 * drawn so it can be seen. {x: 0, y: 0} when it already can be: nothing covers
 * the centre or the `margin` around it, which is room for the marker itself.
 * Null when no clear part is big enough to be worth moving to.
 */
export function clearOffset(area, covers, { min = 80, margin = 28 } = {}) {
  const cs = covers.filter((c) => c && w(c) > 0 && h(c) > 0).map(edges);
  const cx = (area.left + area.right) / 2;
  const cy = (area.top + area.bottom) / 2;
  const spot = { left: cx - margin, top: cy - margin, right: cx + margin, bottom: cy + margin };
  if (!cs.some((c) => overlaps(c, spot))) return { x: 0, y: 0 };
  const r = clearestRect(area, cs, min);
  if (!r) return null;
  return { x: (r.left + r.right) / 2 - cx, y: (r.top + r.bottom) / 2 - cy };
}

// ── On the live map ─────────────────────────────────────────────────────────

/** How long to wait for the window and the panel to stop moving. */
const SETTLE_MAX_MS = 900;
let pending = null;

/**
 * Glide `map` so the unit at `pos` sits clear of the incident window and the
 * side panel. Call straight after centring the map on it.
 *
 * Waits until their layout has stopped changing for a couple of frames rather
 * than guessing their final sizes: the panel slides in over 260 ms (a sheet on
 * a phone), and from 1280px up the map itself narrows while it does. Gives up
 * if the reader drags the map first, because then they are steering. A second
 * call replaces the first.
 */
export function panClearOfWindows(map, pos) {
  pending?.();
  if (!map || !pos) return;

  let raf = 0;
  let last = '';
  let still = 0;
  const t0 = performance.now();
  const stop = () => {
    cancelAnimationFrame(raf);
    drag.remove();
    if (pending === stop) pending = null;
  };
  const drag = map.addListener('dragstart', stop);
  pending = stop;

  const box = (el) => rectXY(el.getBoundingClientRect());
  const tick = () => {
    const area = box(map.getDiv());
    const windows = [...document.querySelectorAll('.fi-modal')];
    const covers = [...windows, ...document.querySelectorAll('.vdp--open')].map(box);
    const key = [area, ...covers].map((r) => `${r.left.toFixed(1)},${r.top.toFixed(1)},${r.right.toFixed(1)},${r.bottom.toFixed(1)}`).join('|');
    still = key === last ? still + 1 : 0;
    last = key;
    if (!(windows.length && still >= 2) && performance.now() - t0 < SETTLE_MAX_MS) {
      raf = requestAnimationFrame(tick);
      return;
    }
    stop();

    const off = clearOffset(area, covers);
    const proj = map.getProjection();
    if (!off || (!off.x && !off.y) || !proj) return;
    // The centre that draws the unit `off` px from it, worked out from the
    // unit rather than from wherever the camera is now.
    const scale = 2 ** map.getZoom();
    const p = proj.fromLatLngToPoint({ lat: pos.lat, lng: pos.lng });
    map.panTo(proj.fromPointToLatLng({ x: p.x - off.x / scale, y: p.y - off.y / scale }));
  };
  raf = requestAnimationFrame(tick);
}
