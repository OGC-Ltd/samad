// The application renders at a fixed 90% scale.
//
// ## Why this exists at all
//
// The dashboard was judged to read better at a browser zoom of 90% — more of
// the map and more rows of every table on screen, at a text size that is still
// comfortable — and that is now the default at 100%. One CSS property does it:
// `zoom` on the app root. It is the same mechanism the browser's own zoom uses,
// so the result is the thing that was liked rather than an imitation of it: the
// app lays out in 1/0.9 as many pixels and every one of them is drawn at 0.9.
// Measured on a 1440px window, the app receives 1600px of layout and paints it
// back into 1440.
//
// `transform: scale()` is the usual suggestion and is the wrong tool. It scales
// the PAINT and not the layout, so the page keeps its 1440px of room and simply
// gets smaller, leaving a 10% band of blank at two edges; it also blurs text on
// fractional device ratios and makes the element a containing block for
// `position: fixed`, which every floating panel in this app relies on.
//
// ## Why callers have to care
//
// `zoom` leaves the page with TWO pixel scales, and this module exists to keep
// them apart:
//
//   · LAYOUT px — what CSS lengths mean inside the zoomed tree. `left: 360px`,
//     `width: 264px`, `el.offsetWidth`. Every stylesheet and every constant in
//     this codebase is already in these.
//   · SCREEN px — what the pointer and the viewport are measured in.
//     `e.clientX`, `getBoundingClientRect()`, `window.innerWidth`. These are
//     NOT affected by the zoom.
//
// Reading a pointer position and writing it straight back as a CSS length
// therefore lands the element 10% short. Measured, not assumed: an element
// sitting at a client x of 360 and given `left: 360px` inside a 0.9 tree
// re-renders at 324 — a 36px jump the moment a drag begins.
//
// The rule this module enforces is one-way and applies at the INPUTS:
// everything arriving from the pointer, from a client rect or from the viewport
// is converted to layout px here, and nothing else changes. Constants stay as
// they are, writes stay as they are, and the arithmetic in between never has to
// know which scale it is in.
//
// Setting `--app-zoom: 1` turns all of it back into identity functions.

let cached = null;

/**
 * The scale currently applied to the app root.
 *
 * Read from the stylesheet rather than duplicated here, so the number lives in
 * exactly one place and a change to the CSS cannot leave the coordinate maths
 * believing something else. Cached: it is read on every pointer move during a
 * drag, and `getComputedStyle` is not free.
 *
 * Falls back to 1 with no DOM (unit tests) and on any value that is not a
 * positive number — an unusable zoom must degrade to "no zoom", never to NaN
 * spreading into a style attribute.
 */
export function appZoom() {
  if (cached != null) return cached;
  if (typeof document === "undefined" || !document.documentElement) return 1;
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--app-zoom");
  const z = Number.parseFloat(raw);
  cached = Number.isFinite(z) && z > 0 ? z : 1;
  return cached;
}

/** Testing seam, and the reset a theme switch would need if the zoom ever
 *  became a user setting. */
export function resetAppZoom() { cached = null; }

/** A screen length — a client coordinate, a rect edge — as a CSS length inside
 *  the zoomed tree. */
export const toLayoutPx = (px, z = appZoom()) => px / z;

/** A pointer event's position, in layout px. */
export const pointerXY = (e, z = appZoom()) => ({ x: e.clientX / z, y: e.clientY / z });

/** A client rect, in layout px. Returns a plain object: DOMRect is read-only,
 *  and callers destructure rather than pass it on. */
export function rectXY(r, z = appZoom()) {
  if (!r) return null;
  return {
    left: r.left / z, top: r.top / z, right: r.right / z, bottom: r.bottom / z,
    width: r.width / z, height: r.height / z,
  };
}

/** The viewport, in layout px — the space the app actually lays out in.
 *
 *  The dimensions are parameters with the live window as their default, so the
 *  arithmetic can be pinned without a DOM. This project runs its unit tests in
 *  `node` on purpose (see vite.config.js) and an injectable default is cheaper
 *  than the jsdom that note is holding the line against. */
export const layoutViewport = (
  z = appZoom(),
  w = typeof window === "undefined" ? 0 : window.innerWidth,
  h = typeof window === "undefined" ? 0 : window.innerHeight,
) => ({ width: w / z, height: h / z });
