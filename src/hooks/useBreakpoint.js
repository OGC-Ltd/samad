/**
 * One place that decides what size of screen this is.
 *
 * ## Why a hook and not just CSS
 *
 * Most of the layout IS done in CSS — see `src/index.css` for the breakpoint
 * tokens these names mirror. What CSS cannot do is change component BEHAVIOUR:
 * the vehicle panel has to be an inline column on a desktop and a dismissable
 * overlay on a tablet, the sidebar has to start collapsed below a certain
 * width, and the map has to know whether its floating rails have a bottom tab
 * bar to clear. Those are decisions about what to render, not how to paint it.
 *
 * ## matchMedia, not a resize listener
 *
 * A `resize` listener fires on every intermediate pixel while a window is
 * dragged — hundreds of renders across a 597-unit fleet — and it also fires
 * when a mobile browser's address bar slides away, which is not a layout
 * change. `matchMedia` fires only when a threshold is actually crossed.
 *
 * The queries are kept mutually exclusive so exactly one of `isMobile`,
 * `isTablet` and `isDesktop` is ever true. When they overlapped, a 768px
 * viewport counted as both and rendered the sidebar and the mobile tab bar at
 * once.
 */

import { useEffect, useState } from 'react';

// Keep in step with the `--bp-*` tokens in index.css. Both exist because CSS
// cannot read a JS constant and JS cannot read a media query's breakpoint.
export const BP = {
  /* A HANDSET, which is not the same question as `mobile`.
     `mobile` (767) decides the app's chrome — the bottom tab bar, the 44px tap
     floors — and an iPad mini at 744 x 1133 wants all of that. What it does NOT
     want is the phone LAYOUT: a data grid folded into one card per row, filters
     behind a button. It has 744px across and 1,133px down, so it can read a
     table. 599 is above every phone in portrait (the widest is 430) and below
     every iPad (the narrowest is the mini's 744), which is the split the grid
     actually cares about. A phone in landscape is wider than this and keeps the
     table, as it did before any of this existed. */
  handset: 599,
  mobile:  767,   // phones — mobile chrome, bottom tab bar
  tablet:  1023,  // portrait tablets and small landscape phones
  laptop:  1279,  // small laptops — sidebar starts collapsed, panel overlays
};

const QUERIES = {
  isHandset:      `(max-width: ${BP.handset}px)`,
  isMobile:       `(max-width: ${BP.mobile}px)`,
  isTablet:       `(min-width: ${BP.mobile + 1}px) and (max-width: ${BP.tablet}px)`,
  isLaptop:       `(min-width: ${BP.tablet + 1}px) and (max-width: ${BP.laptop}px)`,
  isDesktop:      `(min-width: ${BP.laptop + 1}px)`,
  // Convenience unions — the ones components actually branch on.
  isCompact:      `(max-width: ${BP.tablet}px)`,   // mobile OR tablet
  isNarrow:       `(max-width: ${BP.laptop}px)`,   // anything below full desktop
  // A short landscape phone: the tab bar plus a sheet would leave no map at
  // all, so sheets cap their own height against this.
  isShort:        `(max-height: 560px)`,
  prefersReduced: `(prefers-reduced-motion: reduce)`,
};

function read() {
  // SSR and the vitest jsdom environment have no matchMedia. Defaulting to
  // desktop keeps tests rendering the full shell rather than the mobile one.
  if (typeof window === 'undefined' || !window.matchMedia) {
    return { isHandset: false, isMobile: false, isTablet: false, isLaptop: false,
             isDesktop: true, isCompact: false, isNarrow: false, isShort: false,
             prefersReduced: false };
  }
  const out = {};
  for (const [name, q] of Object.entries(QUERIES)) out[name] = window.matchMedia(q).matches;
  return out;
}

export function useBreakpoint() {
  const [state, setState] = useState(read);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const lists = Object.values(QUERIES).map((q) => window.matchMedia(q));
    // One handler re-reads all of them. Reading each list's own `matches` in
    // its own handler raced: two queries flip in the same frame when a
    // threshold is crossed, and whichever landed second overwrote the first.
    const onChange = () => setState(read());

    for (const l of lists) {
      // Safari below 14 has only the deprecated addListener.
      if (l.addEventListener) l.addEventListener('change', onChange);
      else l.addListener(onChange);
    }
    // Re-read once on mount: the first render used whatever the queries said
    // before hydration, and on a phone that can be a frame behind the real
    // viewport height.
    onChange();

    return () => {
      for (const l of lists) {
        if (l.removeEventListener) l.removeEventListener('change', onChange);
        else l.removeListener(onChange);
      }
    };
  }, []);

  return state;
}

export default useBreakpoint;
