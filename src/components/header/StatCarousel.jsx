// Cyclic horizontal scroller for the header KPI buttons.
//
// While the full button set fits the row, this is a plain centered flex row —
// no scrolling, no duplication. Once the set overflows, the buttons render
// twice back-to-back and scrollLeft is wrapped at the copy boundary on every
// scroll event, so the row scrolls end-to-end in an endless cycle in either
// direction (wheel, trackpad, or touch swipe). The clone is aria-hidden so
// screen readers see each button once.
import { Children, useLayoutEffect, useRef, useState } from "react";
import "./StatCarousel.scss";

export default function StatCarousel({ children }) {
  const viewportRef = useRef(null);
  const copyRef = useRef(null);
  const [overflowing, setOverflowing] = useState(false);

  const childCount = Children.count(children);

  // (Re)measure on mount, on any resize, and when the button set changes.
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const copy = copyRef.current;
    if (!viewport || !copy) return;
    const measure = () => setOverflowing(copy.offsetWidth > viewport.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(viewport);
    ro.observe(copy);
    return () => ro.disconnect();
  }, [childCount]);

  // Entering cycle mode: nudge off scrollLeft=0 so a leftward wrap is possible
  // (scrollLeft can never go negative). Leaving it: snap back to the start.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollLeft = overflowing ? 1 : 0;
  }, [overflowing]);

  // Keep scrollLeft inside [1, copyWidth+1) — crossing either copy boundary
  // jumps one copy-width to the identical position in the other copy.
  const onScroll = () => {
    if (!overflowing) return;
    const el = viewportRef.current;
    const w = copyRef.current?.offsetWidth ?? 0;
    if (!el || !w) return;
    if (el.scrollLeft >= w + 1) el.scrollLeft -= w;
    else if (el.scrollLeft < 1) el.scrollLeft += w;
  };

  // Desktop mice have no horizontal wheel — translate vertical wheel travel
  // into sideways scroll so the hidden-scrollbar row is still reachable.
  const onWheel = (e) => {
    if (!overflowing) return;
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      viewportRef.current.scrollLeft += e.deltaY;
    }
  };

  return (
    <div
      ref={viewportRef}
      className={`stat-carousel${overflowing ? " stat-carousel--cycle" : ""}`}
      onScroll={onScroll}
      onWheel={onWheel}
    >
      <div ref={copyRef} className="stat-carousel__copy">{children}</div>
      {overflowing && (
        <div className="stat-carousel__copy" aria-hidden="true">{children}</div>
      )}
    </div>
  );
}
