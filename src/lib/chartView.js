// The stretch of a day a time chart shows, moved by the mouse wheel.
//
// Operator, 28 Sep: the fuel chart should zoom on the mouse's scroll wheel.
// A view is [from, to] in ms; `day` is [first, last] reading. Both return
// null when the view would not change, so the caller can let the wheel scroll
// the page instead: at the whole day, rolling out goes to the panel.

const WHOLE_SNAP = 0.97;   // a view this close to the whole day is the whole day

/**
 * Zoom by `factor` (under 1 in, over 1 out) about `at`, which stays under the
 * pointer. The view stays inside the day and no narrower than `minSpan`.
 */
export function zoomView(view, day, at, factor, minSpan) {
  const [from, to] = view;
  // A view opened on an event may run past the day's ends; it may stay there.
  const lo = Math.min(day[0], from), hi = Math.max(day[1], to);
  const span = to - from;
  const next = Math.round(Math.min(hi - lo, Math.max(Math.min(minSpan, hi - lo), span * factor)));
  if (!(span > 0) || Math.abs(next - span) < 1) return null;
  // Out to (nearly) the whole day lands on its ends exactly. Three notches out
  // from FT 01's pan stopped 1 ms short of them, which left the chart zoomed
  // with "Whole day" still offered and no stretch left worth showing.
  if (next >= (hi - lo) * WHOLE_SNAP) return [lo, hi];
  const a = Math.round(Math.min(hi - next, Math.max(lo, at - ((at - from) / span) * next)));
  return [a, a + next];
}

/** Slide the view `dt` ms along the day, stopping at its ends. */
export function panView(view, day, dt) {
  const [from, to] = view;
  const lo = Math.min(day[0], from), hi = Math.max(day[1], to);
  const a = Math.round(Math.min(hi - (to - from), Math.max(lo, from + dt)));
  return Math.abs(a - from) < 1 ? null : [a, a + (to - from)];
}

/** True when `view` shows the whole of `day`, so the chart is not zoomed. */
export const isWholeDay = (view, day) => view[0] <= day[0] && view[1] >= day[1];

/**
 * A wheel event's movement in pixels. Firefox counts a mouse notch in lines
 * and some mice in pages; Shift turns a vertical wheel into a sideways one,
 * as it does for scrolling elsewhere.
 */
export function wheelPixels({ deltaX = 0, deltaY = 0, deltaMode = 0, shiftKey = false }) {
  const k = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  return shiftKey && !deltaX ? { x: deltaY * k, y: 0 } : { x: deltaX * k, y: deltaY * k };
}

/** One notch of a mouse wheel (~100 px) zooms by about a quarter. */
export const zoomFactor = (px) => Math.exp(Math.max(-300, Math.min(300, px)) * 0.0028);
