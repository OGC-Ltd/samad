/*
 * One date picker for a single day or a range of days (operator, 28 Sep: "just
 * one interface — they can single pick a date or a range").
 *
 * It was two native date boxes, From and To, beside a Day | Range switch: a
 * reader wanting one day had to set both boxes, or work the switch first.
 * Now it is one field and one calendar:
 *
 *   · click a day — that day is picked, at once, and the calendar stays open;
 *   · click a second day — the range between the two is picked and it closes;
 *     the same day again keeps just that day;
 *   · or take a quick pick along the top.
 *
 * Days after `today` cannot be picked, nor days before `minDay` when one is
 * given (the first day a screen holds records for), and while a range is being
 * drawn the days further than `maxDays` from its first day cannot either.
 * `spans` names the "Last N days" quick picks; it defaults to 7, 30 and
 * `maxDays`, whichever of those fit. `quickPicks={false}` leaves them out of
 * the calendar, for a screen that sets them as buttons of its own. Days are fleet
 * day keys ('YYYY-MM-DD'), laid out by lib/dayRange monthGrid.
 */

import { useEffect, useRef, useState } from 'react';
import { addDays, addMonths, daysBetween, monthGrid, rangeFromClicks } from '../../lib/dayRange';
import './DateRangePicker.css';

// Keys are calendar dates, so they are read and printed in UTC
const DAY = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-KE', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const FULL = new Intl.DateTimeFormat('en-KE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const at = (key) => new Date(`${key}T00:00:00.000Z`);
const dayText = (key) => DAY.format(at(key));
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** "Today", "27 Sept", "22 Sept – today". */
export function pickedText(from, to, today) {
  if (from === to) return from === today ? 'Today' : dayText(from);
  return `${dayText(from)} – ${to === today ? 'today' : dayText(to)}`;
}

/**
 * `from`/`to` are the picked days; `onChange(from, to)` picks others. `align`
 * is the side of the field the calendar lines up with.
 */
export default function DateRangePicker({ from, to, today, maxDays = 14, onChange, align = 'left', label = 'Dates', minDay = null, spans = null, quickPicks = true }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState(null);   // a first click waiting for a second
  const [hover, setHover] = useState(null);
  const [month, setMonth] = useState(to.slice(0, 7));
  const rootRef = useRef(null);

  // Opens on the month of the last day picked, with nothing half-drawn
  useEffect(() => {
    if (!open) return undefined;
    setMonth(to.slice(0, 7));
    setAnchor(null);
    setHover(null);
    // A press outside closes it. Escape closes it too, and stops there: the
    // vehicle panel closes on Escape, and one key should not do both.
    const onDown = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (f, t) => { onChange(f, t); };
  const clickDay = (d) => {
    if (anchor == null) { setAnchor(d); pick(d, d); return; }
    const [f, t] = rangeFromClicks(anchor, d);
    pick(f, t);
    setAnchor(null);
    setOpen(false);
  };
  const quick = [
    { label: 'Today', f: today, t: today },
    { label: 'Yesterday', f: addDays(today, -1), t: addDays(today, -1) },
    ...(spans ?? [7, 30, maxDays]).filter((n, i, all) => n <= maxDays && all.indexOf(n) === i)
      .map(n => ({ label: `Last ${n} days`, f: addDays(today, -(n - 1)), t: today })),
  ];

  // What the grid shows as picked: the range being drawn, else the one held
  const [lo, hi] = anchor != null ? rangeFromClicks(anchor, hover ?? anchor) : [from, to];
  const tooFar = (d) => anchor != null && daysBetween(...rangeFromClicks(anchor, d), maxDays + 1).length > maxDays;
  const canNext = month < today.slice(0, 7);
  const canPrev = !minDay || month > minDay.slice(0, 7);

  return (
    <div className={`drp drp--${align}`} ref={rootRef}>
      <button
        type="button"
        className={`drp-field${open ? ' drp-field--open' : ''}`}
        onClick={() => setOpen(o => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${pickedText(from, to, today)}. Pick a day or a range.`}
      >
        <i className="ti ti-calendar" aria-hidden="true" />
        <span className="drp-text">{pickedText(from, to, today)}</span>
        <i className="ti ti-chevron-down drp-caret" aria-hidden="true" />
      </button>

      {open && (
        <div className="drp-pop" role="dialog" aria-label="Pick a day, or two days for a range">
          {quickPicks && <div className="drp-quick">
            {quick.map(q => (
              <button
                key={q.label}
                type="button"
                className={`drp-chip${from === q.f && to === q.t && anchor == null ? ' drp-chip--on' : ''}`}
                onClick={() => { pick(q.f, q.t); setOpen(false); }}
              >{q.label}</button>
            ))}
          </div>}

          <div className="drp-head">
            <button type="button" className="drp-nav" onClick={() => setMonth(m => addMonths(m, -1))} disabled={!canPrev} aria-label="Previous month">
              <i className="ti ti-chevron-left" aria-hidden="true" />
            </button>
            <span className="drp-month">{MONTH.format(at(`${month}-01`))}</span>
            <button type="button" className="drp-nav" onClick={() => setMonth(m => addMonths(m, 1))} disabled={!canNext} aria-label="Next month">
              <i className="ti ti-chevron-right" aria-hidden="true" />
            </button>
          </div>

          <div className="drp-grid" role="grid" onPointerLeave={() => setHover(null)}>
            {WEEKDAYS.map(w => <span key={w} className="drp-wd" aria-hidden="true">{w}</span>)}
            {monthGrid(month).flat().map((d, i) => {
              if (!d) return <span key={`x${i}`} />;
              const off = d > today || (minDay != null && d < minDay) || tooFar(d);
              const inRange = d >= lo && d <= hi;
              const cls = ['drp-day',
                inRange && 'drp-day--in',
                d === lo && 'drp-day--lo',
                d === hi && 'drp-day--hi',
                d === today && 'drp-day--today',
                anchor === d && 'drp-day--anchor'].filter(Boolean).join(' ');
              return (
                <button
                  key={d}
                  type="button"
                  className={cls}
                  disabled={off}
                  onClick={() => clickDay(d)}
                  onPointerEnter={() => setHover(d)}
                  onFocus={() => setHover(d)}
                  aria-pressed={inRange}
                  aria-label={FULL.format(at(d))}
                >{Number(d.slice(8))}</button>
              );
            })}
          </div>

          <p className="drp-hint" aria-live="polite">
            {anchor != null
              ? `${dayText(anchor)} is picked. Click a second day for a range, or close this to keep the one day.`
              : `Click a day, or two days for a range of up to ${maxDays}.`}
          </p>
        </div>
      )}
    </div>
  );
}
