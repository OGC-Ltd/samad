/**
 * Stopped in transit — the units that were moving and have stopped where
 * nothing explains it, as a window over the map.
 *
 * ## Why a window and not a list in the sidebar
 *
 * Every row here is an instruction to LOOK AT A PLACE. In the sidebar the row
 * and the place were on opposite sides of the screen: an operator read a
 * plate, clicked it, and then had to find where the camera had gone — and the
 * branch that held the list scrolled away the moment they did. A window sits
 * on the thing it is talking about, and it stays open while the camera moves,
 * so working down six stranded units is six clicks rather than six clicks plus
 * six re-openings.
 *
 * It is the same arrangement the Units panel already has, for the same reason,
 * and it is opened the same way: the sidebar owns a flag, FleetMap owns the
 * window (MapLayersContext).
 *
 * ## The tick is the Units panel's tick
 *
 * Same control, same meaning, same state: ticking narrows the map to what is
 * ticked, and an empty selection is the absence of a narrowing rather than
 * "hide everything". That matters more here than anywhere else in the product
 * — "show me only the units that have stopped where they should not have" is
 * the question this window exists to ask, and before the tick it could only be
 * asked one unit at a time by clicking rows and watching the camera jump.
 *
 * The tick and the row do different things on purpose, which is the split the
 * Units panel already draws: the BOX says which units the map is about, and the
 * REST of the row says "take me to this one". Wiring them together would mean
 * an operator could not look at a unit without also changing what the map
 * draws.
 *
 * ## Ten at a time
 *
 * The list is paged rather than scrolled past ten. A stranded fleet is read
 * DOWN — a plate, a duration, a decision, the next plate — and a scroll bar
 * loses the reader's place every time the telemetry sweep re-orders the list
 * underneath them. A page does not: ten is where you were, and it is still ten
 * when the panel refreshes.
 *
 * Ten is also the count that fits without making the window taller than the
 * map it sits on. It is not offered as a choice; the roster's table offers
 * 15/25/50/100 because it owns a page, and this owns 320 pixels.
 *
 * The paging helpers are the roster's, `lib/rosterView`, because the hard part
 * is not the slice — it is clamping a page against a list that shrinks while
 * somebody is reading it, which is the ordinary case here and is already
 * solved and tested there.
 *
 * ## Dismissal
 *
 * A press outside, Escape, or the close button — the same contract the Units
 * panel, the layers menu and the fuel-alerts menu all use, and `pointerdown`
 * rather than `click` for the same reason they do: a press that begins outside
 * has already decided to leave, and waiting for the release lets a drag that
 * started on the map end inside this panel and count as a press on it.
 *
 * The cost is real and worth naming: the rows here take the camera somewhere,
 * and going on to click the unit on the MAP closes the list. Ticking rows is
 * the way round that — the tick narrows the map to the units without ever
 * leaving the window — and it is why the ticks are here.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useFloatingWindow } from "../../hooks/useFloatingWindow";
import { usePlaceName } from "../../hooks/usePlaceName";
import { paginate } from "../../lib/rosterView";
import TablePager from "./TablePager";
import "./StrandedWindow.scss";
import { displayPlate } from "../../lib/plate";

/** Ten, where every full-width table pages fifteen (TablePager): this is a
 *  320px window over a map. One number, and it is the number that fills the
 *  window without making it taller than the thing it is annotating. */
const PER_PAGE = 10;

/** How long it has been standing. Same wording as the sidebar and the map's
 *  own flagged list — three copies of this sentence would be three chances to
 *  round it differently. */
function stoppedFor(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${String(mins % 60).padStart(2, "0")}m`;
}

/** When it stopped: the time, and the date beneath it. Always both — a date
 *  shown only "when it was not today" leaves the reader working out which
 *  rows are today's, and a unit stranded overnight must not read as having
 *  stopped this evening. */
function stoppedAt(ms) {
  if (!Number.isFinite(ms)) return { time: "-", date: "" };
  const d = new Date(ms);
  return {
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
    date: d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }),
  };
}

/**
 * One flagged unit: where it is, how long it has been there, and what its
 * engine is doing.
 *
 * A component rather than markup inside the map loop because of ONE line —
 * the place name. `usePlaceName` is a hook, so it cannot be called per row
 * from the parent; the row has to be a component to have one.
 *
 * That is also the bill this panel now pays, and why it is payable: a place
 * name is a network round trip per grid cell, so before the list was paged
 * this would have been one lookup per flagged unit, three hundred of them on
 * a bad afternoon. Ten at a time it is at most ten, and the hook's cache is
 * keyed per ~1.1 km cell in memory and localStorage — so a second unit
 * stranded near the first is free, which for units that stop together on the
 * same bad stretch of road is the usual case.
 *
 * ## "Where it was flagged" is where it IS
 *
 * The flag means STOPPED: `strandedStop` requires `movement.state` to be
 * stationary and unchanged since `sinceMs`, so the unit has not moved since
 * the clock started. Its latest fix is the spot it stopped on. This reads the
 * live coordinate rather than storing one at flag time, which would be a
 * second copy of a number that cannot have changed — and one that would go
 * stale in the other direction, still naming the old spot after a unit that
 * has finally been recovered and driven away.
 */
function StrandedRow({ vehicle, why, on, onToggle, onSelect }) {
  /* Null until the lookup resolves, and null forever if it cannot be resolved
     — the coordinate is the fallback in both cases, which is what the vehicle
     card and the map overlay do with the same hook. Coordinates are not a
     consolation prize here either: they are what gets read into a radio call
     to whoever is going out to the unit. */
  const place = usePlaceName(vehicle.lat, vehicle.lng);
  const where = place ?? vehicle.location;
  const at = stoppedAt(why.sinceMs);

  return (
    /* A DIV holding two controls, not one button inside another — a nested
       <button> is invalid HTML and the inner one stops being reachable by
       keyboard in some engines. */
    <div className={"stranded-win__row" + (on ? " stranded-win__row--on" : "")}>
      <button
        type="button"
        className="stranded-win__tick"
        role="checkbox"
        aria-checked={on}
        aria-label={`Track ${vehicle.id}`}
        title="Narrow the map to this unit"
        onClick={() => onToggle?.(vehicle.id)}
      >
        <span className="stranded-win__box" aria-hidden="true" />
      </button>
      <button
        type="button"
        className="stranded-win__go"
        onClick={() => onSelect?.(vehicle.id)}
        title="Show this unit on the map"
      >
        <span className="stranded-win__unit">
          <span className="stranded-win__dot" aria-hidden="true" />
          <span className="stranded-win__plate">{displayPlate(vehicle)}</span>
          <span className="stranded-win__meta">
            {why.state === "idling" ? "engine running" : "engine off"}
            {/* Said out loud rather than assumed either way: we know where it
                stopped only once the zone engine has actually evaluated this
                unit. It is about zones, not the place name beside it. */}
            {why.zonesKnown ? "" : " · no zones to check"}
          </span>
        </span>
        {/* When the clock started — the same `since` the duration is counted
            from, so the two columns can never disagree. */}
        <span className="stranded-win__at" title={new Date(why.sinceMs).toLocaleString()}>
          <span className="stranded-win__time">{at.time}</span>
          <span className="stranded-win__date">{at.date}</span>
        </span>
        {/* Titled, because this is the column most likely to be cut: a place
            name is as long as it is. */}
        <span className="stranded-win__where" title={where}>{where}</span>
        <span className="stranded-win__for">{stoppedFor(why.forMs)}</span>
      </button>
    </div>
  );
}

export default function StrandedWindow({
  flagged = [],
  open = false,
  onOpenChange,
  onSelect,
  trackedIds,
  onSetTracked,
}) {
  const tracked = useMemo(() => new Set(trackedIds ?? []), [trackedIds]);
  const ids = useMemo(() => flagged.map(({ vehicle }) => vehicle.id), [flagged]);

  const [page, setPage] = useState(1);
  /* CLAMPED, never trusted — which is the whole reason this list is paged by
     the roster's helper rather than by a slice written here. The flagged list
     is live: units stop being stranded while somebody is reading about them,
     and a list that shrinks from 34 to 8 under a reader sitting on page 3 must
     answer with the last page that exists rather than with an empty panel
     under a pager insisting there are more. */
  const paged = useMemo(() => paginate(flagged, page, PER_PAGE), [flagged, page]);

  /* Back to the top on a page change. The list is a scrolling box and the
     browser keeps its scrollTop across a re-render, so page 2 would otherwise
     open halfway down itself. */
  const listRef = useRef(null);
  useEffect(() => { if (listRef.current) listRef.current.scrollTop = 0; }, [paged.page]);

  /* A fresh look starts at the start. The component stays mounted while the
     window is shut — `open` only stops it rendering — so without this, a
     window closed on page 4 and reopened an hour later comes back on page 4 of
     a list that has turned over completely since. NOT reset when the DATA
     changes: that fires on every telemetry sweep, and a pager that jumps home
     every few seconds cannot be read at all. */
  useEffect(() => { if (open) setPage(1); }, [open]);
  /* "All of them" means every flagged unit, never the fleet — the control
     sits in a panel about these units and must not reach past them — and,
     now that the panel pages, never merely the ten on screen either. The count
     beside the button says 34; a button labelled "Track all" that took ten
     would be contradicting the number it is standing next to.
     
     Deliberately the opposite of the roster's select-all, which means the PAGE.
     That one is a checkbox in a header above a column of checkboxes, so the
     page is what it visibly commands; this is a labelled button beside a total. */
  const allTracked = ids.length > 0 && ids.every((id) => tracked.has(id));

  const toggleTracked = (id) => {
    onSetTracked?.(tracked.has(id)
      ? (trackedIds ?? []).filter((x) => x !== id)
      : [...(trackedIds ?? []), id]);
  };

  const toggleAll = () => {
    onSetTracked?.(allTracked
      ? (trackedIds ?? []).filter((id) => !ids.includes(id))
      : [...new Set([...(trackedIds ?? []), ...ids])]);
  };

  /* Opened beside the sidebar, then draggable anywhere — measured rather than
     declared, because the rail is 320px on a desktop and 260 at 1024 and a
     constant would overlap it at one of the two. `open` is in the deps so a
     window closed and reopened after the rail was collapsed comes back beside
     where the rail is NOW. */
  const initial = useMemo(() => {
    if (typeof document === "undefined") return undefined;
    const rail = document.querySelector(".side-panel");
    const head = document.querySelector(".app-header");
    return {
      x: (rail?.getBoundingClientRect().right ?? 0) + 12,
      y: (head?.getBoundingClientRect().bottom ?? 0) + 12,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /* One ref, two jobs: useFloatingWindow places and drags the node, and the
     dismissal test needs the same node to ask "was that press inside me". A
     second wrapper element would give the window a box that is not the window. */
  const { ref, onPointerDown } = useFloatingWindow({
    id: "stranded",
    dock: "top-center",
    enabled: open,
    initial,
  });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onOpenChange?.(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      /* Stopped, so the map does not also read this as "drop the selection".
         Two things reacting to one Escape is how a window closes AND the unit
         under it is deselected, which nobody asked for. */
      e.stopPropagation();
      onOpenChange?.(false);
    };
    /* Capture, so a press on something that stops propagation — the map's own
       marker handlers do — still counts as a press outside. */
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange, ref]);

  if (!open) return null;

  return (
    <div
      className="stranded-win"
      ref={ref}
      role="dialog"
      aria-label="Halted"
    >
      {/* The head is the handle. */}
      <div className="stranded-win__head" onPointerDown={onPointerDown}>
        {/* Title and count are one thing and take the free space, so the two
            buttons sit against the right edge whether or not both are there —
            an `auto` margin on a button that is sometimes absent moves the
            other one every time the list empties. */}
        <span className="stranded-win__lead">
          <span className="stranded-win__title">Halted</span>
          {flagged.length > 0 && <span className="stranded-win__n">{flagged.length}</span>}
        </span>
        {flagged.length > 0 && (
          <button
            type="button"
            className="stranded-win__all"
            onClick={toggleAll}
            /* The head is a drag handle; a press that starts on this button is
               a press on the button. */
            onPointerDown={(e) => e.stopPropagation()}
            title={allTracked
              ? "Stop narrowing the map to these units"
              : "Narrow the map to the units in this list"}
          >
            {allTracked ? "Untrack all" : "Track all"}
          </button>
        )}
        <button
          type="button"
          className="stranded-win__close"
          onClick={() => onOpenChange?.(false)}
          aria-label="Close"
          title="Close"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
               stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {flagged.length === 0 ? (
        /* Worth a window of its own rather than an empty one: "nothing is
           wrong" is the answer somebody opened this to get, and a panel that
           showed a blank list would leave them wondering whether it had
           loaded. */
        <div className="stranded-win__empty">Nothing standing where it should not be.</div>
      ) : (
        <div className="stranded-win__list" ref={listRef}>
          {/* Column heads. Aligned to the rows by sharing their grid template
              (--sw-cols in the stylesheet), with a spacer where the tick is. */}
          <div className="stranded-win__cols" aria-hidden="true">
            <span />
            <span className="stranded-win__colhead">
              <span>Unit</span>
              <span>Stopped at</span>
              <span>Location</span>
              <span className="stranded-win__colhead--num">Stationary</span>
            </span>
          </div>
          {paged.slice.map(({ vehicle, why }) => (
            <StrandedRow
              key={vehicle.id}
              vehicle={vehicle}
              why={why}
              on={tracked.has(vehicle.id)}
              onToggle={toggleTracked}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}

      {/* The app's one pager (TablePager, operator 2026-10-12: "the
          pagination should be consistent across all pages"), drawn only when
          there is a second page. Ten to a page here, not fifteen: the window
          is 320px over the map. It counts pages from 0, this list from 1. */}
      <TablePager
        label="Halted pages"
        pager={{
          page: paged.page - 1,
          pageCount: paged.pageCount,
          total: paged.total,
          from: paged.from,
          to: paged.to,
          setPage: (n) => setPage(n + 1),
        }}
      />
    </div>
  );
}
