/**
 * The filter bar, which folds itself away on a phone.
 *
 * ## Why
 *
 * Sensor Monitor carries three of these — the panel's own search and Activity
 * row, Probe Health's Channel and State, Repairs' State — and on the Probes tab
 * two of them stack. Measured on an iPhone SE (375 x 667) the chrome above the
 * grid ran to 475px: 58% of the screen spent on controls before a single unit
 * appeared. Nothing there is wrong on a desk, where that bar is one line.
 *
 * So on a HANDSET the groups go behind a Filters button and the list starts near
 * the top of the screen. Not on a tablet: an iPad mini is 1,133px tall and can
 * afford the bar — see BP.handset in hooks/useBreakpoint. Above that width this
 * component renders exactly what the bare
 * <div className="sp4-filterbar"> rendered before — same children, same order,
 * no wrapper — so the desktop bar is untouched.
 *
 * ## Two things it is careful about
 *
 * `peek` is the control that does NOT fold: the search box. Hiding the fastest
 * way to find one unit behind a button that says "Filters" is the wrong trade,
 * and searching is what somebody standing at a vehicle actually does.
 *
 * `activeCount` is on the button because a collapsed filter is an invisible
 * one. A reader who cannot see "State: Not working" has to be told the list is
 * narrowed, or they read a partial fleet as the whole fleet. Callers count
 * their own filters against their own defaults — only they know what "unset"
 * means for a day picker or a sort.
 *
 * The drawer is hidden, never unmounted: a date input loses its editing state
 * when it is torn down, and reopening the drawer onto a reset day would be a
 * filter changing itself.
 */

import { useId, useState } from "react";
import { useBreakpoint } from "../../hooks/useBreakpoint";

export default function FilterBar({ peek = null, activeCount = 0, children, label = "Filters" }) {
  const { isHandset } = useBreakpoint();
  const [open, setOpen] = useState(false);
  const drawerId = useId();

  if (!isHandset) {
    return <div className="sp4-filterbar">{peek}{children}</div>;
  }

  return (
    <div data-tour="page-filters" className="sp4-filterbar sp4-filterbar--collapsible">
      {peek}
      <button
        type="button"
        className={"sp4-filters-toggle" + (open ? " sp4-filters-toggle--open" : "")}
        aria-expanded={open}
        aria-controls={drawerId}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
          <line x1="4" y1="7"  x2="20" y2="7"  /><circle cx="10" cy="7"  r="2.4" />
          <line x1="4" y1="17" x2="20" y2="17" /><circle cx="16" cy="17" r="2.4" />
        </svg>
        {label}
        {activeCount > 0 && <span className="sp4-filters-toggle__n">{activeCount}</span>}
      </button>
      <div className="sp4-filters-drawer" id={drawerId} hidden={!open}>
        {children}
      </div>
    </div>
  );
}
