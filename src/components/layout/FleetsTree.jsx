/**
 * Fleets — the sidebar's version of the map's funnel and units menus.
 *
 * ## Layout (redesigned 2026-10-02)
 *
 * Two plain parts, no tree. The operator found the three folding branches —
 * guide lines, chevrons, a type list scrolling inside the sidebar's own
 * scroll — cluttered, and asked for less grouping:
 *
 *   Filters   machine types as wrapping chips, and In transit only as one
 *             switch whose sub-line carries the moving count
 *   Open      one flat list of the places this block opens — Units, Stopped
 *             in transit, Fuel alerts / audit / report — each a row with its
 *             count (no chevron: nothing unfolds beneath them)
 *
 * What each control does, its permission gate and its count are unchanged.
 *
 * ## Stopped in transit, Units and Fuel alerts open WINDOWS, not lists
 *
 * Every row in those lists is an instruction to look at a place, and the
 * places are on the map. Rendered here, the row and the thing it names were on
 * opposite sides of the screen. The windows sit on the map and stay open while
 * the camera moves, which is what makes six stranded units six clicks instead
 * of six clicks and six re-openings.
 *
 * ## Where the data comes from
 *
 * Everything except the stranded list is derived here from the live fleet and
 * the per-org selections in the app slice, exactly as the map's menus derive
 * it — a second view of the same state, so a type ticked here is ticked in the
 * map's funnel below 1024px too.
 *
 * The stranded list arrives through MapLayersContext: deciding a unit is
 * stranded needs the estate's zone geometry, and only FleetMap has loaded it.
 */

import { useContext, useMemo, useState } from 'react';
import { useAppFields, useAppActions } from '../../context/AppContext';
import { useFleetLiveShared } from '../../context/FleetLiveContext';
import { useMapLayers } from '../../context/MapLayersContext';
import { usePermissions } from '../../hooks/usePermissions';
import { fleetTypeOptions, isInTransit } from '../../lib/vehicleMap';
import { TreeCountsMasked, MASKED_COUNT } from './SideTree';
import './FleetsTree.css';

/** Chips shown before "N more" (operator, 2026-10-13: "on the Fleets we only
 *  show 3, the rest should be under more"). */
const CHIP_FOLD = 3;

/** A place this block opens: icon, label, count. No chevron — nothing
 *  unfolds beneath these rows, so an arrow promised children they lack. */
function OpenRow({ icon, label, count = null, tone = 'plain', current = false, onClick, title }) {
  const masked = useContext(TreeCountsMasked);
  if (masked && count != null) { count = MASKED_COUNT; tone = 'plain'; }
  return (
    <button
      type="button"
      className={`fleets__row${current ? ' fleets__row--current' : ''}`}
      onClick={onClick}
      title={title}
      aria-current={current ? 'page' : undefined}
    >
      <i className={`ti ti-${icon} fleets__row-icon`} aria-hidden="true" />
      <span className="fleets__row-label">{label}</span>
      {count != null && <span className={`fleets__count fleets__count--${tone}`}>{count}</span>}
    </button>
  );
}

/**
 * `audit` is the Fuel Audit page, `report` the Fuel Report and `review` the
 * Logbook page (was Highlights), where this
 * account may open them: { active, open }. Null hides the row.
 */
export default function FleetsTree({ audit = null, report = null, review = null }) {
  const { fleetTypes = [], inTransitOnly } = useAppFields("fleetTypes", "inTransitOnly");
  const { setFleetTypes, setInTransitOnly } = useAppActions();
  const { vehicles = [] } = useFleetLiveShared();
  const { setUnitsOpen, revealMap } = useMapLayers() ?? {};
  const { can, flaggedOnly } = usePermissions();
  const masked = useContext(TreeCountsMasked);
  const [allTypes, setAllTypes] = useState(false);
  const options  = useMemo(() => fleetTypeOptions(vehicles), [vehicles]);
  const selected = useMemo(() => new Set(fleetTypes), [fleetTypes]);

  /* How many units are actually moving — isInTransit, the predicate the map
     marker, the vehicle card and the topbar's IN TRANSIT button use, so this
     number cannot disagree with them. ONLINE and moving under power, not
     `status !== 'parked'`, which would count a yard of idling units. */
  const inTransitCount = useMemo(() => vehicles.filter(isInTransit).length, [vehicles]);

  // A fleet of one machine type has nothing to narrow — the map funnel's rule.
  // Technicians narrow their flagged units by type too (operator, 2026-10-27).
  const canFilter = can('map:filter') || flaggedOnly;
  const showTypes = canFilter && options.length > 1;
  const filtered  = selected.size > 0 || Boolean(inTransitOnly);

  /* Folded to the first CHIP_FOLD chips — but a ticked type is never hidden
     by the fold: a filter you cannot see is a filter you cannot undo. */
  const folds = options.length > CHIP_FOLD;
  const shownTypes = allTypes || !folds
    ? options
    : options.filter((o, i) => i < CHIP_FOLD || selected.has(o.kind));
  const hiddenTypes = options.length - shownTypes.length;

  /* Every control here narrows what the MAP draws, and this block is on
     screen from every page. Narrowing the map from Drivers and staying on
     Drivers shows nothing, so acting on one is taken as a request to see the
     map. */
  /* Any change here also ends tracking and closes the pinned unit card
     (operator, 2026-10-15). FleetMap does that when it sees the types or
     In transit change, so the chips and these share one rule. */
  const toggleType = (kind) => {
    revealMap?.();
    setFleetTypes(selected.has(kind)
      ? fleetTypes.filter(k => k !== kind)
      : [...fleetTypes, kind]);
  };
  const clearAll = () => {
    revealMap?.();
    setFleetTypes([]);
    if (inTransitOnly) setInTransitOnly(false);
  };

  return (
    <div className="side-tree fleets">
      <div className="side-tree__section-title fleets__title">
        <i className="ti ti-truck" aria-hidden="true" /> Fleets
        {/* One clear for everything in the block: it belongs to no single
            control, so it sits on the block's own heading. */}
        {filtered && (
          <button type="button" className="fleets__clear" onClick={clearAll}
                  title="Show the whole fleet again">
            Clear filters
          </button>
        )}
      </div>

      {showTypes && (
        <div className="fleets__types" role="group" aria-label="Machine types">
          {shownTypes.map(o => {
            const on = selected.has(o.kind);
            return (
              <button
                key={o.kind}
                type="button"
                className={`fleets__chip${on ? ' fleets__chip--on' : ''}`}
                aria-pressed={on}
                onClick={() => toggleType(o.kind)}
                title={on
                  ? `Stop narrowing the map to ${o.label.toLowerCase()}`
                  : `Show only ${o.label.toLowerCase()} on the map`}
              >
                <span className="fleets__chip-label">{o.label}</span>
                <span className="fleets__chip-count">{masked ? MASKED_COUNT : o.count}</span>
              </button>
            );
          })}
          {folds && (
            <button
              type="button"
              className="fleets__chip fleets__chip--more"
              aria-expanded={allTypes}
              onClick={() => setAllTypes(v => !v)}
            >
              {allTypes ? 'Less' : `${hiddenTypes} more`}
            </button>
          )}
        </div>
      )}

      {/* On the map alone, not map:filter: technicians get In transit only
          over their flagged units without the machine-type chips (operator,
          2026-10-27). */}
      <button
        type="button"
        role="switch"
        aria-checked={Boolean(inTransitOnly)}
        className={`fleets__switch${inTransitOnly ? ' fleets__switch--on' : ''}`}
        onClick={() => { revealMap?.(); setInTransitOnly(v => !v); }}
        title="Draw only the units that are moving"
      >
        <span className="fleets__switch-text">
          <span className="fleets__switch-label">In transit only</span>
          <span className="fleets__switch-sub">{masked ? MASKED_COUNT : inTransitCount} moving now</span>
        </span>
        <span className="fleets__track" aria-hidden="true"><span className="fleets__thumb" /></span>
      </button>

      <nav className="fleets__list" aria-label="Fleet lists">
        {/* The map's units panel (search, sort, recency, route toggle) — the
            same panel the map's own Units button opens below 1024px. */}
        <OpenRow
          icon="list-details"
          label="Units"
          count={vehicles.length}
          onClick={() => { revealMap?.(); setUnitsOpen?.(true); }}
          title="Every unit, pick which ones the map is about"
        />
        {/* One vehicle over a chosen period — not a fuel page, so it sits
            above the Fuel group rather than after it (operator, 2026-10-07). */}
        {review && (
          <OpenRow
            icon="car"
            label="Logbook"
            current={review.active}
            onClick={review.open}
            title="Vehicle logbook, a report on one unit was used over a period, drive hours, distance, fuel and where it spent its time, with Excel and PDF"
          />
        )}
        {/* Fuel (operator, 2026-10-07): audit and report under one heading
            (Alerts moved to the map's tool rail), so each row drops the word the heading already says. */}
        {(audit || report) && (
          <div className="fleets__group" role="group" aria-labelledby="fleets-fuel-group">
            <div className="fleets__group-title" id="fleets-fuel-group">Fuel</div>
            {audit && (
              <OpenRow
                icon="clipboard-check"
                label="Audit"
                current={audit.active}
                onClick={audit.open}
                title="Fuel Audit, theft alerts that were a faulty probe, and where each probe repair stands"
              />
            )}
            {report && (
              <OpenRow
                icon="report-analytics"
                label="Report"
                current={report.active}
                onClick={report.open}
                title="Advanced fuel analysis, one unit over a period: statistics, fuel graph, fillings, drains, trips and the track"
              />
            )}
          </div>
        )}
      </nav>
    </div>
  );
}
