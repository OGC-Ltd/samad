/**
 * The units list — pick which machines the map is about.
 *
 * ## What it is for
 *
 * The map opens on the whole fleet: 597 units on Sukari, and a corridor with
 * three trucks on it looks exactly like a corridor with thirty. An operator
 * watching a specific convoy had no way to say so — selection was ONE unit at
 * a time, and the second click threw the first away.
 *
 * Ticking units here narrows the map to them and nothing else. Untick them all
 * and the fleet comes back; an empty selection is the absence of a narrowing,
 * never "hide everything".
 *
 * ## A table, and why its headers are icons
 *
 * Nine columns in 440px leaves no room for words, and the words were never the
 * point: every column is one glyph wide because the VALUE is a glyph. A header
 * reading "Connection" over a column of dots costs more width than it explains.
 * Each header carries its name in `title` and `aria-label`, so the meaning is a
 * hover or a screen reader away without spending the space on everyone.
 *
 * ## The sprite is the marker's own artwork
 *
 * The avatar column draws from the same truck atlas the map markers use,
 * at the same status row, by setting `--lf-marker` on the element and letting
 * FleetMap.scss's `.lf-truck` do the sizing maths. A row and its marker cannot
 * disagree about what a unit is or what state it is in, because they are the
 * same pixels.
 *
 * ## One route at a time, deliberately
 *
 * Tracking is plural, the drawn route is not. Two tracks over the same estate
 * roads are two tangles of the same colour, and the pins at their ends stop
 * belonging to anything. So the route toggle is exclusive: switching it on for
 * one unit takes it off whichever unit had it.
 *
 * ## Opened from the sidebar, as a window
 *
 * On a desktop new-ui opens this list from the sidebar's Units row rather than
 * from a button on the map (that button is hidden at 1024px and up), so the
 * list sits in a window beside the sidebar: draggable, pinnable, foldable to
 * its title bar and closed from its own corner. The list inside is the same
 * one dash ships: same columns, same search, same sort, same behaviour.
 * Below 1024px it is the map's own popover, exactly as in dash.
 *
 * ## What a row must NOT do
 *
 * A row is not a marker click. Clicking a marker scopes the Live Feed to that
 * unit (see feedVehicleId in AppContext); glancing at a route from a list is
 * not a statement about the feed, and wiring these rows through the marker
 * handler would silently narrow the feed every time someone browsed.
 */

import { useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import { ACTIVITY_COLORS, fleetTypeLabel, fleetType, spriteKind, vehicleActivity } from "../../lib/vehicleMap";
import { useAppSelector, useAppActions, useCompanies } from "../../context/AppContext";
import { useCrossOrgUnitHandoff } from "../../hooks/useCrossOrgUnits";
import { useFloatingWindow } from "../../hooks/useFloatingWindow";
import { usePlaceName } from "../../hooks/usePlaceName";
import "./UnitsMenu.scss";
import { displayPlate } from "../../lib/plate";

/* ── header glyphs ──────────────────────────────────────────────────────────
 * Drawn at the app's 1.9 stroke, sized to the 12px header row. Each is
 * decorative — the column's <th> carries the name for assistive tech. */
/* 15, not 13. Every glyph in this panel is doing a column header's whole job —
   there are no words up there, so an icon a reader has to lean in to identify
   is the header being illegible rather than terse. The grid was widened to
   take them; see units-menu__row. */
const svg = (d, extra = null) => (
  <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"
       fill="none" stroke="currentColor" strokeWidth="2"
       strokeLinecap="round" strokeLinejoin="round">
    {d}{extra}
  </svg>
);
const IconTruck  = () => svg(<><path d="M3 16V7h10v9" /><path d="M13 11h4l3 3v2h-7" /><circle cx="7" cy="17.5" r="1.6" /><circle cx="17" cy="17.5" r="1.6" /></>);
const IconTag    = () => svg(<><path d="M3 7h11l6 5-6 5H3z" /><circle cx="7" cy="12" r="1" /></>);
const IconPin    = () => svg(<><path d="M12 21s7-6.2 7-11a7 7 0 1 0-14 0c0 4.8 7 11 7 11Z" /><circle cx="12" cy="10" r="2.4" /></>);
const IconMotion = () => svg(<><path d="M3 8h9M3 12h13M3 16h7" /><path d="M17 9l3 3-3 3" /></>);
const IconClock  = () => svg(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
const IconSignal = () => svg(<><path d="M4 18v-3M9 18v-6M14 18v-9M19 18V6" /></>);
const IconRoute  = () => svg(<><path d="M4 18c0-3 3-3 3-6s-3-3-3-6" /><circle cx="17" cy="8" r="2.4" /><path d="M17 13V19" /></>);
const IconOpen   = () => svg(<path d="M9 5l7 7-7 7" />);

/**
 * Which atlas ROW a status draws from.
 *
 * Mirrors TRUCK_STATUS_ROWS / TRUCK_ROW_FOR in FleetMap.jsx, which are not
 * exported. Duplicated rather than lifted because the map's copy is load-bearing
 * for marker rendering and this one only decorates a list — but they must stay
 * in step, so if the atlas is re-baked with different rows, change both.
 */
const ATLAS_ROWS = ["ok", "speeding", "theft", "parked", "idling"];
const ATLAS_ROW_FOR = { stationary: "parked", "signal-lost": "ok" };
const atlasRow = (status) =>
  Math.max(0, ATLAS_ROWS.indexOf(ATLAS_ROW_FOR[status] ?? status));

const SPRITE_PX = 22;

/**
 * How old this unit's last fix is, at a glance.
 *
 * Coarse on purpose: the question a operator asks of this column is "is this
 * live, lagging, or long gone", and seconds of precision on a two-day-old fix
 * is noise dressed as rigour.
 */
function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  const s = Math.floor(ms / 1000);
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
/** Fresh, lagging, or stale — the three bands the colour encodes. */
const ageBand = (ms) =>
  !Number.isFinite(ms) ? "none" : ms < 5 * 60_000 ? "live" : ms < 60 * 60_000 ? "lag" : "old";

/** Moving, running-but-stationary, or stopped. */
const MOTION = {
  transit: { glyph: "▲", label: "Moving" },
  idling:  { glyph: "◼", label: "Idling, stationary, engine running" },
  parked:  { glyph: "◼", label: "Stationary" },
};

const norm = (s) => String(s ?? "").toLowerCase();

/** The six columns that carry a VALUE, in the order they appear. */
const SORTABLE = [
  { key: "type",   cls: "sprite", label: "machine type",              Icon: IconTruck },
  { key: "plate",  cls: "plate",  label: "unit",                      Icon: IconTag },
  { key: "loc",    cls: "loc",    label: "location",                  Icon: IconPin },
  { key: "motion", cls: "motion", label: "motion state",              Icon: IconMotion },
  { key: "age",    cls: "age",    label: "data recency",              Icon: IconClock },
  { key: "conn",   cls: "conn",   label: "connection",                Icon: IconSignal },
];

/** Most active first, when motion is the sort. */
const ACTIVITY_RANK = { transit: 0, idling: 1, parked: 2 };

/**
 * What each sortable column sorts ON.
 *
 * The value returned is what gets compared, so each one is the column's
 * MEANING rather than its rendering: recency sorts on age in milliseconds, not
 * on the string "82d", which would put 7d after 559d and 82d after 2m.
 *
 * `null` means "this unit has no such value" and always sorts last — the
 * spreadsheet convention. Reversing the direction reverses the units that HAVE
 * a value; it does not promote the blanks to the top, because "no fix" is
 * never the answer anyone is looking for when they sort by position.
 */
const SORT_VALUE = {
  type:   (v) => fleetTypeLabel(fleetType(v)),
  plate:  (v) => String(v?.id ?? ""),
  /* LATITUDE, not the printed string.
   *
   * Two reasons. Sorting "-0.3491, 34.5963" as text only happens to work while
   * every unit shares a sign and a magnitude — put one vehicle north of the
   * equator beside one south of it and the order is nonsense. And `location`
   * is not always a coordinate: a unit with no fix carries the words "No
   * signal", which as text sorts to the TOP in descending order, putting the
   * units that have no position at the head of a list ordered by position.
   * Latitude orders them north to south and leaves the fixless ones null, so
   * they fall last in both directions like every other blank. */
  loc:    (v) => (Number.isFinite(v?.lat) ? v.lat : null),
  motion: (v) => ACTIVITY_RANK[vehicleActivity(v)] ?? 3,
  age:    (v, clock) => (Number.isFinite(v?.capturedAtMs) ? clock - v.capturedAtMs : null),
  conn:   (v) => (v?.online ? 0 : 1),
};

/** Blanks last in both directions; numbers numerically, text by locale. */
function compareBy(a, b, dir) {
  const missA = a == null || a === "";
  const missB = b == null || b === "";
  if (missA || missB) return missA && missB ? 0 : missA ? 1 : -1;
  const r = typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b));
  return dir === "desc" ? -r : r;
}

/** A drawing pin, upright when loose and driven in when pinned. */
function IconPushPin({ on }) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
         fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 17v5" />
      <path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6Z" />
    </svg>
  );
}

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

/**
 * `open` / `onOpenChange` let the sidebar open it (controlled); without them
 * the map's own button does (uncontrolled, as in dash). `asWindow` draws it as
 * the floating window beside the sidebar.
 */
/**
 * Units with no plate are named after their tracker's IMEI ("MUFINDI -
 * 864022086893947") — fifteen digits nobody reads, which pushed every such
 * name past the column. Shown as "MUFINDI - 8640…"; the full id stays in the
 * row's tooltip and in search.
 */
const shortPlate = (id) => String(id).replace(/(\d{4})\d{6,}$/, "$1…");

/**
 * The location cell: the place name, reverse-geocoded (usePlaceName — cached
 * per ~1.1 km cell, so units parked together share one lookup), with the
 * coordinates as the fallback until it resolves and in the tooltip after.
 *
 * Only a row that has been on screen asks the network. The list holds every
 * unit in the fleet, the server answers one new lookup a second, and a
 * request for a row nobody scrolled to would queue ahead of one they can see.
 * Once seen, a row keeps its lookup — scrolling back must not ask again.
 */
function UnitPlace({ v }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    // Root null still clips by the scrolling list, so off-list rows stay unseen.
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setSeen(true);
    }, { rootMargin: "120px 0px" });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  const hasFix = Number.isFinite(v.lat) && Number.isFinite(v.lng);
  const place = usePlaceName(hasFix ? v.lat : null, hasFix ? v.lng : null, { enabled: seen });
  const coords = v.location || null;
  return (
    <span ref={ref} className="units-menu__loc" role="cell"
          title={coords ? (place ? `${place} (${coords})` : coords) : "No fix"}>
      {place || coords || "-"}
    </span>
  );
}

export default function UnitsMenu({
  vehicles,
  trackedIds,
  onSetTracked,
  routeId,
  onToggleRoute,
  onOpenDetail,
  nowTick,
  open: openProp,
  onOpenChange,
  asWindow = false,
}) {
  const [openLocal, setOpenLocal] = useState(false);
  const controlled = typeof openProp === "boolean";
  const open = controlled ? openProp : openLocal;
  /* Worked out before any setState, not inside an updater: `onOpenChange` is a
     side effect, and React may run an updater twice. */
  const openRef = useRef(open);
  openRef.current = open;
  const setOpen = useCallback((next) => {
    const v = typeof next === "function" ? next(openRef.current) : next;
    if (!controlled) setOpenLocal(v);
    onOpenChange?.(v);
  }, [controlled, onOpenChange]);

  /* Pinned: a press outside stops dismissing the window. Folded: only its
     title bar shows. Both only mean anything for the window. */
  const [pinned, setPinned] = useState(false);
  const [minimized, setMinimized] = useState(false);
  const folded = asWindow && minimized;

  /* Opened beside the sidebar, measured rather than declared (the sidebar is
     320px on a desktop and 260 at 1024), then draggable anywhere. */
  const initialPos = useMemo(() => {
    if (!asWindow || typeof document === "undefined") return undefined;
    const rail = document.querySelector(".side-panel");
    const head = document.querySelector(".app-header");
    return {
      x: (rail?.getBoundingClientRect().right ?? 0) + 12,
      y: (head?.getBoundingClientRect().bottom ?? 0) + 12,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asWindow, openProp]);
  const { ref: winRef, onPointerDown: onHeadPointerDown } = useFloatingWindow({
    id: "units",
    dock: "top-center",
    enabled: asWindow && open,
    initial: initialPos,
  });
  const [query, setQuery] = useState("");
  // Plate ascending is the default because it is the only column whose order
  // an operator can predict before they look at it.
  const [sort, setSort] = useState({ key: "plate", dir: "asc" });
  const wrapRef = useRef(null);
  const btnRef = useRef(null);
  const panelId = useId();

  // Same dismissal contract as the fuel-alerts and layers menus — see
  // MapLayersMenu for why `pointerdown` rather than `click`, and why Escape
  // hands focus back to the trigger.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (pinned || folded) return;
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      // The map's trigger is hidden on a desktop; focusing a hidden button
      // would drop focus to <body>.
      if (btnRef.current?.offsetParent) btnRef.current.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, pinned, folded]);

  const tracked = useMemo(() => new Set(trackedIds ?? []), [trackedIds]);

  /**
   * Filtering runs over the whole fleet, so it must not run on every keystroke.
   * The input stays responsive on its own state; the LIST re-derives from the
   * deferred copy, which React is free to drop while more typing is coming.
   */
  const deferredQuery = useDeferredValue(query);

  /* One clock for both the recency COLUMN and the recency SORT, so a row can
     never be ordered by an age different from the one it prints. */
  const sortClock = Number.isFinite(nowTick) ? nowTick : Date.now();

  const rows = useMemo(() => {
    const q = norm(deferredQuery).trim();
    const list = (vehicles ?? []).filter(
      (v) => !q || norm(v.id).includes(q) || norm(v.name).includes(q)
    );
    const value = SORT_VALUE[sort.key] ?? SORT_VALUE.plate;
    // Plate is the tiebreak on every column, so equal values keep ONE stable
    // order rather than whatever the last sort happened to leave behind —
    // a list that reshuffles its ties on each re-render is unreadable.
    return [...list].sort((a, b) => {
      const r = compareBy(value(a, sortClock), value(b, sortClock), sort.dir);
      return r !== 0 ? r : String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
    });
  }, [vehicles, deferredQuery, sort, sortClock]);

  const shownIds = useMemo(() => rows.map((v) => v.id), [rows]);

  /* ── the unit that is in another one of your organisations ───────────────
   *
   * An account with several tenants searches from whichever one happens to be
   * open, and "No unit matches that search" is a lie when the unit is simply
   * in a different organisation. Once the fleet in front of the operator has
   * nothing to offer, the server is asked across their memberships; a single
   * answer moves the dashboard there and focuses the unit, an ambiguous one is
   * listed below so they choose. See hooks/useCrossOrgUnits.
   *
   * Deferred, not raw: this must ask the same question the rows answered, or
   * the panel would look empty for a query the lookup was not run for. */
  // `companies` from this context is ALREADY the filtered roster — the
  // organisations this account may open, not the platform's whole list.
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const { setActiveCompanyId, setPendingFocusId } = useAppActions();
  const { activeCompany, companies } = useCompanies();
  const { companies: elsewhere, loading: lookingElsewhere, move } = useCrossOrgUnitHandoff({
    query: deferredQuery,
    enabled: open && rows.length === 0,
    activeCompanyId,
    visibleCompanies: companies,
    setActiveCompanyId,
    setPendingFocusId,
  });

  if (!vehicles?.length) return null;

  const trackedCount = tracked.size;
  // The header tick means the rows in front of you. With a query typed,
  // selecting the whole fleet instead would silently throw away the search
  // just used to find them.
  const allShownTracked = shownIds.length > 0 && shownIds.every((id) => tracked.has(id));
  const someShownTracked = !allShownTracked && shownIds.some((id) => tracked.has(id));

  /* Updaters, not lists built from `trackedIds`: that prop is the list as of
     the last render, and two ticks before the next one would each start from
     it and the second would erase the first. */
  function toggleTracked(id) {
    onSetTracked?.((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /** Click a column to sort by it; click it again to reverse. */
  function sortBy(key) {
    setSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));
  }
  const ariaSort = (key) =>
    sort.key !== key ? "none" : sort.dir === "asc" ? "ascending" : "descending";

  function toggleAllShown() {
    const shown = new Set(shownIds);
    onSetTracked?.(allShownTracked
      ? (prev) => prev.filter((id) => !shown.has(id))
      : (prev) => [...new Set([...prev, ...shownIds])]);
  }

  return (
    <div className="units-menu" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className={`map-cam-btn units-menu__btn${open ? " units-menu__btn--open" : ""}${trackedCount ? " units-menu__btn--on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`Units${trackedCount ? `, ${trackedCount} tracked` : ""}`}
        title="Units"
      >
        <IconTruck />
        {/* While the panel is shut this badge is the entire reason the map is
            showing four vehicles instead of six hundred. */}
        {trackedCount > 0 && <span className="units-menu__count" data-digits={String(trackedCount).length}>{trackedCount}</span>}
      </button>

      {open && (
        <div
          className={`units-menu__panel${asWindow ? " units-menu__panel--window" : ""}${folded ? " units-menu__panel--min" : ""}`}
          id={panelId}
          role="group"
          aria-label="Units"
          ref={asWindow ? winRef : undefined}
        >
          {/* As a window the head is the drag handle; useFloatingWindow ignores
              a drag that starts on a button, so these keep their own press. */}
          <div className="units-menu__head" onPointerDown={asWindow ? onHeadPointerDown : undefined}>
            <span className="units-menu__title">
              Units{folded && trackedCount > 0 ? ` \u00b7 ${trackedCount} tracked` : ""}
            </span>
            {trackedCount > 0 && !folded && (
              <button
                type="button"
                className="units-menu__clear"
                onClick={() => onSetTracked?.([])}
              >Show all</button>
            )}
            {asWindow && (
              <div className="units-menu__winbtns">
                <button
                  type="button"
                  className={`units-menu__winbtn${pinned ? " units-menu__winbtn--on" : ""}`}
                  aria-pressed={pinned}
                  onClick={() => setPinned((v) => !v)}
                  title={pinned ? "Unpin: a press outside closes this again" : "Pin: keep this open while working on the map"}
                >
                  <IconPushPin on={pinned} />
                </button>
                <button
                  type="button"
                  className="units-menu__winbtn"
                  aria-expanded={!minimized}
                  aria-label={minimized ? "Expand units" : "Minimize units"}
                  onClick={() => setMinimized((v) => !v)}
                  title={minimized ? "Expand" : "Minimize"}
                >
                  <IconWinMin min={minimized} />
                </button>
                <button
                  type="button"
                  className="units-menu__winbtn"
                  onClick={() => setOpen(false)}
                  title="Close"
                  aria-label="Close units"
                >
                  <IconWinClose />
                </button>
              </div>
            )}
          </div>

          {!folded && (<>

          <input
            className="units-menu__search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search plate or name"
            aria-label="Search units"
          />

          <div className="units-menu__table" role="table" aria-label="Units">
            {/* Icons, not words — see the note at the top of this file. The
                names live in title/aria-label so nothing is lost. */}
            <div className="units-menu__row units-menu__row--head" role="row">
              <button
                type="button"
                className="units-menu__tick"
                role="checkbox"
                aria-checked={allShownTracked ? "true" : someShownTracked ? "mixed" : "false"}
                aria-label={allShownTracked ? "Untrack all listed units" : "Track all listed units"}
                title={allShownTracked ? "Untrack all listed" : "Track all listed"}
                onClick={toggleAllShown}
                disabled={shownIds.length === 0}
              >
                <span className={`units-menu__box${someShownTracked ? " units-menu__box--some" : ""}`} aria-hidden="true" />
              </button>
              {/* Sortable columns are BUTTONS; the two action columns are not,
                  because there is nothing to order a control by. Sorting is
                  the header's only job — the tick beside them selects, which
                  is why that one is left out of this set. */}
              {SORTABLE.map(({ key, cls, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  role="columnheader"
                  aria-sort={ariaSort(key)}
                  className={`units-menu__h units-menu__h--sortable units-menu__h--${cls}${sort.key === key ? " units-menu__h--on" : ""}`}
                  data-dir={sort.key === key ? sort.dir : undefined}
                  title={`${label}, click to sort${sort.key === key ? (sort.dir === "asc" ? ", again to reverse" : ", again to reverse") : ""}`}
                  aria-label={`Sort by ${label}`}
                  onClick={() => sortBy(key)}
                ><Icon /></button>
              ))}
              <span className="units-menu__h units-menu__h--route"  role="columnheader" title="Quick track, draw this unit's route" aria-label="Quick track"><IconRoute /></span>
              <span className="units-menu__h units-menu__h--open"   role="columnheader" title="Open unit" aria-label="Open unit"><IconOpen /></span>
            </div>

            <div className="units-menu__list">
              {rows.map((v) => {
                const isTracked = tracked.has(v.id);
                const routeOn = routeId === v.id;
                const activity = vehicleActivity(v);
                const motion = MOTION[activity] ?? MOTION.parked;
                const age = sortClock - (v.capturedAtMs ?? NaN);
                const band = ageBand(age);
                const kind = spriteKind(v);
                return (
                  <div
                    key={v.id}
                    role="row"
                    className={`units-menu__row${isTracked ? " units-menu__row--on" : ""}`}
                  >
                    {/* A checkbox, not a switch — this is "which of these",
                        exactly as in the fleets funnel one button down. */}
                    <button
                      type="button"
                      className="units-menu__tick"
                      role="checkbox"
                      aria-checked={isTracked}
                      aria-label={`Track ${v.id}`}
                      onClick={() => toggleTracked(v.id)}
                    >
                      <span className="units-menu__box" aria-hidden="true" />
                    </button>

                    {/* The marker's own pixels — see the note at the top. */}
                    <span
                      className={`units-menu__sprite lf-truck lf-truck--${kind}`}
                      style={{ "--lf-marker": `${SPRITE_PX}px`, backgroundPosition: `0 -${atlasRow(v.status) * SPRITE_PX}px` }}
                      title={fleetTypeLabel(fleetType(v))}
                      role="cell"
                      aria-label={fleetTypeLabel(fleetType(v))}
                    />

                    <span className="units-menu__plate" role="cell" title={v.name || v.id}>
                      <span className="units-menu__plate-text">{shortPlate(displayPlate(v))}</span>
                      {/* Reported for a fuel probe repair. Its alerts still come
                          (operator, 2026-10-13: "do not put a unit on hold"). */}
                      {v.probeHold && (
                        <span className="units-menu__hold"
                              title="Reported for a fuel probe repair. Its fuel alerts still come, marked as reported.">Reported</span>
                      )}
                    </span>

                    <UnitPlace v={v} />

                    <span
                      className={`units-menu__motion units-menu__motion--${activity}`}
                      role="cell"
                      style={{ color: v.online ? ACTIVITY_COLORS[activity] : "#64748b" }}
                      title={v.online ? motion.label : "Offline, last known state"}
                      aria-label={motion.label}
                    >{motion.glyph}</span>

                    <span
                      className={`units-menu__age units-menu__age--${band}`}
                      role="cell"
                      title={Number.isFinite(age) ? `Last fix ${ageLabel(age)} ago` : "No fix recorded"}
                    >{ageLabel(age)}</span>

                    <span
                      className={`units-menu__conn${v.online ? " units-menu__conn--on" : ""}`}
                      role="cell"
                      title={v.online ? "Online" : "Offline"}
                      aria-label={v.online ? "Online" : "Offline"}
                    />

                    {/* Exclusive by construction: the handler upstream takes the
                        route off whichever unit had it. */}
                    <button
                      type="button"
                      className={`units-menu__act units-menu__act--route${routeOn ? " units-menu__act--on" : ""}`}
                      role="switch"
                      aria-checked={routeOn}
                      aria-label={`${routeOn ? "Hide" : "Show"} route for ${v.id}`}
                      title={routeOn ? "Hide this route" : "Show this route, replaces the one showing"}
                      onClick={() => onToggleRoute?.(v.id)}
                    >
                      <IconRoute />
                    </button>

                    <button
                      type="button"
                      className="units-menu__act units-menu__act--open"
                      aria-label={`Open ${v.id}`}
                      title="Open this unit"
                      onClick={() => { setOpen(false); onOpenDetail?.(v.id); }}
                    >
                      <IconOpen />
                    </button>
                  </div>
                );
              })}
              {rows.length === 0 && (
                <div className="units-menu__empty">
                  {lookingElsewhere
                    ? "Checking your other organisations…"
                    : elsewhere.length === 0
                      ? "No unit matches that search."
                      : (
                        <>
                          {/* Two or more organisations hold a match, so the
                              dashboard does not guess — an org switch costs the
                              fleet, the feed and the camera to undo. */}
                          <span className="units-menu__empty-lead">
                            Not in {activeCompany?.short || "this organisation"}. Found in:
                          </span>
                          {elsewhere.map(({ company, units }) => (
                            <button
                              key={company.id}
                              type="button"
                              className="units-menu__elsewhere"
                              onClick={() => { move(company, units[0]); }}
                              title={`Switch to ${company.name} and open ${units[0].plate}`}
                            >
                              <span className="units-menu__elsewhere-org">{company.short || company.name}</span>
                              <span className="units-menu__elsewhere-units">
                                {units.slice(0, 3).map((u) => u.plate).join(", ")}
                                {units.length > 3 ? ` +${units.length - 3}` : ""}
                              </span>
                            </button>
                          ))}
                        </>
                      )}
                </div>
              )}
            </div>
          </div>

          <div className="units-menu__foot">
            {trackedCount === 0
              ? `All ${vehicles.length} units`
              : `${trackedCount} tracked · ${vehicles.length} in fleet`}
          </div>
          </>)}
        </div>
      )}
    </div>
  );
}
