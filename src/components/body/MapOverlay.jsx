// Left/right side panels over the map: search, feed, vehicle detail.

import { rectXY, pointerXY } from "../../lib/appZoom";
import { useState, useEffect, useMemo, useRef, useDeferredValue, memo } from "react";
import VehicleStatsCard, { Tile } from "../cards/VehicleStatsCard";
import "./MapOverlay.scss";
// The fuel incident window renders a real `.vehicle-tooltip` — the hover
// card's own wrapper — and those styles live in FleetMap.scss. It reaches this
// file today only because FleetMap imports MapOverlay; stating the dependency
// means a future move of either component cannot silently unstyle the window.
// Vite dedupes the import.
import "./FleetMap.scss";

import ErrorBoundary    from "../shared/ErrorBoundary";
import { feedClock, feedDate, feedStamp } from "../../lib/feedTime";
import FeedText         from "../shared/FeedText";
import AssetCard       from "../cards/AssetCard";
import TrafficCard     from "../cards/TrafficCard";
import TelemetryCard   from "../cards/TelemetryCard";
import DeliveryCard    from "../cards/DeliveryCard";
import StorageCard     from "../cards/StorageCard";
import MaintenanceCard from "../cards/MaintenanceCard";
import WeatherCard     from "../cards/WeatherCard";
import FleetTrafficCard     from "../cards/FleetTrafficCard";
import FleetMaintenanceCard from "../cards/FleetMaintenanceCard";
import FleetAIInsightCard   from "../cards/FleetAIInsightCard";
import VehicleBriefCard     from "../cards/VehicleBriefCard";
import FleetCargoCard       from "../cards/FleetCargoCard";

import { useAppFields, useCompanies, useAppSelector, useAppActions } from "../../context/AppContext";
import { claimSidePanel, onSidePanelClaim, claimMapWindow, onMapWindowClaim } from "../../lib/sidePanels";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { usePlaceName } from "../../hooks/usePlaceName";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useVehicleFeed } from "../../hooks/useVehicleFeed";
import { feedPlainText } from "../../lib/feedMessage";
import { driverIndex, driverFor } from "../../lib/feedDriver";
import { liveTrip, roundTripKm } from "../../lib/tripProgress";
import { travelModeFor } from "../../lib/tomtomTraffic";
import { positionFresh } from "../../hooks/useTrafficRoute";
import { vehicleReadings, formatKm, formatHours, formatSince, NO_READING } from "../../lib/vehicleReadings";
import { driverDutyStatus, matchesFilter, matchesMapFilters, equipmentLabel } from "../../lib/vehicleMap";
import LoadError from "../shared/LoadError";
import { clampToSafeArea as sharedClamp } from "../../hooks/useFloatingWindow";
import { useDismissedIncidents } from "../../lib/fuelDismissals";
import { usePrefetchFuelAlerts } from "../../lib/fuelPrefetch";
import FuelDayBreakdown from "./FuelDayBreakdown";
import FuelReview from "./FuelReview";
import { isConfirmedTheft } from "../../lib/fuelAlerts";

const FEED_CLS = { info: "fi-info", warning: "fi-warning", critical: "fi-critical", success: "fi-success" };
const FEED_ICO = { info: "💬", warning: "⚠", critical: "🔴", success: "✓" };

/* The search RESULT CARD used to live here.
 *
 * The box above the feed looked a unit up and opened a vitals card under
 * itself — a second, smaller vehicle panel competing with the one the map
 * already opens on a marker click, reached by typing rather than pointing.
 * The box filters the live feed now, so nothing renders a result card and
 * the component went with it. Looking a unit up is still a thing you can do:
 * the Units panel searches plates and names, and clicking a marker or a feed
 * row opens the same rich card this one was a copy of.
 */


/**
 * The headline, per RULE rather than per cause.
 *
 * One non-theft label cannot be honest across four findings. "Unexplained
 * fuel drop" was the first attempt and it named OUR failure to account for
 * the drop rather than what was measured — which is what the operator
 * objected to, and the same defect that got the LOSS verdict removed. Each
 * label below states the observation.
 */
const INCIDENT_TITLE = {
  'parked-sustained-fall':    'Possible theft',
  'drop-while-stationary':    'Fuel down while stationary',
  'drop-exceeds-distance':    'Fuel down beyond the distance driven',
  'burn-above-class-ceiling': 'Burn rate above the set ceiling',
  'burn-far-above-band':      'Burn rate above measured',
};

/* `fmtL` retired with the incident banner — the only thing that formatted a
   volume out here. The window's own body has always had its own, and the fuel
   alerts menu has one sized for a list row. */

/** "42 min", "3 h 10 min" — a duration an operator can picture. */

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "3 h ago", "yesterday 21:04" — how long ago this was. */
function fmtAgo(then, now = Date.now()) {
  const ms = now - then.getTime();
  if (ms < 0) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

const clock = (d) =>
  d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const dayLabel = (d) =>
  d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * Incidents the operator has dismissed, by ledger id.
 *
 * Kept in localStorage rather than on the server: dismissing is a statement
 * about THIS person's screen, not about the fuel. The row keeps its verdict,
 * the vehicle keeps its colour, and the next person to open the panel still
 * sees the incident — which is the conservative direction. A dismissal that
 * silenced an incident for everyone would need to be an acknowledgement, with
 * a name and a time against it, and that is a different feature.
 */
const DISMISS_KEY = 'ft-fuel-incident-dismissed';

function readDismissed() {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

/**
 * What the incident says, as the body of the modal.
 *
 * ## It reports an EVENT, not a score
 *
 * An operator asked to send someone to a machine needs the window to look at,
 * the levels to check against the gauge, and the rate — 47 L over four hours
 * and 47 L over four minutes are different events with the same headline.
 *
 * ## The wording is the server’s decision, not this component’s
 *
 * `mayUseTheftWording` arrives on the incident and is derived server-side from
 * the cause. It is NOT re-derived here: a second implementation of the
 * vocabulary rule is a second one that can drift, and the rule is narrow —
 * only a SIPHON, where the engine was provably off and the fall was neither
 * settling nor a probe step, may be called a possible theft.
 */
/**
 * The incident, appended UNDER the real vehicle card.
 *
 * The window shows `VehicleStatsCard` — the same component the map hover card
 * renders, in the same `.vehicle-tooltip` wrapper — because that is what the
 * operator asked for and because a second card that merely resembles it is a
 * second card that drifts. This adds only what the vehicle card has no slot
 * for: what happened to the fuel, and when.
 *
 * Written in the card's own idiom (`vt-divider`, `vt-tiles`, `Tile`) so it
 * reads as the bottom of that card rather than as something bolted on.
 */

/**
 * The incident, appended UNDER the real vehicle card.
 *
 * The window renders `VehicleStatsCard` — the same component the map hover
 * shows — and this adds what that card has no slot for. It answers two
 * questions in order, because that is the order an operator asks them:
 *
 *   WHAT happened   volume, window, rate, both ends of the gauge
 *   THE DAY         the unit's whole fleet day as a tank ledger (opening,
 *                   refuelled, closing, used, what the engine should have
 *                   used, what it does not explain) and the day's events in
 *                   order — see FuelDayBreakdown
 *
 * The "Record / Movement / Came back / Rule" rows that stood where the day
 * now is were removed by request: they described how the verdict was
 * reached, and left the reader to reconstruct the day it belonged to. The
 * rule slug survives as the title badge's tooltip, for whoever audits it.
 *
 * It used to answer a third — HOW SURE — as two percentage bars captioned
 * "FUEL LEFT THE TANK" and "AND THIS IS WHY". They are gone. The pair was
 * `verdictConfidence` and `causeConfidence`, and the caption was the only
 * thing telling the two apart, so what the window actually showed was two
 * near-identical bars and a distinction it never explained. The Rule row
 * already names the slug that settled it, which is the checkable version of
 * the same claim.
 */

function FuelIncidentBody({ incident, vehicleId, cardShowsLevel = false }) {
  if (!incident) return null;

  const theft  = incident.mayUseTheftWording === true;
  // Tokens, not hexes: an inline style outranks every `.app--light` rule, so a
  // literal here is a colour that cannot follow the theme. #ef4444 measures
  // 3.8 on a white card and #f59e0b 2.2.
  const accent = theft ? 'var(--accent-crit)' : 'var(--accent-warn)';
  /* The chips had NO fill and NO border, in both themes, and it was invisible
     as a bug because the text still painted.
     `accent + '22'` reads as hex-alpha shorthand, but `accent` is a var()
     reference, so the string that reached the DOM was the literal
     `var(--accent-crit)22` — invalid at computed-value time, dropped, and the
     computed background came back `rgba(0, 0, 0, 0)` with `border-width: 0`.
     What looked like a badge was a 10px coloured word on the card.
     color-mix takes the var() and returns a real colour, so the chip is a
     chip — and it still follows the theme, which is the whole reason the
     accent was a token and not a hex in the first place. */
  const tint = (pct) => `color-mix(in srgb, ${accent} ${pct}%, transparent)`;
  const began  = incident.beganAt ? new Date(incident.beganAt) : null;
  const ended  = incident.detectedAt ? new Date(incident.detectedAt) : null;

  const litres = incident.volumeMl != null ? incident.volumeMl / 1000 : null;
  const before = incident.tankBeforeMl != null ? incident.tankBeforeMl / 1000 : null;
  const after  = incident.tankAfterMl  != null ? incident.tankAfterMl  / 1000 : null;

  const spanMs = began && ended ? ended.getTime() - began.getTime() : null;
  const hours  = spanMs ? spanMs / 3600000 : null;
  const rate   = hours && hours > 0 && litres != null ? Math.round(litres / hours) : null;

  // The fuel alerts are theft cases only (operator, 2026-09-27), so the badge
  // names the alert rather than the rule that raised it — the burn-rate badges
  // ("Burn rate above the set ceiling") described findings that now go to the
  // daily summary. The rule stays in the tooltip for whoever audits it.
  const title   = theft ? 'Fuel theft alert' : (INCIDENT_TITLE[incident.reason] ?? 'Fuel alert');
  const num     = (n) => (n == null ? '-' : n % 1 === 0 ? String(n) : n.toFixed(1));
  // CONFIRMED when the server is at least 80% sure it was a theft — the cause's
  // own confidence, on a cause allowed to be called one (lib/fuelAlerts). Not
  // "our telemetry watched it", which is what it used to mean and which a
  // slosh can satisfy. The repeat badge ("5TH IN 30 D") that sat beside it was
  // removed at the same request (operator, 2026-09-27).
  const confirmed = isConfirmedTheft(incident);
  const rule       = `${incident.reason ?? ''}${incident.verdictReason ? ` \u00b7 ${incident.verdictReason}` : ''}`;

  // NOT `.vt-info`: that class carries `pointer-events: none; user-select:
  // none`, which is right for a card chasing the cursor and wrong for a dialog
  // whose whole point is that you can sit and read it — and whose reference id
  // exists to be copied. The separator from whatever sits above is drawn by
  // `.fi-body-detail`, because in the two-column layout it is a vertical rule.
  return (
    <div className="fi-section">
      <div className="fi-section-hdr">
        <span className="vt-status-badge" title={rule ? `Rule: ${rule}` : undefined} style={{
          background: tint(13), color: accent, border: `1px solid ${tint(34)}`,
        }}>{title}</span>
        {confirmed && (
          <span className="fi-tag" title={`${Math.round(incident.confidence * 100)}% sure this was a theft`}>CONFIRMED</span>
        )}
        {began && (
          <span className="fi-when">
            {dayLabel(began)} {clock(began)}{ended ? ` \u2013 ${clock(ended)}` : ''}
          </span>
        )}
      </div>

      {/* Escalated / de-escalated, and for an administrator the way to decide. */}
      <FuelReview incident={incident} />

      <div className="vt-tiles">
        {/* Not "Possible theft" unconditionally: only a SIPHON has earned that
            word, and the tile was saying it over a rate finding and a
            stationary drop alike. `mayUseTheftWording` is decided server-side
            by the same rule the notification text uses. */}
        <Tile label={theft ? 'Possible theft' : 'Fuel down'} value={num(litres)} unit={litres != null ? ' L' : ''}
              sub={spanMs ? `over ${fmtDuration(spanMs)}` : ''} valColor={accent} />
        <Tile label="RATE" value={rate != null ? rate : '-'} unit={rate != null ? ' L/h' : ''}
              sub={fmtAgo(began) ?? ''} />
        <Tile label="TANK BEFORE" value={num(before)} unit={before != null ? ' L' : ''}
              sub={began ? clock(began) : ''} />
        <Tile label="TANK AFTER" value={num(after)} unit={after != null ? ' L' : ''}
              sub={ended ? clock(ended) : ''} />
      </div>

      <div className="vt-divider" />

      {/* The day this happened on, as a ledger and a timeline. */}
      <FuelDayBreakdown incident={incident} vehicleId={vehicleId} cardShowsLevel={cardShowsLevel} />
    </div>
  );
}

/**
 * Where a pinned window was left, so it survives a reload.
 *
 * Position and pinned-ness only. The DISMISSED set is separate and keyed by
 * incident id — losing your window layout and losing your record of what you
 * have already dealt with are different mistakes.
 */
const WINDOW_KEY = 'ft-fuel-incident-window';

function readWindowState() {
  try {
    const raw = localStorage.getItem(WINDOW_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
function writeWindowState(v) {
  try { localStorage.setItem(WINDOW_KEY, JSON.stringify(v)); } catch { /* quota */ }
}

/**
 * Keep a window inside the free area after a drag, a resize, or a smaller
 * monitor — see safeArea in hooks/useFloatingWindow.
 *
 * "On screen" was never the requirement. The rails either side of the map are
 * 336px and 340px, so the middle of the viewport is not the middle of what can
 * be seen, and a window parked at x=100 is behind the left rail while passing
 * every viewport test there is.
 *
 * The SHARED clamp, not a second copy. There were two, with different edge
 * insets and different fallback sizes, so the floating windows on this screen
 * disagreed about how far a window could go — and only one of them was ever
 * fixed when that was wrong.
 *
 * `w`/`h` are the window's REAL measured size where the caller has it (during a
 * drag it does), because a guess that is too small on a 680px-wide window lets
 * it be dragged most of the way past the right rail.
 */
const clampToViewport = (x, y, w = 680, h = 200) => sharedClamp(x, y, w, h);

/**
 * Below this the window is a SHEET and stops being a window.
 *
 * The same 720px the body columns collapse at, deliberately — this component
 * already owns one breakpoint and a second one for the same component is two
 * numbers to keep in step. The behaviour it gates is in FuelIncidentModal; the
 * geometry is the matching block in MapOverlay.scss.
 */
const SHEET_Q = '(max-width: 720px)';

/**
 * The incident as a window: openable, movable, pinnable, collapsible,
 * dismissable.
 *
 * It began as an inline card in the vehicle panel, which made it unmissable
 * and also unremovable. It is now something an operator can put where they
 * want it and keep — or get rid of.
 *
 * ## Pinned is a different mode, not a flag
 *
 * UNPINNED it is a modal: a backdrop, Escape closes, a click outside closes,
 * and it centres itself. That is right for "here is the thing you just asked
 * to see".
 *
 * PINNED the backdrop goes away entirely and the window floats over a fully
 * usable map — you can select other vehicles, pan, search, with the incident
 * still open beside you. That is right for "keep this in front of me while I
 * work out what happened". Position and pinned-ness persist across reloads,
 * because a window you deliberately placed should still be there tomorrow.
 *
 * ## Four exits, and only one is irreversible
 *
 *   COLLAPSE  folds to the title bar; the numbers are hidden, nothing is lost
 *   CLOSE     hides it; the panel banner reopens it
 *   ESCAPE / backdrop  same as close, and only when unpinned
 *
 * There is no Delete (operator, 2026-09-30). An alert leaves the dashboard
 * only by being escalated or de-escalated (FuelReview), so it always goes
 * with a decision on its record.
 */
/* The title bar's glyphs, drawn the way the Units window draws its own
   (UnitsMenu IconPushPin / IconWinMin / IconWinClose) so the two windows read
   as one family. The pin was an emoji, which every platform paints in its own
   red whatever the theme. */
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

function FuelIncidentModal({ incident, vehicle, plate, pinned, onPinnedChange, onClose }) {
  // Lazy: useRef(readWindowState()) would re-read and re-parse localStorage on
  // every render and discard the result.
  const [saved] = useState(readWindowState);
  const [collapsedPref, setCollapsed] = useState(!!saved.collapsed);
  const [pos, setPos] = useState(
    saved.pinned && saved.x != null ? clampToViewport(saved.x, saved.y) : null,
  );
  const drag = useRef(null);
  const modalRef = useRef(null);

  /* On a phone this is a sheet, and a sheet is always a modal: it cannot be
     dragged (there is nowhere to put it), cannot be pinned (there is nothing
     to work beside it), and must not honour a position stored on a desktop
     session. Read as a query rather than from the resize handler so the first
     paint is already a sheet — see useMediaQuery. */
  const sheet = useMediaQuery(SHEET_Q);
  const asWindow = !sheet;
  // Folding is a window's control too. A sheet has no collapse button, so a
  // fold remembered from a desktop session must not arrive folded here.
  const collapsed = collapsedPref && asWindow;

  const persist = (next) => writeWindowState({ pinned, collapsed, x: pos?.x, y: pos?.y, ...next });

  /**
   * Re-clamp against the MEASURED window, on mount and on every resize.
   *
   * Two separate holes this closes. The restore above clamps with a guessed
   * 680×200, and a guess is exactly what the clamp must not have — a window
   * remembered at the right-hand edge of a wide monitor comes back on a laptop
   * behind the right rail, and a collapsed one is 38px tall rather than 200, so
   * the vertical clamp had 162px of slack to give away. And nothing re-ran on
   * resize at all: the shared hook has done that for its windows since it was
   * extracted, but this window predates it and kept its own drag.
   *
   * Only when pinned — unpinned it is a centred dialog with no stored position.
   */
  useEffect(() => {
    if (!pinned || sheet) return undefined;
    const fit = () => {
      const el = modalRef.current;
      if (!el) return;
      /* Layout px: the stored position and the clamp are both in CSS pixels,
         and a client rect under `zoom` is not. See src/lib/appZoom.js. */
      const r = rectXY(el.getBoundingClientRect());
      setPos((p) => (p ? clampToViewport(p.x, p.y, r.width, r.height) : p));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [pinned, collapsed, sheet]);

  // Escape closes, but only when this is behaving as a modal. A pinned window
  // sits alongside the app, and Escape belongs to whatever the operator is
  // actually working in.
  useEffect(() => {
    if (pinned && asWindow) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, pinned, asWindow]);

  // How far the pointer must travel before a press counts as a drag. Real
  // drags cross this immediately; a click that jitters a pixel does not.
  const DRAG_SLOP = 3;

  // Drag by the title bar. Pointer events rather than mouse: they cover touch
  // and pen, and setPointerCapture keeps the drag alive when the cursor
  // outruns the window — which it does, because dragging a small window
  // quickly is exactly when the pointer leaves it.
  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    // THE BUTTONS SIT INSIDE THE DRAG HANDLE, so let their press through.
    //
    // Without this the pin, collapse and close icons are dead to a real mouse.
    // `setPointerCapture` below redirects every later pointer event for this
    // pointer to the bar, which means `pointerup` lands on the BAR rather than
    // on the button — and the browser fires `click` on the nearest common
    // ancestor of the down and up targets, so the click goes to the bar and
    // the button's onClick never runs. Nothing throws and nothing logs; the
    // icons just quietly do nothing.
    //
    // (Programmatic `el.click()` does fire them, because it skips the pointer
    // sequence entirely — so this cannot be verified by dispatching clicks in
    // the console. It has to be a real press.)
    if (e.target.closest('button')) return;
    // A sheet is not draggable: it is already the full width of the screen and
    // pinned to the bottom of it. Without this the drag still ran on touch and
    // — because the first real move pins — a thumb that slid a few pixels on
    // the title bar silently took the backdrop away.
    if (sheet) return;

    const box = rectXY(e.currentTarget.closest('.fi-modal').getBoundingClientRect());
    const p0 = pointerXY(e);
    drag.current = {
      dx: p0.x - box.left, dy: p0.y - box.top,
      w: box.width, h: box.height,
      x0: p0.x, y0: p0.y,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const d = drag.current;

    // Pin on the first real MOVE, not on the press. Dragging implies keeping:
    // a window you have positioned is one you want to stay put, and
    // re-centring it on the next open would undo the act. But a press that
    // never travels is not a drag, and silently switching the window into
    // pinned mode under a stray click on its title bar — which is what
    // pinning on pointerdown did — is not something the operator asked for.
    const p = pointerXY(e);
    if (!d.moved) {
      if (Math.hypot(p.x - d.x0, p.y - d.y0) < DRAG_SLOP) return;
      d.moved = true;
      if (!pinned) { onPinnedChange(true); persist({ pinned: true }); }
    }
    setPos(clampToViewport(p.x - d.dx, p.y - d.dy, d.w, d.h));
  };
  const onPointerUp = (e) => {
    if (!drag.current) return;
    const moved = drag.current.moved;
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (moved) persist({ x: pos?.x, y: pos?.y });
  };

  if (!incident) return null;

  const theft = incident.mayUseTheftWording === true;
  // The stored position belongs to the window. Applied on a phone it is an
  // inline `left`/`top` from someone's 1440px monitor, and an inline style
  // outranks every rule in the sheet block.
  const style = pos && asWindow ? { left: pos.x, top: pos.y, transform: 'none' } : undefined;

  // The two halves of the body, named so the phone can take them in the other
  // order without the JSX for either being written twice. Keyed because they
  // are handed to React as an array.
  const cardCol = vehicle ? (
    <div className="fi-body-card" key="card">
      {/* THE hover card, not a copy of it. Same component, same wrapper
          classes — so the window a click opens and the card a hover shows
          cannot look different from one another.
          Less its "Fuel Theft Alert" badge (operator, 2026-09-27): the
          window's own header says "Fuel theft alert" a column away. The card
          reads `status` for that badge and nothing else, so it is handed the
          vehicle without the alert state. Opened by a click, so it reads the
          unit's day for the start row, as the pinned map card does. */}
      <VehicleStatsCard vehicle={vehicle.status === 'theft' ? { ...vehicle, status: 'ok' } : vehicle} withDay />
    </div>
  ) : null;
  const detailCol = (
    <div className="fi-body-detail" key="detail">
      {/* The card beside it already shows the fuel level now; the phone's
          sheet has no card, so there the day keeps its own. */}
      <FuelIncidentBody incident={incident} vehicleId={vehicle?.vehicleId} cardShowsLevel={!sheet && !!vehicle} />
    </div>
  );

  // IN THE MAP'S OWN SUBTREE, not portalled to <body>.
  //
  // It was portalled because it used to render INSIDE `.overlay-right`, whose
  // z-index: 400 is a stacking context a fixed child cannot escape. It no
  // longer does — RightPanel renders it as a SIBLING of the panel — so the
  // portal's reason had gone, and what it left behind was a window that
  // outlived its own page: App.jsx keeps the fleet tab MOUNTED and merely
  // hides it (`.app-tab-panel--hidden { display: none }`), and a portal to
  // <body> escapes that rule along with the stacking context. The incident
  // window went on floating over Analytics, Drivers and Maintenance — pages it
  // was never opened from and has nothing to say about.
  //
  // Rendered here it is hidden by the same `display: none` that hides the map,
  // in BOTH shells — MobileShell hides its map wrap the same way — with no
  // knowledge of which tab is active and no second copy of the 768px
  // breakpoint that decides which shell is running. It is also how the playback
  // transport and the camera window already behave.
  //
  // The z-index still reaches: nothing between here and <body> opens a stacking
  // context — .fleet-map-body is `position: relative` at z-index auto, and
  // .app-tab-panel, .app-container and #root set none — so `.fi-overlay`'s
  // 4000 still paints over the header and the footer nav at 1000.
  return (
    <div
      // On a desktop the window never blocks the map (operator, 2026-10-15):
      // the alert's route, zones and playback are drawn ON the map
      // (IncidentInvestigation) and have to stay usable beside it. A phone
      // sheet keeps its backdrop.
      className={`fi-overlay${pinned && asWindow ? ' fi-overlay--pinned' : ''}${asWindow ? ' fi-overlay--open' : ''}`}
      role="presentation"
      // Only a click on the backdrop ITSELF closes, and only unpinned — a
      // click that started inside and drifted out on release must not. A sheet
      // is never pinned, so the backdrop above it always dismisses.
      onMouseDown={(e) => { if (sheet && e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={modalRef}
        className={`vehicle-tooltip vehicle-tooltip--rich fi-modal${theft ? '' : ' fi-modal--unexplained'}${collapsed ? ' fi-modal--collapsed' : ''}`}
        style={style}
        role="dialog"
        aria-modal={asWindow ? undefined : 'true'}
        aria-label="Fuel incident"
      >
        {/* ON A PHONE: the Live Feed sheet's header, so the two sheets read as
            one family — a handle, the unit in bold capitals with a status dot,
            the kind of event as a chip, and a round close. The window's grey
            drag bar, pin and fold are desktop chrome. */}
        {sheet && (
          <>
            <div className="fi-handle" aria-hidden="true" />
            <div className="fi-sheet-head">
              <div className="fi-sheet-head-left">
                <span className="fi-sheet-title">{plate ?? '-'}</span>
                <span className={`fi-sheet-dot${theft ? '' : ' fi-sheet-dot--amber'}`} aria-hidden="true" />
              </div>
              <div className="fi-sheet-head-right">
                <span className={`fi-sheet-chip${theft ? '' : ' fi-sheet-chip--amber'}`}>
                  {theft ? 'Possible theft' : 'Fuel event'}
                </span>
                <button className="fi-sheet-close" onClick={onClose} aria-label="Close">×</button>
              </div>
            </div>
          </>
        )}
        {asWindow && (
        <div
          className="fi-bar"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <span className="fi-bar-title">
            {theft ? 'Possible theft' : 'Fuel event'} · {plate ?? '-'}
          </span>
          {/* Pin is a window's control, not a sheet's: it buys you a usable
              map beside the incident, and on a phone there is no beside. */}
          {asWindow && (
            <button
              className={`fi-icon${pinned ? ' fi-icon--on' : ''}`}
              onClick={() => { const v = !pinned; onPinnedChange(v); if (!v) setPos(null); persist({ pinned: v, x: v ? pos?.x : undefined }); }}
              aria-pressed={pinned}
              aria-label={pinned ? 'Unpin' : 'Pin'}
              title={pinned ? 'Unpin, return to a dialog' : 'Pin, keep it open while you work'}
            ><IconPushPin on={pinned} /></button>
          )}
          <button
            className="fi-icon"
            onClick={() => { const v = !collapsed; setCollapsed(v); persist({ collapsed: v }); }}
            aria-expanded={!collapsed}
            aria-label={collapsed ? 'Expand' : 'Collapse'}
            title={collapsed ? 'Expand' : 'Collapse'}
          ><IconWinMin min={collapsed} /></button>
          <button className="fi-icon" onClick={onClose} aria-label="Close" title="Close"><IconWinClose /></button>
        </div>
        )}

        {!collapsed && (
          <>
            <div className={`fi-modal-body${vehicle && !sheet ? '' : ' fi-modal-body--solo'}`}>
              {/* TWO COLUMNS, not one long scroll. Stacked, this window was a
                  248px-wide column carrying a whole vehicle card AND a whole
                  incident report — four tiles two-up, a definition list and two
                  confidence bars, at the hover card's 8-10px type. Side by side
                  each half gets the width its content was designed for, and the
                  window stops being taller than the screen. One column again
                  below 720px, where there is no width to split. */}
              {/* THE INCIDENT FIRST ON A PHONE.

                  Side by side the order is spatial — both halves are on screen
                  at once and neither is "before" the other. Stacked it becomes
                  temporal, and card-then-detail put 453px of lorry (mileage,
                  payload, the two journey bars) above the finding the operator
                  opened a theft notification to read. Measured at 375x812: the
                  incident block began 467px down a 591px window, so the
                  severity chip was the last thing on the screen and every
                  number under it — the litres, the rate, the tank either side,
                  the record, both confidences — was below the fold.

                  Swapped HERE rather than with CSS `order`: the card carries a
                  real button (copy coordinates), and `order` would have left
                  the tab ring travelling up the screen while the eye travelled
                  down. This keeps DOM order, focus order and reading order the
                  same thing. `sheet` is the same 720px the body columns
                  collapse at — one breakpoint for the component. */}
              {/* NO VEHICLE CARD ON A PHONE. Even second, it was the lower
                  half of the sheet (status, engine, speed, mileage, fuel, load)
                  repeating what the unit's own panel shows, under an incident
                  the operator opened to decide. The sheet is the incident. */}
              {sheet ? detailCol : [cardCol, detailCol]}
            </div>
            <div className="fi-actions">
              <button className="fi-btn" onClick={onClose}>Close</button>
            </div>

          </>
        )}
      </div>
    </div>
  );
}

function LeftPanel({ onFocusVehicle, onClearVehicle, onFilter, activeFilter, onViewMap, showMobileMap }) {
  const { activeCompanyId, feedVehicleId, fleetTypes, trackedIds, inTransitOnly } = useAppFields("activeCompanyId", "feedVehicleId", "fleetTypes", "trackedIds", "inTransitOnly");
  const { activeCompany } = useCompanies();
  // Membership only — the context deliberately holds an array; see the note
  // there.
  const trackedSet = useMemo(() => new Set(trackedIds ?? []), [trackedIds]);
  /* One query, and it filters the FEED.
   *
   * It used to resolve a vehicle and fly the camera to it, which made the box
   * a second way to do what clicking a marker already does — while the list
   * directly beneath it, the one thing on this panel you cannot otherwise
   * search, stayed unfilterable. A hundred replayed items and no way to find
   * the refuel you were told about.
   *
   * Deferred rather than debounced: the work is a string match over items
   * already in memory, so there is nothing to wait for — React just keeps the
   * keystrokes responsive while a long list re-renders behind them. */
  const [search, setSearch] = useState("");
  const feedQuery = useDeferredValue(search.trim().toLowerCase());
  const feedListRef = useRef(null);

  /**
   * The feed pages as it is scrolled, rather than filtering by date.
   *
   * A date picker sat here briefly and was the wrong shape for the question:
   * an operator looking at a unit wants its history, and a control that makes
   * them guess which day something happened on is work, not an answer. The
   * whole history is one scroll instead, a page at a time — and unscoped, the
   * whole of today the same way.
   */
  const onFeedScroll = () => {
    const el = feedListRef.current;
    if (!el) return;
    // Two panels' worth of runway, so the next page is usually already there
    // by the time the operator reaches the bottom.
    if (el.scrollHeight - el.scrollTop - el.clientHeight < el.clientHeight) loadMoreFeed();
  };

  // Realtime status counts off the shared live fleet — recomputed on every SSE
  // flush, so the chips move the moment a vehicle starts speeding, parks, etc.
  // Status buckets: ok→OK, speeding→WARNING, theft→CRITICAL, parked→OFFLINE.
  // `feed` carries the REAL simulation activity stream (dispatches, arrivals,
  // offloads, overspeeding, fuel alerts) — SSE 'feed' events with server-side
  // history replay; it replaced the static mock feed.
  const { vehicles: liveVehicles, feed: liveFeed, orgId, error: statusCountsError, retry: retryStatusCounts } = useFleetLiveShared();

  // Clicking a unit ON THE MAP scopes the feed to it. Clicking a feed row does
  // NOT — that flies the camera to the vehicle and opens its panel while the
  // feed keeps showing the whole fleet, which is why this reads `feedVehicleId`
  // rather than `selectedVehicleId` (see AppContext).
  //
  // Only a scope that exists in the CURRENT fleet counts — the same guard the
  // right-hand panel uses, so one left over from another org (or a stale deep
  // link) shows the whole feed rather than an empty filtered one.
  //
  // Resolved from the live list on every render, because the scope is the
  // marker key (the PLATE) while feed items are keyed by the backend cuid.
  const selectedVehicle = feedVehicleId
    ? liveVehicles.find((v) => v.id === feedVehicleId) ?? null
    : null;
  // Live items for this unit merged over its history from the server — the
  // browser's live buffer is org-wide and capped, so on a 224-vehicle fleet it
  // holds almost nothing for any one truck. See hooks/useVehicleFeed.
  const {
    items:   feedItems,
    loading: feedLoading,
    loadingMore: feedLoadingMore,
    atEnd:   feedAtEnd,
    loadMore: loadMoreFeed,
    error:   feedError,
    retry:   retryVehicleFeed,
  } = useVehicleFeed(selectedVehicle, orgId, liveFeed);
  /**
   * Who is on each unit, for the lines that do not say.
   *
   * Rebuilt on each SSE flush — a few hundred entries, against a list that is
   * re-rendered by that same flush anyway — so a driver assigned mid-shift
   * shows up without a reload. See lib/feedDriver.
   */
  const feedDrivers = useMemo(() => driverIndex(liveVehicles), [liveVehicles]);

  /**
   * The feed, narrowed to the query.
   *
   * Matched against the item's own TEXT, which is the line an operator is
   * actually reading — it carries the plate, the driver, the place and the
   * event wording, so one field covers every way somebody would think to look
   * for a line they remember seeing.
   *
   * It filters what is LOADED, and that is worth being straight about: the
   * scoped feed pages as you scroll, so a match further back appears when the
   * list reaches it rather than the moment you type. The count below the box
   * says how much has been searched, so a thin result is legible as "few
   * matches so far" rather than "nothing happened".
   */
  const visibleFeedItems = useMemo(() => {
    if (!feedQuery) return feedItems;
    // Matched against the line AS RENDERED, not as stored. The stored text
    // still carries the provider's account prefix on every Mufindi row, and a
    // search for "MUFINDI" would have returned the whole feed against a word
    // that is nowhere on the screen.
    return feedItems.filter(i => feedPlainText(i.text, { plate: i.plate, driver: driverFor(feedDrivers, i) })
      .toLowerCase().includes(feedQuery));
  }, [feedItems, feedQuery, feedDrivers]);

  // Counted through the SAME predicate the map filters markers with, so every
  // chip's number equals what clicking it shows.
  //
  // OK is the CONNECTION count — every unit the provider reports connected —
  // not a leftover "nothing else applies" bucket. WARNING / CRITICAL / IDLING
  // are alert and activity states layered on top of a live connection, so they
  // are subsets of OK, and OK + OFFLINE is the whole fleet.
  //
  // EVERY map-visibility axis narrows this the same way it narrows the
  // markers — the funnel's types, the tracked selection and the in-transit
  // lens. It has to: the whole point of counting through the map's own
  // predicate is that a chip's number equals what clicking it shows, and a
  // filter that hid markers without moving the counts would break exactly that
  // promise — 597 ONLINE over a map holding nine excavators.
  const statusCounts = { ok: 0, idling: 0, warning: 0, critical: 0, offline: 0 };
  for (const v of liveVehicles) {
    if (!matchesMapFilters(v, { fleetTypes, trackedSet, inTransitOnly })) continue;
    for (const key of Object.keys(statusCounts)) {
      if (matchesFilter(v, key)) statusCounts[key] += 1;
    }
  }

  // Newest items render at the TOP — keep the view pinned there when a new
  // item lands, unless the user has scrolled down to read older history.
  useEffect(() => {
    const el = feedListRef.current;
    if (!el) return;
    if (el.scrollTop < 80) {
      el.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [feedItems]);

  // Switching the filter on or off replaces the list wholesale — jump to the
  // top rather than leaving the view parked at whatever offset the previous,
  // longer list had scrolled to.
  useEffect(() => {
    feedListRef.current?.scrollTo({ top: 0 });
  }, [selectedVehicle?.id]);

  const clearSearch = () => setSearch("");

  const handleChange = (e) => setSearch(e.target.value);

  const handleKey = (e) => {
    if (e.key === "Escape") clearSearch();
  };

  const handleClear = () => clearSearch();

  const shareToWhatsApp = (item) => {
    // Resolve the vehicle from the live fleet: server feed items carry the
    // vehicle cuid (item.vehicleId); fall back to the plate in the text for
    // old buffered items.
    const plateMatch = item.text.match(/([A-Z]{3} \d{3}[A-Z])/);
    const plate = plateMatch ? plateMatch[1] : null;
    const vehicle =
      (item.vehicleId && liveVehicles.find((v) => v.vehicleId === item.vehicleId)) ||
      (plate && liveVehicles.find((v) => v.id === plate)) ||
      null;

    const companyLabel = activeCompany
      ? `${activeCompany.name}${activeCompany.suffix ? " " + activeCompany.suffix : ""}`
      : null;
    const header = companyLabel
      ? `Fleet Tracking - ${companyLabel}`
      : "Fleet Tracking";

    // Dated, not just clocked. A shared update lands in a WhatsApp thread with
    // no feed around it, so "01:50" alone does not say which night.
    let message = `${header}\n${feedStamp(item)}\n${feedPlainText(item.text, { plate: item.plate, driver: driverFor(feedDrivers, item) })}`;

    // The vehicle's position AT THE EVENT — the item's own coordinates first
    // (the vehicle keeps moving after the event fires), falling back to the
    // vehicle's current live fix for old buffered items without coordinates.
    const lat = item.lat ?? vehicle?.lat;
    const lng = item.lng ?? vehicle?.lng;
    if (vehicle?.departure && vehicle?.destination) {
      message += `\n\nRoute: ${vehicle.departure} → ${vehicle.destination}`;
    }
    if (lat != null && lng != null) {
      message += `${vehicle?.departure ? "" : "\n"}\nLocation: https://maps.google.com/?q=${lat.toFixed(5)},${lng.toFixed(5)}`;
    }

    if (plate) {
      const link = `${window.location.origin}${window.location.pathname}?company=${encodeURIComponent(activeCompanyId)}&vehicle=${encodeURIComponent(plate)}`;
      message += `\nTrack live: ${link}`;
    }

    const url = `https://wa.me/?text=${encodeURIComponent(message)}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  // The fleet size, NOT the sum of the buckets — the buckets overlap now that
  // OK counts every connected unit (a speeding vehicle is in both).
  //
  // Narrowed like every other chip: ALL UNITS is the head of the same row, so
  // leaving it at the full fleet while the rest dropped would make it the one
  // number on screen that disagreed with the map.
  const total = (fleetTypes?.length || trackedSet.size || inTransitOnly)
    ? liveVehicles.reduce((n, v) => (matchesMapFilters(v, { fleetTypes, trackedSet, inTransitOnly }) ? n + 1 : n), 0)
    : liveVehicles.length;

  // ONLINE and OFFLINE partition the fleet by CONNECTION; IDLING is the one
  // activity bucket surfaced as a chip. IN TRANSIT and PARKED are deliberately
  // NOT here — the partition still holds in the data (see vehicleActivity), it
  // simply is not all spent on chips. WARNING and CRITICAL are alerts and
  // OVERLAP the activity buckets: a speeding vehicle is in transit AND flagged.
  const FILTER_CELLS = [
    { key: "all",      label: "ALL UNITS", count: total,                  color: "var(--accent-info)" },
    { key: "ok",       label: "ONLINE",    count: statusCounts.ok,        color: "var(--accent-ok)" },
    { key: "idling",   label: "IDLING",    count: statusCounts.idling,    color: "var(--accent-idling)" },
    { key: "warning",  label: "WARNING",   count: statusCounts.warning,   color: "var(--accent-warn)" },
    { key: "critical", label: "CRITICAL",  count: statusCounts.critical,  color: "var(--accent-crit)" },
    { key: "offline",  label: "OFFLINE",   count: statusCounts.offline,   color: "var(--accent-idle)" },
  ];

  return (
    <div className="overlay-left">

      {statusCountsError ? (
        <LoadError label="Fleet status" onRetry={retryStatusCounts} />
      ) : (
        <div className="status-bar">
          {FILTER_CELLS.map(({ key, label, count, color }) => {
            const isActive = activeFilter === key;
            return (
              <div
                key={key}
                className={`status-cell ${key}${isActive ? " active" : ""}`}
                onClick={() => onFilter(key)}
                title={`Show ${label} vehicles only`}
              >
                <span className="status-count" style={{ color }}>{count}</span>
                <span className="status-label">{label}</span>
                {isActive && <span className="status-active-bar" style={{ background: color }} />}
              </div>
            );
          })}
        </div>
      )}

      <div className="search-card">
        <input
          className="search-input"
          placeholder="Filter the live feed…"
          aria-label="Filter the live feed"
          value={search}
          onChange={handleChange}
          onKeyDown={handleKey}
        />
        {search
          ? <button className="search-clear" onClick={handleClear} aria-label="Clear filter">✕</button>
          : <span className="search-icon-right">⌕</span>
        }
      </div>

      {!showMobileMap && (
        <button className="view-map-btn" onClick={onViewMap}>
          <span className="view-map-icon">🗺</span>
          View Units on Map
        </button>
      )}

      <ErrorBoundary label="Live feed">
        <div className={`feed-card${selectedVehicle ? " feed-card--scoped" : ""}`}>
          <div className="feed-heading">
            Live Feed
            <span className="feed-live-dot" aria-hidden="true" />
          </div>

          {/* Says how much of the feed you are looking at. Without it a
              filtered list is indistinguishable from a quiet fleet. */}
          {feedQuery && feedItems.length > 0 && (
            <div className="feed-scope">
              <span className="feed-scope-plate">{visibleFeedItems.length}</span>
              <span className="feed-scope-label">
                of {feedItems.length} loaded
              </span>
              <button
                type="button"
                className="feed-scope-clear"
                onClick={handleClear}
                title="Clear the filter"
              >
                Clear ✕
              </button>
            </div>
          )}

          {/* Says WHOSE feed this is, and gives the way back. Without it a
              filtered feed is indistinguishable from a quiet fleet. */}
          {selectedVehicle && (
            <>
              <div className="feed-scope">
                <span className="feed-scope-plate">{selectedVehicle.id}</span>
                <span className="feed-scope-label">only</span>
                <button
                  type="button"
                  className="feed-scope-clear"
                  onClick={() => onClearVehicle?.()}
                  title="Show activity for the whole fleet"
                >
                  All units ✕
                </button>
              </div>

            </>
          )}

          <div className="feed-list" ref={feedListRef} onScroll={onFeedScroll}>
            {/* The loading and error states belong to the HISTORY read, in
                whichever scope it is running: one unit's timeline, or the
                fleet's day. The live buffer has no states of its own — it is
                either carrying items or it is not. */}
            {feedError && feedItems.length === 0 ? (
              <LoadError
                label={selectedVehicle ? `${selectedVehicle.id} history` : "Today's activity"}
                onRetry={retryVehicleFeed}
              />
            ) : feedLoading && feedItems.length === 0 ? (
              <div className="feed-empty">
                {selectedVehicle ? `Loading ${selectedVehicle.id} history…` : "Loading today's activity…"}
              </div>
            ) : feedItems.length === 0 ? (
              <div className="feed-empty">
                {selectedVehicle
                  ? `No recorded activity for ${selectedVehicle.id}.`
                  : "Nothing logged yet today."}
              </div>
            ) : visibleFeedItems.length === 0 ? (
              /* Filtered to nothing — a different statement from a quiet fleet,
                 and it says how much was actually searched. The feed pages as
                 it scrolls, so "none of the 40 loaded" is the honest answer
                 rather than "no such activity". */
              <div className="feed-empty">
                Nothing matching “{search.trim()}” in the {feedItems.length} loaded
                {feedItems.length === 1 ? " update" : " updates"}.
                {!feedAtEnd && " Scroll for older activity."}
              </div>
            ) : visibleFeedItems.map((item) => (
              // Clicking the row focuses its vehicle on the map. Only rows that
              // actually carry a vehicleId are interactive — some feed entries
              // are org-level and have nothing to fly to.
              <div
                className={`feed-item${item.vehicleId ? " feed-item--focusable" : ""}`}
                key={item.id}
                role={item.vehicleId ? "button" : undefined}
                tabIndex={item.vehicleId ? 0 : undefined}
                title={item.vehicleId ? "Show this vehicle on the map" : undefined}
                onClick={item.vehicleId ? () => onFocusVehicle?.(item.vehicleId) : undefined}
                onKeyDown={item.vehicleId ? (e) => {
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onFocusVehicle?.(item.vehicleId); }
                } : undefined}
              >
                {/* Date over clock. The list mixes live events with a hundred
                    items of replayed history, so a bare "01:50" does not say
                    which night it belongs to. */}
                <span className="feed-time">
                  <span className="feed-date">{feedDate(item)}</span>
                  <span className="feed-clock">{feedClock(item)}</span>
                </span>
                <span className={`feed-icon-cell ${FEED_CLS[item.type]}`}>{FEED_ICO[item.type]}</span>
                <span className="feed-text">
                  <FeedText
                    text={item.text}
                    type={item.type}
                    plate={item.plate}
                    driver={driverFor(feedDrivers, item)}
                  />
                </span>
                <button
                  type="button"
                  className="feed-share-btn"
                  // Must not bubble — the row itself now focuses the vehicle.
                  onClick={(e) => { e.stopPropagation(); shareToWhatsApp(item); }}
                  aria-label="Share this update on WhatsApp"
                  title="Share on WhatsApp"
                >
                  <svg viewBox="0 0 32 32" width="15" height="15" aria-hidden="true">
                    <circle cx="16" cy="16" r="16" fill="#25D366" />
                    <path
                      fill="#fff"
                      d="M21.6 10.3a7.6 7.6 0 0 0-11.9 9.1L8.4 24l4.7-1.3a7.6 7.6 0 0 0 10.9-6.8 7.5 7.5 0 0 0-2.4-5.6zm-5.5 11.6a6.3 6.3 0 0 1-3.2-.9l-.2-.1-2.4.6.6-2.3-.2-.2a6.3 6.3 0 1 1 5.4 2.9zm3.4-4.7c-.2-.1-1.1-.5-1.2-.6-.2-.1-.3-.1-.4.1l-.6.7c-.1.1-.2.1-.4.1a5 5 0 0 1-2.5-2.2c-.2-.3.2-.3.5-.9.1-.1 0-.2 0-.3l-.6-1.3c-.1-.3-.3-.3-.4-.3h-.4c-.1 0-.4 0-.6.3s-.9.8-.9 2 .9 2.3 1 2.5c.1.1 1.8 2.7 4.3 3.8.6.3 1.1.4 1.4.5.6.2 1.2.2 1.6.1.5-.1 1.1-.5 1.3-.9.2-.4.2-.8.1-.9-.1-.1-.2-.2-.4-.3z"
                    />
                  </svg>
                </button>
              </div>
            ))}

            {/* The foot of the history. Says which of the three states the
                bottom of the list is in — still fetching, genuinely the end,
                or a page away — because a list that simply stops gives an
                operator no way to tell "that is all of it" from "it has not
                loaded yet". Both scopes have an end to reach now: the store's
                oldest record for a unit, and midnight for the fleet. */}
            {feedItems.length > 0 && (
              <div className="feed-more">
                {feedLoadingMore
                  ? "Loading more…"
                  : feedAtEnd
                  ? selectedVehicle
                    ? "That is everything on record."
                    : "That is everything logged today."
                  : (
                    <button type="button" className="feed-more-btn" onClick={loadMoreFeed}>
                      Load older
                    </button>
                  )}
              </div>
            )}
          </div>
        </div>
      </ErrorBoundary>

    </div>
  );
}

function FleetOverviewPanel() {
  const activeCompanyId = useAppSelector((a) => a.activeCompanyId);
  const { activeCompany } = useCompanies();

  const hqVehicle = activeCompany
    ? {
        id: `hq-${activeCompany.id}`,
        location: activeCompany.hqLocation,
        lat: activeCompany.hqLat,
        lng: activeCompany.hqLng,
      }
    : null;

  return (
    <div className="overlay-right">
      <ErrorBoundary label="Fleet traffic">
        <FleetTrafficCard />
      </ErrorBoundary>

      {hqVehicle && (
        <ErrorBoundary label="Weather">
          <WeatherCard vehicle={hqVehicle} />
        </ErrorBoundary>
      )}

      <ErrorBoundary label="Fleet maintenance">
        <FleetMaintenanceCard />
      </ErrorBoundary>

      <ErrorBoundary label="Fleet AI insight">
        <FleetAIInsightCard companyId={activeCompanyId} />
      </ErrorBoundary>

      <ErrorBoundary label="Fleet cargo">
        <FleetCargoCard companyId={activeCompanyId} />
      </ErrorBoundary>
    </div>
  );
}

const TYPE_LABELS = { TRACTOR: "Tractor", TRUCK: "Truck", LORRY: "Lorry", SALOON: "Saloon", "BELL LOADER": "Bell Loader", "LORRY & TRAILER": "Lorry & Trailer", CANTER: "Canter", PICKUP: "Pickup" };

/**
 * Wall-clock HH:MM in the viewer's timezone, with a day offset when the moment
 * is not on the same calendar day as `relativeTo`.
 *
 * The offset is not decoration. A round trip to Nyaondo takes about nineteen
 * hours by this fleet's own completed runs, so the return time is routinely the
 * NEXT day — and rendered bare it sits under the departure looking like an
 * earlier, already-past time. Days are counted on local midnights rather than
 * by dividing the gap by 24 h, so "23:41 → 00:10" is +1d, which is what a
 * person reading a clock means by tomorrow.
 */
function fmtClock(ms, relativeTo) {
  if (ms == null || Number.isNaN(ms)) return "-";
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (relativeTo == null) return hhmm;

  const base = new Date(relativeTo);
  if (Number.isNaN(base.getTime())) return hhmm;
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(base)) / 86_400_000);
  if (days === 0) return hhmm;
  return `${hhmm} ${days > 0 ? "+" : "−"}${Math.abs(days)}d`;
}

function VehicleDetailPanel({ selectedVehicleId }) {
  const { vehicles: liveVehicles, orgId, error: fleetError, retry: fleetRetry } = useFleetLiveShared();

  const v = liveVehicles.find((x) => x.id === selectedVehicleId) ?? null;

  // Named place for the driver card's 📍 line — resolved via the backend's
  // cached reverse geocoder; raw coordinates remain the fallback while it
  // loads (or when no named place is near).
  const placeName = usePlaceName(v?.lat, v?.lng);

  if (fleetError && !v) {
    return (
      <div className="overlay-right">
        <LoadError label="Vehicle details" onRetry={fleetRetry} fullSection />
      </div>
    );
  }
  if (!v) return <div className="overlay-right" />;

  // Specific equipment name where the unit's code gives one — "Excavator"
  // rather than the "Plant" its class says. Feeds the driver card's role and
  // the cargo card's grade, so both read the same as the hover card's badge.
  const typeLabel = equipmentLabel(v) ?? TYPE_LABELS[v.vehicleType] ?? v.vehicleType;

  // Driver stat card — live driver, duty status and persisted rating. Duty
  // comes from the shared helper, not from engine+speed here: this panel and
  // the hover card used to compute it independently and could disagree with
  // each other and with the marker. See driverDutyStatus in lib/vehicleMap.
  const driverStatus = driverDutyStatus(v);
  const asset = {
    name:   v.driver,
    status: driverStatus,
    siteId: v.id,
    role:   `${typeLabel} Driver`,
    farm:   `📍 ${placeName ?? v.location}`,
    rating: v.driverRatingScore ?? 5,
  };

  // Active trip — the open dispatch, as a round trip out of the yard and back.
  //
  // Recomputed from the LIVE position on every render: the server works the
  // geometry out from the snapshot's fix, which is up to a warm-cache sweep
  // old, and the SSE stream moves the vehicle without re-sending the trip. See
  // lib/tripProgress.
  const trip = liveTrip(v.trip, v.lat, v.lng);

  // The Active Trip view is for units actually OUT on a run.
  //
  // An open dispatch row is not the same thing: of the 46 Sukari vehicles
  // carrying one, 12 are still standing in the yard (dispatch time is when the
  // paperwork was raised, not when the wheels turned) and 22 have not reported
  // at all since it was raised. Neither is in transit, and drawing a trip for
  // them would assert a journey nobody can evidence.
  //
  // The gate is "has it left the yard on THIS run" rather than isInTransit()
  // directly, because that helper means moving RIGHT NOW — a truck loading
  // cane at Nyaondo is stationary for an hour and is still very much on its
  // trip, and the card must not blink out every time it stops.
  const onTrip = trip != null && trip.leg !== "at-yard" && trip.leg !== "no-fix";
  // What to say when there is a dispatch but no journey to draw yet.
  const pending = trip && !onTrip
    ? {
        destination: trip.destination,
        driver:      trip.driverName,
        reason:      trip.leg === "no-fix"
          ? "no position reported since dispatch"
          : "not yet left the yard",
      }
    : null;

  const delivery = onTrip
    ? {
        leg:        trip.leg,
        percent:    trip.percent,
        status:     trip.status,
        // The yard's name is the organisation's own — the provider records a
        // destination for a dispatch and never an origin.
        from:       trip.yardName ?? "Yard",
        to:         trip.destination ?? "Destination not recorded",
        driver:     trip.driverName,
        // Relative to the DEPARTURE, not to today. A round trip to Nyaondo
        // takes about nineteen hours by this fleet's own history, so a bare
        // "18:53" for the return sat above a "23:41" departure and read as
        // having already happened. The suffix is the whole difference between
        // "due back at 18:53" and "due back at 18:53 tomorrow".
        departedAt: fmtClock(Date.parse(trip.departedAt)),
        arrivedAt:  fmtClock(Date.parse(trip.arrivedAt), trip.departedAt),
        dueBack:    fmtClock(Date.parse(trip.dueBackAt), trip.departedAt),
        // Whether it HAS arrived, kept apart from the time string — that string
        // is "—" when it has not, which is truthy and would tick the stop green.
        arrived:    trip.arrivedAt != null,
        dueBackSource: trip.dueBackSource,
        totalKm:    roundTripKm(trip),
        // Ground actually driven since local midnight, straight from the
        // server — the SAME field the vehicle brief reads, so the two surfaces
        // cannot quote different distances for the same truck.
        distanceTodayKm: trip.distanceTodayKm ?? null,
        // A destination measured from few trips, or from trips that scattered,
        // is a rough point and the card says so rather than implying survey
        // accuracy. See the server's sync-destinations.
        destinationPlaced: trip.destinationSamples >= 5 && trip.destinationSpreadM <= 500,
        // Live-traffic routing from here to the end it is heading for — see
        // DeliveryCard TrafficEta. The map's Traffic layer draws the same
        // route (one shared query per unit).
        traffic: {
          vehicleId:  v.id,
          trip,
          lat:        v.lat,
          lng:        v.lng,
          speedKmh:   Number.isFinite(v.speed) ? v.speed : null,
          travelMode: travelModeFor(v.vehicleType),
          fresh:      positionFresh(v),
        },
      }
    : null;

  // Current cargo — what's on the bed right now.
  //
  // For a sales run the weight is the sales office's DECLARED tonnage, carried
  // on the open dispatch: this fleet has no load cells, so the telemetry
  // channel behind this card is null on every real vehicle and it read
  // "Empty · 0 TONNES" until the declared figure had somewhere to come from.
  const storage = {
    commodity: v.cargo,
    grade:     typeLabel,
    stored:    v.weight,
    bags:      v.cargoBags ?? null,
  };

  // Sensor readings, shared by the telemetry and status blocks below.
  const readings = vehicleReadings(v);

  // Asset telemetry — live SSE vitals.
  //
  // Engine temperature and oil level were here and always read "—": the Wialon
  // position payload carries neither channel, so the adapter nulls both on
  // every frame. Replaced by the unit's own mileage and engine-hours counters,
  // which are real (and are NOT gated on the engine being on — a counter holds
  // its value while the vehicle is parked).
  const telemetry = {
    mileageKm:   readings.odometerKm,
    fuelLevel:   v.fuelLevel,
    engineHours: readings.engineHours,
    // The tracker's CONNECTION, not "does it have coordinates". A unit that
    // dropped off the network keeps its last known fix, so the old
    // `lat != null` test reported "Active" for every offline vehicle that had
    // ever reported a position — which is nearly all of them.
    gpsStatus:   v.online ? "Active" : "No signal",
  };

  // Not a service grade. This block used to report a status ("Due Soon"), a
  // "1,240 km to service" and a health %, plus per-item brake wear on
  // 20,000/40,000 km cycles — all computed from invented intervals against a
  // reset point that is 0 in production. See lib/vehicleReadings.
  const maintenance = {
    status: readings.isReporting ? "Reporting" : "Silent",
    dueIn: formatSince(readings.lastReportedAt),
    item: readings.engineHours != null ? `${formatHours(readings.engineHours)} engine` : NO_READING,
    odometer: formatKm(readings.odometerKm),
    pct: null,
    // No brake wear here any more. There is no brake sensor on these units and
    // no service records to date it from, so any figure would be invented.
    brakes: [],
  };

  const routeVehicle = {
    id: v.id,
    location: v.location,
    lat: v.lat,
    lng: v.lng,
    departure: v.departure,
    destination: v.destination,
  };

  return (
    <div className="overlay-right">
      {/* The incident banner used to sit HERE, above everything — the panel's
          first row, spent on a unit's fuel event before the unit had been
          described. It has moved to the fuel-alerts menu in the map's control
          rail (FuelAlertsMenu), which does the same job for the WHOLE fleet at
          once and costs no panel space at all. The window it opened still
          exists and opens from there. */}

      {/* First, because it is the summary the rest of the panel breaks down:
          who is driving, since when, distance, fuel, where it was sent and
          when it is due back. */}
      <ErrorBoundary label="Vehicle brief">
        {/* The live trip distance rides along so the brief re-reads when the
            figure on the Delivery card below it changes — the two must never
            quote different kilometres for the same truck on the same screen. */}
        <VehicleBriefCard
          orgId={orgId}
          vehicleId={v.vehicleId}
          plate={v.id}
          distanceTodayKm={trip?.distanceTodayKm ?? null}
        />
      </ErrorBoundary>

      <ErrorBoundary label="Asset details">
        <AssetCard asset={asset} />
      </ErrorBoundary>

      <ErrorBoundary label="Delivery">
        <DeliveryCard delivery={delivery} pending={pending} />
      </ErrorBoundary>

      <ErrorBoundary label="Storage">
        <StorageCard storage={storage} />
      </ErrorBoundary>

      <ErrorBoundary label="Telemetry">
        <TelemetryCard telemetry={telemetry} siteId={v.id} />
      </ErrorBoundary>

      {/* Road traffic on the run. Needs BOTH endpoints as coordinates, so it
          appears only for a dispatch whose destination the fleet has actually
          been measured going to. */}
      {trip?.destinationLat != null && (
        <ErrorBoundary label="Traffic">
          <TrafficCard vehicle={routeVehicle} />
        </ErrorBoundary>
      )}

      <ErrorBoundary label="Weather">
        <WeatherCard vehicle={routeVehicle} />
      </ErrorBoundary>

      <ErrorBoundary label="Maintenance">
        <MaintenanceCard maintenance={maintenance} />
      </ErrorBoundary>

      {/* The org-wide fleet brief used to sit here, purely because the server
          had no per-vehicle one — so it said exactly the same thing whichever
          truck you had open, which is worse than nothing on a panel about one
          vehicle. VehicleBriefCard at the top of this panel is that brief now.
          The fleet version still leads the FLEET overview panel, where it is
          about the right subject. */}
    </div>
  );
}

/**
 * The right-hand column, and the OWNER of the fuel incident window.
 *
 * The window's state used to live in `VehicleDetailPanel`, one level down,
 * which made its independence a claim rather than a fact: this component swaps
 * that panel for `FleetOverviewPanel` the moment the vehicle is deselected, so
 * the panel unmounted and took the window's state — open, pinned, position,
 * the held incident — with it. A window an operator had deliberately pinned so
 * it would stay in front of them vanished as soon as they clicked the map to
 * look at anything else, which is the opposite of what pinning is for.
 *
 * Owned HERE it survives both branches, and it survives the vehicle: the
 * window closes when the operator closes it, and at no other time.
 */
function RightPanel() {
  const { selectedVehicleId, incidentRequest } = useAppFields("selectedVehicleId", "incidentRequest");
  const { setWindowOpen } = useAppActions();
  const { vehicles } = useFleetLiveShared();
  const v = selectedVehicleId != null
    ? vehicles.find((x) => x.id === selectedVehicleId) ?? null
    : null;

  // Dismissals are per browser and survive a reload; see readDismissed.
  const [dismissed] = useState(readDismissed);
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [pinned, setPinned] = useState(() => !!readWindowState().pinned);

  /**
   * Tell the rest of the map a window is up, so the hover card stops competing
   * with it. Reported for BOTH modes: unpinned draws a backdrop that already
   * blocks hovering, but pinned deliberately leaves the map usable, and that is
   * exactly the case where a hover card would float over a window the operator
   * pinned so it would stop changing.
   *
   * Cleared on unmount as well as on close — the whole overlay unmounts on a
   * company switch, and a flag left true there would suppress hovering for the
   * rest of the session with no window on screen to explain why.
   */
  useEffect(() => {
    setWindowOpen(Boolean(incidentOpen));
    return () => setWindowOpen(false);
  }, [incidentOpen, setWindowOpen]);
  // The incident a pinned window is showing. Without holding a copy, selecting
  // another machine would swap the contents of a window the operator pinned
  // precisely so it would stop changing.
  const [held, setHeld] = useState(null);

  const liveIncident = v?.fuelIncident && !dismissed.has(v.fuelIncident.id) ? v.fuelIncident : null;
  const incident = pinned ? (held?.incident ?? liveIncident) : liveIncident;
  // Which alert's window is open, so FleetMap draws its route and drive
  // zones (IncidentInvestigation) — no separate investigation window.
  const { setOpenIncidentId } = useAppActions();
  const openIncidentId = incidentOpen && incident?.id ? incident.id : null;
  useEffect(() => {
    setOpenIncidentId(openIncidentId);
  }, [openIncidentId, setOpenIncidentId]);
  useEffect(() => () => setOpenIncidentId(null), [setOpenIncidentId]);
  const incidentPlate = pinned ? (held?.plate ?? v?.id) : v?.id;
  // The whole vehicle, because the window renders the real hover card. A
  // pinned window keeps the machine it was pinned on.
  const incidentVehicle = pinned ? (held?.vehicle ?? v) : v;

  /**
   * OPENS ONLY WHEN ASKED. Nothing here opens itself.
   *
   * This used to open the window the first time a vehicle with an incident was
   * selected — so clicking a red marker to see where it was put a dialog over
   * the map. Selecting a unit is a request to look at the unit, not a request
   * to be shown a report about it.
   *
   * The request now comes from the fuel-alerts menu (AppContext.requestIncident),
   * and carries a counter so asking twice for the same unit is twice.
   */
  const askedRef = useRef(0);
  useEffect(() => {
    if (!incidentRequest || incidentRequest.n === askedRef.current) return;
    askedRef.current = incidentRequest.n;
    if (incidentRequest.id === v?.id) setIncidentOpen(true);
  }, [incidentRequest, v?.id]);

  // An incident that closes — dismissed, or aged out of the server's 24-hour
  // window — takes its window with it. Nothing to read, nothing to show.
  useEffect(() => {
    if (!liveIncident && !pinned) setIncidentOpen(false);
  }, [liveIncident, pinned]);

  // Closing is closing: the window goes, the pin comes off, and the persisted
  // window state is cleared of it too — a close that left `pinned: true` in
  // localStorage brought the window back pinned on the next reload, which is
  // not what "close" means.
  // The feed and the incident window take turns (lib/sidePanels): the window
  // shares the map's owner, so it can sit beside that unit's card.
  useEffect(() => { if (incidentOpen) claimSidePanel("map"); }, [incidentOpen]);
  useEffect(() => onSidePanelClaim("map", () => { setIncidentOpen(false); setHeld(null); }), []);
  // …and with the map's other windows (lib/sidePanels claimMapWindow): opening
  // Arrivals, Units or Halted closes it. The Fuel alerts list stays, since a
  // row there is what opens this window.
  useEffect(() => { if (incidentOpen) claimMapWindow("incident"); }, [incidentOpen]);
  useEffect(() => onMapWindowClaim(["incident", "fuel"], () => { setIncidentOpen(false); setHeld(null); }), []);

  // Leaving the map for another page closes the window (appSlice tabChosen);
  // it is back only when an alert is opened again.
  const mapClearN = useAppSelector((a) => a.mapClearN);
  const clearedN = useRef(mapClearN);
  useEffect(() => {
    if (clearedN.current === mapClearN) return;
    clearedN.current = mapClearN;
    setIncidentOpen(false);
    setHeld(null);
  }, [mapClearN]);

  const closeIncident = () => {
    setIncidentOpen(false);
    setPinned(false);
    setHeld(null);
    writeWindowState({ ...readWindowState(), pinned: false });
  };

  return (
    <>
      {/* Rendered outside both panels so neither one's lifetime is the
          window's — and, since it is no longer portalled away, this is also
          where it PAINTS: inside the map's tab panel, which is what stops it
          following the operator onto Analytics. */}
      {incidentOpen && incident && (
        <ErrorBoundary label="Fuel incident">
          <FuelIncidentModal
            incident={incident}
            vehicle={incidentVehicle}
            plate={incidentPlate}
            pinned={pinned}
            onPinnedChange={(next) => {
              setPinned(next);
              // Take a copy on pin so the window keeps showing THIS incident,
              // and release it on unpin so it tracks the selection again.
              setHeld(next ? { incident, plate: incidentPlate, vehicle: incidentVehicle } : null);
            }}
            onClose={closeIncident}
          />
        </ErrorBoundary>
      )}

      {v
        ? <VehicleDetailPanel selectedVehicleId={selectedVehicleId} />
        : <FleetOverviewPanel />}
    </>
  );
}

/**
 * The fuel incident window on its own, for the new layout.
 *
 * RightPanel above owned it in the old layout, but that panel is not rendered
 * any more (see MapOverlay below), so asking for an incident from the
 * fuel-alerts menu went nowhere. This is the same window with the same
 * pin/dismiss rules. The difference is what it follows: the unit that was ASKED
 * for, not the selected one. Opening an incident no longer selects the unit,
 * so the vehicle side panel stays shut and only opens from a click on the
 * unit's marker.
 */
export function FuelIncidentHost() {
  const incidentRequest = useAppSelector((a) => a.incidentRequest);
  const { setWindowOpen } = useAppActions();
  const { vehicles, orgId } = useFleetLiveShared();
  // Every open alert's window and side panel, read before they are opened, so
  // both open complete — see lib/fuelPrefetch.
  usePrefetchFuelAlerts(orgId, vehicles);

  const [subjectId, setSubjectId] = useState(null);
  const dismissed = useDismissedIncidents();
  const [incidentOpen, setIncidentOpen] = useState(false);
  const [pinned, setPinned] = useState(() => !!readWindowState().pinned);
  const [held, setHeld] = useState(null);

  useEffect(() => {
    setWindowOpen(Boolean(incidentOpen));
    return () => setWindowOpen(false);
  }, [incidentOpen, setWindowOpen]);

  const v = subjectId != null
    ? vehicles.find((x) => x.id === subjectId) ?? vehicles.find((x) => x.vehicleId === subjectId) ?? null
    : null;
  const liveIncident = v?.fuelIncident && !dismissed.has(v.fuelIncident.id) ? v.fuelIncident : null;
  const incident = pinned ? (held?.incident ?? liveIncident) : liveIncident;
  // Which alert's window is open, so FleetMap draws its route and drive
  // zones (IncidentInvestigation) — no separate investigation window.
  const { setOpenIncidentId } = useAppActions();
  const openIncidentId = incidentOpen && incident?.id ? incident.id : null;
  useEffect(() => {
    setOpenIncidentId(openIncidentId);
  }, [openIncidentId, setOpenIncidentId]);
  useEffect(() => () => setOpenIncidentId(null), [setOpenIncidentId]);
  const incidentPlate = pinned ? (held?.plate ?? v?.id) : v?.id;
  const incidentVehicle = pinned ? (held?.vehicle ?? v) : v;

  // Counted, so asking twice for the same unit opens it twice. An explicit ask
  // for another unit replaces what a pinned window was holding: pinning stops
  // the window changing by itself, and this change was asked for.
  const askedRef = useRef(0);
  useEffect(() => {
    if (!incidentRequest || incidentRequest.n === askedRef.current) return;
    askedRef.current = incidentRequest.n;
    setSubjectId(incidentRequest.id);
    setHeld(null);
    setIncidentOpen(true);
  }, [incidentRequest]);

  // Keep a pinned window's copy up to date while its unit still has the
  // incident, so a live refresh isn't lost just because the window is pinned.
  useEffect(() => {
    if (pinned && liveIncident) setHeld({ incident: liveIncident, plate: v?.id, vehicle: v });
  }, [pinned, liveIncident, v]);

  useEffect(() => {
    if (!liveIncident && !pinned) setIncidentOpen(false);
  }, [liveIncident, pinned]);

  // Escalated or de-escalated (here or by someone else): the alert is off the
  // dashboard, so its window goes too, pinned or not.
  const heldId = held?.incident?.id;
  useEffect(() => {
    if (heldId && dismissed.has(heldId)) {
      setIncidentOpen(false);
      setHeld(null);
    }
  }, [heldId, dismissed]);

  // The feed and the incident window take turns (lib/sidePanels): the window
  // shares the map's owner, so it can sit beside that unit's card.
  useEffect(() => { if (incidentOpen) claimSidePanel("map"); }, [incidentOpen]);
  useEffect(() => onSidePanelClaim("map", () => { setIncidentOpen(false); setHeld(null); }), []);
  // …and with the map's other windows (lib/sidePanels claimMapWindow): opening
  // Arrivals, Units or Halted closes it. The Fuel alerts list stays, since a
  // row there is what opens this window.
  useEffect(() => { if (incidentOpen) claimMapWindow("incident"); }, [incidentOpen]);
  useEffect(() => onMapWindowClaim(["incident", "fuel"], () => { setIncidentOpen(false); setHeld(null); }), []);

  // Leaving the map for another page closes the window (appSlice tabChosen);
  // it is back only when an alert is opened again.
  const mapClearN = useAppSelector((a) => a.mapClearN);
  const clearedN = useRef(mapClearN);
  useEffect(() => {
    if (clearedN.current === mapClearN) return;
    clearedN.current = mapClearN;
    setIncidentOpen(false);
    setHeld(null);
  }, [mapClearN]);

  const closeIncident = () => {
    setIncidentOpen(false);
    setPinned(false);
    setHeld(null);
    writeWindowState({ ...readWindowState(), pinned: false });
  };

  if (!incidentOpen || !incident) return null;
  return (
    <ErrorBoundary label="Fuel incident">
      <FuelIncidentModal
        incident={incident}
        vehicle={incidentVehicle}
        plate={incidentPlate}
        pinned={pinned}
        onPinnedChange={(next) => {
          setPinned(next);
          setHeld(next ? { incident, plate: incidentPlate, vehicle: incidentVehicle } : null);
        }}
        onClose={closeIncident}
      />
    </ErrorBoundary>
  );
}

/**
 * MEMOISED, because this is the expensive half of the map screen and almost
 * nothing FleetMap does concerns it.
 *
 * Both rails, the live feed list and every card in the vehicle panel re-rendered
 * whenever FleetMap did — which, while a playback was running, was sixty times a
 * second. That cost is gone (the cursor is a subscription now, see
 * useRoutePlayback), but FleetMap still re-renders on every hover, zoom and SSE
 * frame, and none of those change anything here.
 *
 * Every prop below is stable: five useCallbacks, two primitives, and
 * `onViewMap`, which had to be lifted out of an inline arrow for this to work at
 * all. What this panel actually reads — the fleet, the selection, the theme —
 * comes from context, which memo does not block.
 */
function MapOverlay({ onFocusVehicle, onClearVehicle, onFilter, activeFilter, onViewMap, showMobileMap }) {
  // NEW UI: left and right overlay panels replaced by SidePanel + LiveFeed.
  // Remove this return null to restore old panels.
  return null;
  return (
    <>
      <LeftPanel
        onFocusVehicle={onFocusVehicle}
        onClearVehicle={onClearVehicle}
        onFilter={onFilter}
        activeFilter={activeFilter}
        onViewMap={onViewMap}
        showMobileMap={showMobileMap}
      />
      <RightPanel />
    </>
  );
}

export default memo(MapOverlay);
