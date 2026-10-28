// One calendar for a day or a range of days.
//
// Click a day, then another: the two and everything between are the range.
// Click the same day twice for that day alone. The browser's own date input
// cannot do this (it picks one date), and two of them side by side did not
// fit the playback header on a phone.
//
// Rendered outside the playback window it opens from, which is a fixed,
// draggable panel: a popover inside it would be clipped by it and would follow
// any transform the drag puts on it. NOT into <body>, though: the light theme
// hangs off `.app--light` on a wrapper div, and <body> carries the dark
// defaults, so a popover there came out with near-white text on a white card.
// It goes into that wrapper, and places itself above or below its button,
// whichever side has the room.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDays, daysBetween } from "../../lib/playbackRange";
import "./RangeCalendar.scss";

const MONTH = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const SHORT_Y = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

const at = (day) => new Date(`${day}T12:00:00Z`);
const monthOf = (day) => day.slice(0, 7);
const shiftMonth = (ym, d) => {
  const x = new Date(`${ym}-15T12:00:00Z`);
  x.setUTCMonth(x.getUTCMonth() + d);
  return x.toISOString().slice(0, 7);
};

/** "24 Sep 2026", "1 – 9 Sep 2026", "28 Sep – 3 Oct 2026". */
export function spanLabel(from, to) {
  if (from === to) return SHORT_Y.format(at(from));
  if (monthOf(from) === monthOf(to)) return `${Number(from.slice(8))} – ${SHORT_Y.format(at(to))}`;
  return `${SHORT.format(at(from))} – ${SHORT_Y.format(at(to))}`;
}

/** The 42 cells (six weeks, Monday first) of the month `ym`; null pads. */
function cellsOf(ym) {
  const first = `${ym}-01`;
  const pad = (at(first).getUTCDay() + 6) % 7;
  const cells = Array(pad).fill(null);
  for (let d = first; monthOf(d) === ym; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  return cells;
}

const POP_W = 260;

export default function RangeCalendar({ from, to, max, maxDays, onChange }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(monthOf(to));
  // The first day clicked, waiting for the second. Null when not picking.
  const [anchor, setAnchor] = useState(null);
  const [hover, setHover] = useState(null);
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);

  const close = () => { setOpen(false); setAnchor(null); setHover(null); };

  useEffect(() => { if (!open) setView(monthOf(to)); }, [to, open]);

  // Placed from the button, measured once the popover has a height, and again
  // whenever the window changes size (a phone turning, a pane resized), or it
  // is left hanging off the edge where the old width put it.
  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      if (!btnRef.current) return;
      const r = btnRef.current.getBoundingClientRect();
      const h = popRef.current?.offsetHeight ?? 320;
      const below = window.innerHeight - r.bottom;
      const top = below >= h + 8 || below >= r.top ? r.bottom + 6 : r.top - 6 - h;
      const left = Math.min(Math.max(8, r.left + r.width / 2 - POP_W / 2), window.innerWidth - POP_W - 8);
      setPos({ top: Math.max(8, top), left });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, view]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || btnRef.current?.contains(e.target)) return;
      close();
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
      btnRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  function pick(day) {
    if (!anchor) { setAnchor(day); return; }
    const [a, b] = anchor <= day ? [anchor, day] : [day, anchor];
    onChange(a, b);
    close();
  }

  // What is drawn as selected: the range being picked, else the current one.
  const end = anchor ? (hover ?? anchor) : null;
  const [selA, selB] = anchor ? (anchor <= end ? [anchor, end] : [end, anchor]) : [from, to];
  const tooFar = (d) => anchor && daysBetween(...(anchor <= d ? [anchor, d] : [d, anchor])) > maxDays;
  const preset = (a, b) => { onChange(a, b); close(); };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={"rcal-btn" + (open ? " rcal-btn--open" : "")}
        onClick={() => (open ? close() : setOpen(true))}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Pick a day, or a range of days"
      >
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none"
             stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" />
        </svg>
        <span>{spanLabel(from, to)}</span>
      </button>

      {open && createPortal(
        <div
          ref={popRef}
          className="rcal"
          role="dialog"
          aria-label="Choose days"
          style={{ width: POP_W, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
        >
          <div className="rcal-head">
            <button type="button" onClick={() => setView(shiftMonth(view, -1))} aria-label="Previous month">‹</button>
            <span className="rcal-month">{MONTH.format(at(`${view}-15`))}</span>
            <button
              type="button"
              onClick={() => setView(shiftMonth(view, 1))}
              disabled={view >= monthOf(max)}
              aria-label="Next month"
            >›</button>
          </div>

          <div className="rcal-grid" role="grid" onPointerLeave={() => setHover(null)}>
            {WEEKDAYS.map((w) => <span key={w} className="rcal-wd">{w}</span>)}
            {cellsOf(view).map((d, i) => {
              if (!d) return <span key={`p${i}`} />;
              const off = d > max || tooFar(d);
              const inSel = d >= selA && d <= selB;
              return (
                <button
                  key={d}
                  type="button"
                  className={"rcal-day"
                    + (inSel ? " rcal-day--in" : "")
                    + (d === selA ? " rcal-day--start" : "")
                    + (d === selB ? " rcal-day--end" : "")
                    + (d === max ? " rcal-day--today" : "")}
                  disabled={off}
                  onClick={() => pick(d)}
                  onPointerEnter={() => setHover(d)}
                  aria-pressed={inSel}
                  aria-label={SHORT_Y.format(at(d))}
                >{Number(d.slice(8))}</button>
              );
            })}
          </div>

          <div className="rcal-foot">
            <span className="rcal-hint">
              {anchor
                ? `From ${SHORT.format(at(anchor))}, now pick the last day`
                : `Pick a day, or the first and last of up to ${maxDays}`}
            </span>
            <div className="rcal-presets">
              <button type="button" onClick={() => preset(max, max)}>Today</button>
              <button type="button" onClick={() => preset(addDays(max, -1), addDays(max, -1))}>Yesterday</button>
              <button type="button" onClick={() => preset(addDays(max, -6), max)}>Last 7 days</button>
            </div>
          </div>
        </div>,
        btnRef.current?.closest(".app--light") ?? document.body,
      )}
    </>
  );
}
