/**
 * The Fleets funnel — what the map is showing, and what it is worried about.
 *
 * ## Why a second axis
 *
 * The status chips across the overlay answer "which units are ONLINE / IDLING
 * / OFFLINE". They cannot answer "show me only the excavators", and on a fleet
 * of 597 that is the question an operator actually opens the map with. Type is
 * an orthogonal axis, so it gets its own control rather than more chips: the
 * two combine (offline excavators) instead of competing for one slot.
 *
 * ## Three sections, one subject
 *
 * The panel now carries three things, in the order an operator reaches for
 * them: NARROW the fleet (types), narrow it again to what is moving (in
 * transit), and then the one list that is not a filter at all — units that
 * were in transit and have been standing still for ten minutes or more.
 *
 * They belong together because they are one question — "what should I be
 * looking at" — and splitting them across two rail buttons is how the fuel
 * alerts ended up with a control in one place and its content in another.
 *
 * The flagged list is NOT a filter. It does not change the map; clicking a row
 * takes you to that unit, exactly as a fuel-alert row does. Two behaviours in
 * one panel is a real cost, which is why the section is separated by a rule and
 * labelled with a count rather than a checkbox.
 *
 * ## Why it is organisation-specific
 *
 * The type rows are derived from the vehicles handed in, not from a fixed list,
 * so each fleet sees its own machines and nothing else — Sukari opens on
 * tractors and prime movers, Kasulu on excavators and compactors. The SELECTION
 * is per-org too (AppContext persists it under ft-fleet-types:<orgId>), because
 * carrying one fleet's choice across a company switch would filter the next
 * fleet by machines it does not own.
 *
 * ## Why it copies MapLayersMenu
 *
 * Same rail, same job: a map control that belongs to its button. It closes on
 * Escape and on a press outside, hands focus back when it goes, and remembers
 * nothing about where it was. An operator who has learned one has learned all
 * four.
 */

import { useEffect, useMemo, useRef, useState, useId } from "react";
import { useAppFields, useAppActions } from "../../context/AppContext";
import { fleetTypeOptions } from "../../lib/vehicleMap";
import "./FleetsMenu.css";
import { displayPlate } from "../../lib/plate";

/** A funnel. Drawn at the same 1.9 stroke as the rest of the app's icons. */
function FunnelIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.9"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />
    </svg>
  );
}

/**
 * How long the unit has been standing, as an operator would say it.
 *
 * Minutes up to an hour, then hours and minutes — "94m" is a number you have
 * to convert before it means anything, and the whole point of the row is to be
 * read at a glance.
 */
function stoppedFor(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  return `${h}h ${String(mins % 60).padStart(2, "0")}m`;
}

export default function FleetsMenu({
  vehicles,
  inTransitOnly = false,
  onToggleInTransit,
  flagged = [],
  onSelectFlagged,
}) {
  const { fleetTypes, trackedIds } = useAppFields("fleetTypes", "trackedIds");
  const { setFleetTypes } = useAppActions();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const panelId = useId();

  const options = useMemo(() => fleetTypeOptions(vehicles), [vehicles]);
  const selected = useMemo(() => new Set(fleetTypes), [fleetTypes]);

  /**
   * Close on Escape or on a press outside — pointerdown rather than click, so a
   * press that starts on a row and releases past the panel edge does not close
   * the menu out from under a gesture that never left it. Escape returns focus
   * to the trigger; without that a keyboard user is left at the top of the
   * document with no way back to the control they just used.
   */
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      btnRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const showTypes = options.length >= 2;
  const flagCount = flagged.length;

  // A fleet of one machine type has nothing to filter — but the panel still
  // owns the in-transit lens and the flagged list, so it only disappears
  // entirely when it would have nothing at all to say. (The old rule hid the
  // whole control on a single-type fleet, which would now take the stranded
  // units with it.)
  if (!showTypes && flagCount === 0 && !inTransitOnly) return null;

  function toggle(kind) {
    const next = selected.has(kind)
      ? fleetTypes.filter((k) => k !== kind)
      : [...fleetTypes, kind];
    setFleetTypes(next);
  }

  const activeCount = selected.size;
  const fleetTotal = options.reduce((n, o) => n + o.count, 0);
  const shownTotal = activeCount
    ? options.reduce((n, o) => (selected.has(o.kind) ? n + o.count : n), 0)
    : fleetTotal;
  const filtering = activeCount > 0 || inTransitOnly;

  return (
    <div className="fleets-menu" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`map-cam-btn fleets-menu__btn${open ? " fleets-menu__btn--open" : ""}${filtering ? " fleets-menu__btn--on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={[
          "Fleets",
          activeCount ? `${activeCount} of ${options.length} types shown` : null,
          inTransitOnly ? "in transit only" : null,
          flagCount ? `${flagCount} ${flagCount === 1 ? "unit" : "units"} stopped` : null,
        ].filter(Boolean).join(", ")}
        title="Fleets"
      >
        <FunnelIcon />
        {/* ONE number, and it is never the filter.
            How many types are ticked is a setting the operator just made and
            can see the effect of on the map; a badge for it competed with the
            only count here that is news — how many machines have stopped where
            they should not have. That the funnel is filtering at all is still
            carried, by the button going green.
            The aria-label keeps both facts: a screen-reader user cannot see
            the green. */}
        {flagCount > 0 && (
          /* data-digits drives the type step in the CSS — the disc is a fixed
             size and the numerals give way, so a 2 and a 218 sit in the same
             circle. CSS cannot measure its own text; the component can. */
          <span className="fleets-menu__flagcount" data-digits={String(flagCount).length}>{flagCount}</span>
        )}
      </button>

      {open && (
        <div className="fleets-menu__panel" id={panelId} role="group" aria-label="Fleets">
          <div className="fleets-menu__head">
            <span className="fleets-menu__title">Fleets</span>
            {/* Only offered when it would do something. */}
            {filtering && (
              <button
                type="button"
                className="fleets-menu__clear"
                onClick={() => { setFleetTypes([]); if (inTransitOnly) onToggleInTransit?.(); }}
              >Show all</button>
            )}
          </div>

          {showTypes && (
            <div className="fleets-menu__section">
              {/* Its own scroller, capped. Nine machine types at the old row
                  height was 240px of panel before anything else had been
                  drawn — which is what made this menu taller than the map
                  column it opens into. */}
              <div className="fleets-menu__rows">
                {options.map((o) => (
                  <button
                    key={o.kind}
                    type="button"
                    className="fleets-menu__row"
                    role="checkbox"
                    aria-checked={selected.has(o.kind)}
                    onClick={() => toggle(o.kind)}
                  >
                    <span className="fleets-menu__box" aria-hidden="true" />
                    <span className="fleets-menu__label">{o.label}</span>
                    <span className="fleets-menu__n">{o.count}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* A SWITCH, not a list. There can be two hundred units in transit,
              and a list of two hundred units is the map. */}
          <div className="fleets-menu__section fleets-menu__section--rule">
            <button
              type="button"
              className="fleets-menu__switchrow"
              role="switch"
              aria-checked={inTransitOnly}
              onClick={onToggleInTransit}
              title={inTransitOnly ? "Show stationary units again" : "Show only units that are moving"}
            >
              <span className="fleets-menu__switch" aria-hidden="true" />
              <span className="fleets-menu__switchlabel">In transit only</span>
            </button>
          </div>

          {flagCount > 0 && (
            <div className="fleets-menu__section fleets-menu__section--rule">
              <div className="fleets-menu__sechead">
                <span className="fleets-menu__sectitle">Halted</span>
                <span className="fleets-menu__secn">{flagCount}</span>
              </div>

              <div className="fleets-menu__flaglist">
                {flagged.map(({ vehicle, why }) => (
                  <button
                    type="button"
                    key={vehicle.id}
                    className="fleets-menu__flagrow"
                    onClick={() => { setOpen(false); onSelectFlagged?.(vehicle.id); }}
                    title="Show this unit on the map"
                  >
                    <span className="fleets-menu__flagdot" aria-hidden="true" />
                    <span className="fleets-menu__flagplate">{displayPlate(vehicle)}</span>
                    <span className="fleets-menu__flagfor">{stoppedFor(why.forMs)}</span>
                    <span className="fleets-menu__flagmeta">
                      {why.state === "idling" ? "engine running" : "engine off"}
                      {/* Said out loud rather than assumed either way: we know
                          where it stopped only when the zone engine has
                          actually evaluated this unit.

                          Wording kept in step with the map window, which had to
                          drop "location unverified" when it started naming the
                          place each unit stopped at — beside a place name that
                          phrase reads as doubt about the NAME. Two panels over
                          one list must not describe the same condition in two
                          ways, so the plainer sentence is used in both. */}
                      {why.zonesKnown ? "" : " · no zones to check"}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* The running total, so the effect of a tick is visible without
              looking back at the map.

              It has to mention TRACKING even though tracking is not this
              panel's control: with four units ticked in the units menu, a
              footer reading "All 597 vehicles" is the one number on screen
              that disagrees with the map — the exact failure the chip counts
              are narrowed to avoid. */}
          <div className="fleets-menu__foot">
            {trackedIds?.length
              ? `Tracking ${trackedIds.length} of ${fleetTotal}`
              : inTransitOnly
                ? `In transit only, of ${shownTotal}`
                : activeCount === 0
                  ? `All ${shownTotal} vehicles`
                  : `${shownTotal} of ${fleetTotal} vehicles`}
          </div>
        </div>
      )}
    </div>
  );
}
