// Placement, dragging and persistence for a window floating over the map.
//
// Extracted because there were two of these and they disagreed. The fuel
// incident window (MapOverlay) and the playback transport each grew their own
// drag, their own viewport clamp and their own idea of where to open — so a
// fix to one never reached the other, and the playback panel shipped without
// the position persistence the incident window had had for months.
//
// ## Docks
//
// A window opens at a NAMED PLACE rather than at coordinates it chose for
// itself. That is the difference between an interface that looks arranged and
// one that looks like several features landed on the same screen: two windows
// asking for "bottom, centred" get the same edge, and moving that edge once
// moves both.
//
// Docks are resolved against the SAFE AREA, not the viewport and not the map's
// own box, because the map's box is not what the operator can see of it.
//
// ## The safe area
//
// The map div spans the whole width, but MapOverlay pins a 336px rail down the
// left and a 340px rail down the right — 53% of a 1280px screen — the header
// sits above it and the footer nav is fixed across the bottom. A window placed
// or dragged into any of those lands BEHIND furniture: still on screen by the
// viewport's reckoning, and unreadable, unclickable, or gone.
//
// So every placement — dock, drag, restore, resize — is clamped to the
// rectangle that is actually free. Measured, not assumed: the rails are hidden
// outright on the mobile shell, and a hardcoded 336/340 there would push every
// window into the middle third of a phone.
//
// A window WIDER than the free rectangle (the pinned incident window is 680px
// against 580px of free column at 1280) is pinned to the area's left edge
// rather than shoved off the left trying to fit its right edge in. The real
// fix for that one is to cap its width — see --safe-w below.

import { rectXY, pointerXY, layoutViewport } from "../lib/appZoom";
import { useCallback, useEffect, useRef } from "react";

/** Fixed footer nav height, plus air. See .footer-nav — measured at 64px. */
const FOOTER_INSET = 80;
/** Clearance from every edge of the free area. */
const EDGE = 12;
/** Top band, occupied by the map's own controls and the focus pill. */
const TOP_BAND = 56;
/**
 * Below this the rails are not leaving usable space, so respecting them would
 * strand every window in a sliver. Under it the area falls back to the map's
 * whole box — overlapping a rail beats being unreadable.
 */
const MIN_FREE = 240;

/** A rect with zero area is an element that is display:none or unmounted.
 *
 *  Returned in LAYOUT px. Client rects are screen px, and everything this file
 *  goes on to do with them — comparing against `el.offsetWidth`, writing a
 *  `left` — is in layout px. See src/lib/appZoom.js. */
const liveRect = (sel) => {
  const r = document.querySelector(sel)?.getBoundingClientRect();
  return r && r.width > 0 && r.height > 0 ? rectXY(r) : null;
};

/**
 * The geometry, with the measuring taken out.
 *
 * Separated from `safeArea` so it can be tested: the arithmetic here is where
 * every "window ended up behind a rail" bug lives, and the alternative is
 * either no test at all or pulling in a DOM environment this project does not
 * have. Pass rects; get the free rectangle back.
 *
 * @param {object}  m
 * @param {DOMRect} m.base       the map's box, or the viewport where it has none
 * @param {?DOMRect} m.leftRail  null when absent — the mobile shell hides both
 * @param {?DOMRect} m.rightRail
 * @param {?DOMRect} m.footer    the FIXED nav; its top is the real floor
 */
export function computeSafeArea({ base, leftRail = null, rightRail = null, footer = null }) {
  let left   = (leftRail  ? Math.max(base.left,  leftRail.right) : base.left)  + EDGE;
  let right  = (rightRail ? Math.min(base.right, rightRail.left) : base.right) - EDGE;
  let top    = base.top + TOP_BAND;
  // The nav is FIXED, so it floors the area wherever the map claims to end.
  let bottom = (footer ? Math.min(base.bottom, footer.top) : base.bottom - FOOTER_INSET) - EDGE;

  if (right - left < MIN_FREE) { left = base.left + EDGE; right = base.right - EDGE; }
  if (bottom - top < MIN_FREE) { top = base.top + EDGE; bottom = base.bottom - EDGE; }

  /**
   * Never a NEGATIVE rectangle, whatever was measured.
   *
   * The fallback above widens to the map's own box, which does not help when
   * that box is itself zero — a 0x0 map still yields 12 .. -12, i.e. a width of
   * -24. It is a real state: an element in a laid-out document that has not
   * been given a size yet, or a host that reports a zero viewport (the browser
   * pane does exactly this when its emulation is cleared, which is how this was
   * found). A negative --safe-w makes `width: min(560px, -24px)` collapse every
   * floating window to nothing, and nothing on screen is much worse than a
   * window in a slightly wrong place.
   */
  const width  = Math.max(0, right - left);
  const height = Math.max(0, bottom - top);
  return { left, top, right, bottom, width, height };
}

/**
 * The rectangle a floating window may occupy, in VIEWPORT coordinates —
 * the windows are `position: fixed`.
 *
 * Falls back to the viewport when the map is not measurable, which is its
 * state whenever its tab is hidden: `.app-tab-panel--hidden` is display:none,
 * so every rect in the subtree is 0×0 and the arithmetic would otherwise put
 * NaN into a style attribute.
 */
export function safeArea() {
  return computeSafeArea({
    base: liveRect(".fleet-map-body") ?? {
      left: 0, top: 0, right: layoutViewport().width, bottom: layoutViewport().height,
    },
    // The map's tool rail (MapToolRail) stands in for a left rail where the
    // overlay's own is not drawn, so a window opens beside it, not over it.
    leftRail:  liveRect(".overlay-left") ?? liveRect(".mtr-card"),
    rightRail: liveRect(".overlay-right"),
    /* Same pair as in publishSafeAreaVars, for the same reason: `.footer-nav`
       is never mounted, so on a phone this read "no footer" and let a window
       be dropped underneath the tab bar. */
    footer:    liveRect(".footer-nav") ?? liveRect(".mobile-tab-bar"),
  });
}

/**
 * Where each dock puts a window of size w×h inside the safe area `a`.
 *
 * The insets live in `safeArea` now, so a dock is just an anchor. When they
 * were baked in here each dock applied its own subset — "bottom-right" took
 * EDGE off the right but "bottom-center" took none — and the two disagreed
 * about where the right-hand edge was.
 */
export const DOCKS = {
  "top-center":    (a, w)    => ({ x: a.left + (a.width - w) / 2, y: a.top }),
  "bottom-center": (a, w, h) => ({ x: a.left + (a.width - w) / 2, y: a.bottom - h }),
  "bottom-right":  (a, w, h) => ({ x: a.right - w,                y: a.bottom - h }),
  center:          (a, w, h) => ({ x: a.left + (a.width - w) / 2, y: a.top + (a.height - h) / 2 }),
};

/**
 * Keep a window inside the safe area — after a drag, a resize, a restore from
 * localStorage, or a move to a smaller monitor.
 *
 * The inner `Math.max` is what handles a window too big for the area: without
 * it, `right - w` is left of `left`, and the window would be pushed off the
 * LEFT edge in the course of fitting its right edge in.
 */
export function clampInto(a, x, y, w, h) {
  return {
    x: Math.min(Math.max(a.left, x), Math.max(a.left, a.right - w)),
    y: Math.min(Math.max(a.top, y), Math.max(a.top, a.bottom - h)),
  };
}

export function clampToSafeArea(x, y, w, h) {
  return clampInto(safeArea(), x, y, w, h);
}

/**
 * Publish the safe area as CSS variables, so a window can cap its own SIZE
 * against it rather than only its position.
 *
 * Clamping alone cannot keep a 680px window out of a 580px column; something
 * has to give, and it has to be the width. CSS is where that belongs — a
 * `min()` in the stylesheet beside the width it is capping, rather than an
 * inline style fighting it.
 */
export function publishSafeAreaVars() {
  const a = safeArea();
  const s = document.documentElement.style;

  /**
   * The bottom nav's height, published FIRST and unconditionally.
   *
   * App.jsx already publishes `--header-h` this way and everything above the
   * map reads it; the bottom had no equivalent, so anything sitting there
   * hardcoded a number — the map's control rail hardcoded `bottom: 16px`
   * against a nav that is 60px tall and fixed at z-index 1000, and its lowest
   * button rendered underneath it.
   *
   * Measured, because it is not one number: 64px on desktop, 60px on a phone,
   * and zero where the nav is not mounted. Independent of the safe area, and so
   * published before the degenerate check below — a map that has not been laid
   * out yet says nothing about the height of a nav that has.
   *
   * BOTH selectors, and this is the bug that made every rule below the map
   * wrong on a phone. `.footer-nav` belongs to components/footer/FooterNav,
   * which nothing imports and nothing mounts — so `liveRect` always returned
   * null and this always published `0px`. A published 0 is not the same as not
   * publishing: every consumer is written `var(--footer-h, 64px)`, and a
   * property that IS set to 0px satisfies the var() and throws the fallback
   * away. So the map's rail panels and its "Close map" pill positioned
   * themselves against a 0px nav on a device whose nav is 110px, and opened
   * straight through the bar that covers them.
   *
   * The bar a phone actually renders is `.mobile-tab-bar` (MobileTabBar.jsx).
   * Whichever of the two is on the page is the one measured; if neither is,
   * the height really is zero and 0px is the honest answer.
   */
  const footer = liveRect(".footer-nav") ?? liveRect(".mobile-tab-bar");
  s.setProperty("--footer-h", `${Math.round(footer?.height ?? 0)}px`);

  /**
   * A degenerate measurement publishes NOTHING, so the CSS fallbacks apply.
   *
   * Every consumer is written `var(--safe-w, calc(100vw - 32px))` — the second
   * argument exists precisely for "we do not know yet". Publishing a 0 instead
   * satisfies the `var()` and collapses every floating window to nothing, which
   * is far worse than a window sized slightly wrong.
   *
   * Reachable: an element in a laid-out document before it has been given a
   * size, and a host reporting a zero viewport — the browser pane does exactly
   * that when its size emulation is cleared, which is how this was found.
   */
  if (a.width < MIN_FREE || a.height < MIN_FREE) {
    for (const k of ["--safe-left", "--safe-top", "--safe-w", "--safe-h"]) s.removeProperty(k);
    return;
  }

  s.setProperty("--safe-left", `${Math.round(a.left)}px`);
  s.setProperty("--safe-top", `${Math.round(a.top)}px`);
  s.setProperty("--safe-w", `${Math.round(a.width)}px`);
  s.setProperty("--safe-h", `${Math.round(a.height)}px`);
}

/**
 * Keep those variables current. Call ONCE, from the component that owns the
 * map.
 *
 * `key` forces a recompute when something other than a resize changed the
 * layout — switching tabs especially: the map measures 0×0 while its tab is
 * hidden, and no resize event fires on the way back.
 */
export function useSafeAreaVars(key) {
  useEffect(() => {
    publishSafeAreaVars();

    /**
     * `visualViewport` as well as `resize`, for phones.
     *
     * A mobile browser's URL bar sliding away changes what is on screen without
     * reliably firing a window `resize` — Safari in particular. That is the
     * moment the fixed footer moves and everything measured against it goes
     * stale, so it is exactly the moment this has to re-run.
     *
     * `orientationchange` fires before the new dimensions are readable on some
     * Androids, hence the frame of delay: measuring in the handler returns the
     * OLD box and publishes a landscape layout's numbers for a portrait screen.
     */
    const vv = window.visualViewport ?? null;
    const later = () => requestAnimationFrame(publishSafeAreaVars);

    window.addEventListener("resize", publishSafeAreaVars);
    window.addEventListener("orientationchange", later);
    vv?.addEventListener("resize", publishSafeAreaVars);
    vv?.addEventListener("scroll", publishSafeAreaVars);

    return () => {
      window.removeEventListener("resize", publishSafeAreaVars);
      window.removeEventListener("orientationchange", later);
      vv?.removeEventListener("resize", publishSafeAreaVars);
      vv?.removeEventListener("scroll", publishSafeAreaVars);
    };
  }, [key]);
}

const keyFor = (id) => `ft-win:${id}`;

export function readWindowPos(id) {
  if (!id) return null;
  try {
    const v = JSON.parse(localStorage.getItem(keyFor(id)) || "null");
    return v && typeof v.x === "number" && typeof v.y === "number" ? v : null;
  } catch { return null; }
}

function writeWindowPos(id, v) {
  if (!id) return;
  try { localStorage.setItem(keyFor(id), JSON.stringify(v)); } catch { /* quota */ }
}

/**
 * How far the pointer must travel before a press counts as a drag.
 *
 * Real drags cross this immediately; a click that jitters a pixel does not.
 * Without it the window creeps every time a control near the title bar is
 * used. Same value the incident window arrived at independently.
 */
const DRAG_SLOP = 3;

/**
 * @param {object}  opts
 * @param {string}  [opts.id]   persistence key; omit for a window that always
 *                              opens at its dock
 * @param {string}  [opts.dock] one of DOCKS; default "bottom-center"
 * @param {boolean} [opts.enabled] false leaves the node alone entirely
 */
/**
 * @param {object}   [opts.initial] `{x, y}` to open at instead of the dock —
 *   for a window about a THING the operator just clicked, which should appear
 *   near it rather than at a fixed edge. A remembered position still wins: a
 *   window someone deliberately placed stays placed.
 */
export function useFloatingWindow({ id, dock = "bottom-center", enabled = true, initial } = {}) {
  const ref = useRef(null);
  const dragRef = useRef(null);
  const placedRef = useRef(false);

  /** Write a position onto the node. The node is the source of truth while a
   *  drag is in flight — state would re-render on every pointer move, and this
   *  panel owns controls the user may be mid-gesture on. */
  const place = useCallback((x, y) => {
    const el = ref.current;
    if (!el) return;
    // Measured size, never a default: guessing small on a 560px window would
    // let the clamp allow positions most of the way off the right edge.
    const c = clampToSafeArea(x, y, el.offsetWidth, el.offsetHeight);
    el.style.left = `${c.x}px`;
    el.style.top = `${c.y}px`;
    el.style.right = "auto";
    el.style.bottom = "auto";
    el.style.transform = "none";
  }, []);

  // Initial placement: a remembered position if there is one, otherwise the
  // dock. Runs once — a re-render must not yank a window the user has moved.
  useEffect(() => {
    // Disabled means the window is not up. Clearing the guard lets the NEXT
    // opening place itself again — without this, pinning a second unit would
    // leave its card wherever the first one was left.
    if (!enabled) { placedRef.current = false; return; }
    const el = ref.current;
    if (!el || placedRef.current) return;
    placedRef.current = true;

    const w = el.offsetWidth, h = el.offsetHeight;
    const saved = readWindowPos(id);
    if (saved) { place(saved.x, saved.y); return; }
    if (initial) { place(initial.x, initial.y); return; }

    const fn = DOCKS[dock] ?? DOCKS["bottom-center"];
    const p = fn(safeArea(), w, h);
    place(p.x, p.y);
  }, [enabled, id, dock, initial, place]);

  // A shrinking window can strand a fixed panel off-screen, and off-screen
  // means unreachable — the only way back is the drag handle it took with it.
  useEffect(() => {
    if (!enabled) return undefined;
    const onResize = () => {
      const el = ref.current;
      if (!el || !placedRef.current) return;
      const r = rectXY(el.getBoundingClientRect());
      place(r.left, r.top);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [enabled, place]);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (!placedRef.current) return;
      const box = rectXY(el.getBoundingClientRect());
      place(box.left, box.top);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [enabled, place]);

  /**
   * Press, hold, move.
   *
   * Listeners live on WINDOW and exist only for the duration of a drag. As
   * React handlers on the header, `onPointerMove` fires on every HOVER — so
   * the gesture depended on drag state having been cleared correctly, and any
   * release the header did not see left the panel following the mouse.
   *
   * Deliberately NOT setPointerCapture. The incident window uses it and had to
   * add an explicit `closest('button')` bail-out, because capture redirects the
   * later events to the bar so `pointerup` lands there instead of on the
   * button — the browser then fires `click` on the common ancestor and the
   * button's onClick never runs, silently. Window listeners have no such
   * problem: the button keeps its own pointer sequence.
   */
  const onPointerDown = useCallback((e) => {
    if (!enabled) return;
    if (e.button != null && e.button !== 0) return;
    // Controls inside the drag handle keep their press.
    if (e.target.closest("button, input, select, a, [role=slider]")) return;

    const el = ref.current;
    if (!el) return;
    /* Layout px from here down. The grab offset is a pointer position minus a
       box edge, and under `zoom` those arrive in different scales — the rect is
       already shrunk and the pointer is not — so subtracting them raw puts the
       window 10% of its own position away from the cursor the instant it is
       picked up. Measured at 36px on a box sitting at x=360. */
    const box = rectXY(el.getBoundingClientRect());
    const p0 = pointerXY(e);
    dragRef.current = {
      dx: p0.x - box.left, dy: p0.y - box.top,
      x0: p0.x, y0: p0.y, active: false,
    };

    const onMove = (ev) => {
      const d = dragRef.current;
      const node = ref.current;
      if (!d || !node) return;
      const p = pointerXY(ev);
      if (!d.active) {
        /* The slop is a distance in CSS px and is compared in them: at 90% a
           screen-px threshold would mean the window jumps after 10% less
           travel than the constant says. */
        if (Math.hypot(p.x - d.x0, p.y - d.y0) < DRAG_SLOP) return;
        d.active = true;
        node.classList.add("is-dragging");
      }
      place(p.x - d.dx, p.y - d.dy);
    };

    const onUp = () => {
      const d = dragRef.current;
      const node = ref.current;
      dragRef.current = null;
      node?.classList.remove("is-dragging");
      // Only a real drag is worth remembering. Persisting on every press would
      // save the dock position back over itself on each click of the header.
      if (d?.active && node) {
        /* Stored in layout px, which is what `place` takes — so a position
           remembered at one zoom is restored to the same spot. */
        const r = rectXY(node.getBoundingClientRect());
        writeWindowPos(id, { x: r.left, y: r.top });
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    // A cancelled pointer — the browser taking over for a gesture, a device
    // lost — must end the drag, or the listeners outlive it and the window
    // follows the next mouse move.
    window.addEventListener("pointercancel", onUp);
  }, [enabled, id, place]);

  useEffect(() => () => { dragRef.current = null; }, []);

  return { ref, onPointerDown };
}
