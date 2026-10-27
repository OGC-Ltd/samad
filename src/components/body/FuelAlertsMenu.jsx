/**
 * The fleet's open fuel incidents, behind one button in the map's control rail.
 *
 * ## What it replaces
 *
 * A banner pinned to the top of the right panel, and a window that OPENED
 * ITSELF the first time you selected a flagged unit. Between them they spent
 * the most valuable row of the panel and the middle of the map on something
 * nobody had asked to see yet, and the only way to find out which OTHER units
 * were flagged was to click them one at a time.
 *
 * Now: a count on a button, a list behind it, and a window that opens when it
 * is asked for. Measured on the live fleet the day this was written, 28 units
 * carried an open incident across the two orgs — a list, not an interruption.
 *
 * ## Two things on one control, deliberately
 *
 * The switch quiets the MAP; the list is the information. They belong together
 * because they are the same subject, and separating them is what produced the
 * arrangement above — a control in one place and its content in another. It is
 * the same shape as the layers menu next to it, for the same reason.
 *
 * Switching off is not dismissing. The incidents are still open, still counted
 * on the badge, still listed, and their windows still open; only the red
 * treatment goes. Dismissal exists and lives in the incident window, where it
 * is one deliberate click on a labelled button.
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import "./FuelAlertsMenu.css";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { useMapLayers } from "../../context/MapLayersContext";
import { fleetPrefix, withoutPrefix } from "../../lib/plateLabel";
import { isConfirmedTheft, isTheftAlert } from "../../lib/fuelAlerts";
import { useFloatingWindow } from "../../hooks/useFloatingWindow";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { displayPlate } from "../../lib/plate";

/** Where the sidebar opens this as a window — the same line FuelAlertsMenu.css
 *  hides the map button on. */
const WINDOW_Q = "(min-width: 1024px)";

/** A drop, which is what every one of these is about. */
function DropIcon() {
  return (
    <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3s6 6.4 6 10.5a6 6 0 0 1-12 0C6 9.4 12 3 12 3Z" />
    </svg>
  );
}

/** The title bar's controls — the units window's glyphs, so the two read as one family. */
function IconWinMin({ min }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      {min ? <path d="M6 15l6-6 6 6" /> : <path d="M6 12h12" />}
    </svg>
  );
}

function IconWinClose() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
         fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

const L = (ml) => (ml == null ? null : `${(ml / 1000).toFixed(1)} L`);

/** Date and time on the fleet clock — these are Kenyan/Tanzanian operations. */
const DAY  = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Nairobi" });
const HHMM = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Africa/Nairobi",
});
const ms = (iso) => {
  const t = Date.parse(iso ?? "");
  return Number.isFinite(t) ? t : null;
};
/** { day: "24 Sep", time: "19:28", full } or null. */
const stamp = (iso) => {
  const t = ms(iso);
  if (t == null) return null;
  return { day: DAY.format(t), time: HHMM.format(t), full: `${DAY.format(t)} ${HHMM.format(t)}` };
};

/**
 * Newest drain first, by when it BEGAN. The list used to be ordered by volume,
 * which put yesterday's big drain above one that started ten minutes ago; an
 * alerts list is read top-down as "what happened most recently". Ties, and
 * rows with no start time, fall back to when the drain was reported.
 */
export function byMostRecent(a, b) {
  const ai = a.fuelIncident, bi = b.fuelIncident;
  const at = ms(ai?.beganAt) ?? ms(ai?.detectedAt) ?? -Infinity;
  const bt = ms(bi?.beganAt) ?? ms(bi?.detectedAt) ?? -Infinity;
  if (bt !== at) return bt - at;
  return (ms(bi?.detectedAt) ?? -Infinity) - (ms(ai?.detectedAt) ?? -Infinity);
}

/** One date/time cell, day and time on one line: "24 Sept 20:58". */
function When({ value, label }) {
  if (!value) return <span className="fuel-alerts__cell fuel-alerts__cell--none">-</span>;
  return (
    <span className="fuel-alerts__cell" title={`${label} ${value.full}`}>
      <span className="fuel-alerts__day">{value.day}</span>{" "}
      <span className="fuel-alerts__time">{value.time}</span>
    </span>
  );
}

export default function FuelAlertsMenu({ vehicles: all, showOnMap, onToggleMap, onSelect }) {
  // Open from its own button, or from the sidebar's Fleets > Fuel > Alerts —
  // one flag for both, held in the map's context. Local state where there is
  // no provider (a test, a harness).
  const shared = useMapLayers();
  const [localOpen, setLocalOpen] = useState(false);
  const open = shared?.setFuelAlertsOpen ? shared.fuelAlertsOpen : localOpen;
  const setOpen = shared?.setFuelAlertsOpen ?? setLocalOpen;
  const vehicles = useMemo(() => all.filter(isTheftAlert), [all]);
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const panelId = useId();

  /* On a desktop, a WINDOW: dragged by its title bar and folded to it
     (operator, 2026-09-27: "the modal to be draggable and also minimisable").
     The hook the units window, the vehicle card and the incident window use,
     so the drag, the clamp into the free map column and the remembered spot
     behave the same in all of them. Below 1024 it stays the rail's popover. */
  const asWindow = useMediaQuery(WINDOW_Q);
  const [minimized, setMinimized] = useState(false);
  const folded = asWindow && minimized;
  // Opens beside the sidebar, measured — it is 320px wide, 260 at 1024.
  const initialPos = useMemo(() => {
    if (!asWindow || typeof document === "undefined") return undefined;
    const rail = document.querySelector(".side-panel");
    const head = document.querySelector(".app-header");
    return {
      x: (rail?.getBoundingClientRect().right ?? 0) + 12,
      y: (head?.getBoundingClientRect().bottom ?? 0) + 12,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asWindow, open]);
  const { ref: winRef, onPointerDown: onHeadPointerDown } = useFloatingWindow({
    id: "fuel-alerts",
    dock: "top-center",
    enabled: asWindow && open,
    initial: initialPos,
  });
  // Closed and opened again from the sidebar, it comes back as a list.
  useEffect(() => { if (!open) setMinimized(false); }, [open]);

  // Same dismissal contract as the layers menu — see MapLayersMenu for why
  // `pointerdown` rather than `click`, and why Escape hands focus back.
  //
  // Except as a window: one that is dragged aside to work on the map, or
  // folded out of the way, and then vanishes at the first press on the map was
  // not worth moving. It has its own close button; Escape still works.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (asWindow) return;
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
  }, [open, setOpen, asWindow]);

  const count = vehicles.length;
  const sorted = useMemo(() => [...vehicles].sort(byMostRecent), [vehicles]);
  // The organisation's name in front of every plate, read off the whole fleet
  // (see lib/plateLabel). Dropped on a phone, where it is most of the column.
  const { vehicles: fleet } = useFleetLiveShared();
  const prefix = useMemo(() => fleetPrefix(fleet.map((x) => x.id)), [fleet]);

  /**
   * NOTHING AT ALL when the fleet is clean.
   *
   * A permanent "Fuel alerts: 0" is a control that reports the absence of its
   * own subject. The button appearing IS the alert — which is also why it is
   * amber only while something is open.
   *
   * Except when the sidebar asked for the list: then it opens and says there
   * is none, rather than the click doing nothing.
   */
  if (count === 0 && !open) return null;

  return (
    <div className="fuel-alerts" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`map-cam-btn fuel-alerts__btn${open ? " fuel-alerts__btn--open" : ""}${showOnMap ? " fuel-alerts__btn--on" : " fuel-alerts__btn--muted"}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Fuel alerts, ${count} ${count === 1 ? "unit" : "units"} flagged`}
        title="Fuel alerts"
      >
        <DropIcon />
        <span className="fuel-alerts__count" data-digits={String(count).length}>{count}</span>
      </button>

      {open && (
        <div
          className={`fuel-alerts__panel${asWindow ? " fuel-alerts__panel--window" : ""}${folded ? " fuel-alerts__panel--min" : ""}`}
          id={panelId}
          role="group"
          aria-label="Fuel alerts"
          ref={asWindow ? winRef : undefined}
        >
          {/* The head is the drag handle. The hook ignores a press that starts
              on a button, so On map, minimise and close keep theirs. */}
          <div className="fuel-alerts__head" onPointerDown={asWindow ? onHeadPointerDown : undefined}>
            <span className="fuel-alerts__title">
              Fuel alerts{folded ? ` · ${count}` : ""}
            </span>
            {!folded && (
              <button
                type="button"
                className="fuel-alerts__switchrow"
                role="switch"
                aria-checked={showOnMap}
                onClick={onToggleMap}
                title={showOnMap ? "Stop painting these units red on the map" : "Paint these units red on the map"}
              >
                <span className="fuel-alerts__switch" aria-hidden="true" />
                <span>On map</span>
              </button>
            )}
            {asWindow && (
              <div className="fuel-alerts__winbtns">
                <button
                  type="button"
                  className="fuel-alerts__winbtn"
                  aria-expanded={!minimized}
                  aria-label={minimized ? "Expand fuel alerts" : "Minimise fuel alerts"}
                  onClick={() => setMinimized((v) => !v)}
                  title={minimized ? "Expand" : "Minimise"}
                >
                  <IconWinMin min={minimized} />
                </button>
                <button
                  type="button"
                  className="fuel-alerts__winbtn"
                  aria-label="Close fuel alerts"
                  onClick={() => setOpen(false)}
                  title="Close"
                >
                  <IconWinClose />
                </button>
              </div>
            )}
          </div>

          {!folded && (<>
          <div className="fuel-alerts__cols" aria-hidden="true">
            <span className="fuel-alerts__col-unit">Unit</span>
            <span className="fuel-alerts__col-vol">Volume</span>
            <span className="fuel-alerts__col-began">Happened</span>
            <span className="fuel-alerts__col-reported">Alert</span>
          </div>

          <div className="fuel-alerts__list">
            {count === 0 && <div className="fuel-alerts__muted">No open fuel theft alerts.</div>}
            {sorted.map((v) => {
              const inc = v.fuelIncident;
              const theft = inc?.mayUseTheftWording === true;
              const began = stamp(inc?.beganAt);
              const reported = stamp(inc?.detectedAt);
              // CONFIRMED when the server is at least 80% sure it was a theft,
              // as the incident window says it. The row is one line, so this
              // lives in the tooltip and the accessible name.
              const status = isConfirmedTheft(inc) ? "possible theft, confirmed" : "possible theft";
              return (
                <button
                  type="button"
                  className="fuel-alerts__row"
                  key={v.id}
                  onClick={() => { setOpen(false); onSelect?.(v.id); }}
                  title={`${v.id} · ${status}
Show this unit and open its incident`}
                  aria-label={[
                    v.id,
                    L(inc?.volumeMl),
                    status,
                    began && `happened ${began.full}`,
                    reported && `reported ${reported.full}`,
                  ].filter(Boolean).join(", ")}
                >
                  <span className={`fuel-alerts__dot${theft ? " fuel-alerts__dot--theft" : ""}`} aria-hidden="true" />
                  <span className="fuel-alerts__plate">
                    <span className="fuel-alerts__plate-full">{displayPlate(v)}</span>
                    <span className="fuel-alerts__plate-short">{withoutPrefix(v.id, prefix)}</span>
                  </span>
                  <span className="fuel-alerts__vol">{L(inc?.volumeMl) ?? "-"}</span>
                  <span className="fuel-alerts__began"><When value={began} label="Happened" /></span>
                  <span className="fuel-alerts__reported"><When value={reported} label="Alert" /></span>
                </button>
              );
            })}
          </div>

          {!showOnMap && (
            <div className="fuel-alerts__muted">
              Hidden on the map. Still open, still listed here.
            </div>
          )}
          </>)}
        </div>
      )}
    </div>
  );
}
