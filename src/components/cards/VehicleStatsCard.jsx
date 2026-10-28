// Rich vehicle vitals card — the single source for BOTH the map marker hover
// tooltip (FleetMap) and the left-panel search result (MapOverlay), so the two
// always show identical stats. Layout/positioning is the caller's job; this
// renders only the card content.
//
// Most vt-* styles live in FleetMap.scss for historical reasons; the ones added
// with this component live in VehicleStatsCard.scss, which MUST be imported
// here. It was not, for a long time, so its rules never shipped and the
// elements they targeted fell back to inherited values — 16px black text on a
// dark card.

import { useEffect, useRef, useState } from "react";
import "./VehicleStatsCard.scss";
import { usePlaceName } from "../../hooks/usePlaceName";
import { copyText, formatCoords } from "../../lib/copyText";
import { vehicleActivity, isInTransit, isOnline, equipmentLabel, carriesCargo, maxPayloadTonnes, ACTIVITY_LABELS, ACTIVITY_COLORS, ONLINE_COLORS } from "../../lib/vehicleMap";
import { liveTrip, roundTripKm, LEG_LABEL } from "../../lib/tripProgress";
import { useFleetLiveShared } from "../../context/FleetLiveContext";
import { useJourneySoFar } from "../../hooks/useJourneySoFar";
import { burnAgainst, overWords } from "../../lib/vehicleDay";
import { displayPlate } from "../../lib/plate";

const STATUS_COLORS = {
  ok:       ONLINE_COLORS.transit,
  speeding: "#f59e0b",
  theft:    "#ef4444",
  // OFFLINE. The one slate left on this card, now that the online states have
  // all moved into the green — see ONLINE_COLORS.
  parked:   "#94a3b8",
  // Was MISSING, so an idling vehicle fell back to the healthy green — the bug
  // that made the old idling badge render green. It is a green again now, but
  // a DIFFERENT one, which is the distinction that was missing in the first
  // place.
  idling:   ONLINE_COLORS.idling,
};

// Provider classes → the words an operator uses. Anything unmapped falls back
// to the raw class, so a new type still shows rather than disappearing.
const VEHICLE_TYPE_LABELS = {
  BUS: 'Bus', TRACTOR: 'Tractor', TRUCK: 'Truck',
  LORRY: 'Lorry', SALOON: 'Saloon', PLANT: 'Plant',
  COMPANY_VEHICLE: 'Company vehicle',
};

/**
 * The state badge — what the vehicle is DOING or what is wrong with it.
 *
 * Connection is NOT in here. It used to be: the badge showed "Online" for
 * status 'ok' and "Parked / In Depot" for 'parked', so connection and activity
 * shared one slot and only one of them could ever be visible. Once `idling`
 * was added as a status this went from confusing to broken — there was no
 * entry for it, so an idling unit rendered a BLANK badge and lost its
 * connection indication entirely. Connection now has its own chip beside this
 * one, and the two are independent, as they are in the data.
 *
 * Deliberately partial: a healthy online vehicle gets NO badge, because the
 * activity chip below already says In Transit / Idling / Resting and a badge
 * reading "Online" beside a chip reading "ONLINE" is noise.
 *
 * IN TRANSIT IS NOT HERE either. It was, above a chip reading "Driving" — the
 * same fact in two places, in two vocabularies. The chip now carries it (and
 * the rippling dot that went with it), so the vehicle's activity is stated
 * exactly once.
 *
 * IDLING IS NOT HERE, for the same reason. The cyan activity chip states it, and
 * the run row underneath states it WITH a duration ("Idling for 2h 14m"), so a
 * badge repeating the bare word was a third copy that added nothing. It also
 * rendered GREEN — STATUS_COLORS has no 'idling' entry, so it fell back to the
 * healthy colour, which is the opposite of what idling means.
 *
 * Only alerts belong here: states that are NOT visible anywhere else on the
 * card and that an operator has to act on.
 */
const STATE_LABELS = {
  speeding: "Speeding",
  theft:    "Fuel Theft Alert",
};

export function Bar({ pct, color }) {
  return (
    <div className="vt-bar-track">
      <div className="vt-bar-fill" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
    </div>
  );
}

/**
 * One line of the vitals ledger.
 *
 * `valColor` / `subColor` are for a figure whose COLOUR CARRIES MEANING — a
 * speed over its limit, a tank under 15 %. A reading that means nothing in
 * particular passes neither, and the stylesheet's own `--text-primary` /
 * `--text-secondary` apply: those follow the theme, and an inline style does
 * not. That is not a nicety. Mileage and engine hours used to arrive here as
 * a literal `#e6edf3`, which measures 1.18 against a white card — the figures
 * were not faint in light mode, they were invisible, and no `.app--light`
 * rule could have reached them past the inline style.
 *
 * When a colour IS passed it must be a token — `var(--accent-warn)`, not the
 * hex behind it, for the same reason.
 */
export function Tile({ label, value, unit, sub, subColor, valColor }) {
  return (
    <div className="vt-tile">
      <span className="vt-tile-lbl">{label}</span>
      <span className="vt-tile-fig">
        <span className="vt-tile-val" style={valColor ? { color: valColor } : {}}>
          {value}{unit && <span className="vt-tile-unit">{unit}</span>}
        </span>
        {sub && <span className="vt-tile-sub" style={subColor ? { color: subColor } : {}}>{sub}</span>}
      </span>
    </div>
  );
}

/**
 * Wall-clock HH:MM, with a day offset when the moment falls on a different
 * local day from `relativeTo`.
 *
 * The offset matters here: this fleet's round trips run to about nineteen
 * hours, so a due-back time is routinely the next day and a bare "11:04" under
 * a "23:16" departure reads as already past. Counted on local midnights, so
 * 23:16 → 01:23 is +1d the way a person means it.
 */
function fmtClock(ms, relativeTo) {
  if (ms == null || Number.isNaN(ms)) return null;
  const d = new Date(ms);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (relativeTo == null) return hhmm;
  const base = new Date(relativeTo);
  if (Number.isNaN(base.getTime())) return hhmm;
  const midnight = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(d) - midnight(base)) / 86_400_000);
  return days === 0 ? hhmm : `${hhmm} ${days > 0 ? "+" : "−"}${Math.abs(days)}d`;
}

// "1d 3h" / "2h 14m" / "34m" / "under a minute" — how long a parked vehicle
// has been stationary (now − last moving telemetry ping).
function fmtDuration(ms) {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "under a minute";
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** The over-limit mark on the speed tile. Drawn for the same reason the run
 *  glyphs are: the character it replaces renders as a yellow-and-black emoji
 *  on Windows and a thin monochrome outline elsewhere, and neither of them
 *  took the amber the label beside it is already set in. */
function WarnGlyph() {
  return (
    <svg
      className="vt-warn-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 4.5 21 19.5H3z" />
      <path d="M12 10v4M12 17h.01" />
    </svg>
  );
}

/**
 * The run row's icon, drawn.
 *
 * These were emoji — a motorway, a parking P, a stopwatch. Emoji as an
 * interface icon is a tell for a reason that is not only taste: each one is a
 * different artist's work at a different optical weight, none of them inherits
 * the row's colour, and the same three characters render as three unrelated
 * pictures across Windows, macOS and Android. The stopwatch in particular
 * arrived as a colour bitmap on one platform and a thin outline on another.
 *
 * Stroke-only paths on a 24-unit grid in `currentColor`, which is the same
 * vocabulary the map's site-plan markers use (see SITE_GLYPH in FleetMap) — so
 * a fleet drawn on the map and a fleet described in a card are drawn by the
 * same hand. `currentColor` is what makes them track the row's state tint and
 * the light theme without a second set of assets.
 */
function RunGlyph({ kind }) {
  const path = {
    // A road narrowing to the horizon, with its centre line dashed.
    road:  <><path d="M7 20 9.5 4M17 20 14.5 4" /><path d="M12 6v2M12 11v2M12 16v2" /></>,
    // A vehicle standing with its engine turning over: the body, and the
    // exhaust above it. Not the parking P, which says the opposite of idling.
    idle:  <><path d="M4 17h12M5.5 17l1.2-3.6A1.7 1.7 0 0 1 8.3 12h4.4a1.7 1.7 0 0 1 1.6 1.4L15.5 17M7 17v1.8M13 17v1.8" />
             <path d="M17.5 9.5c1.6-.6 1.6-2.4 3-3" /></>,
    // A clock, which is the one thing on the card measuring elapsed time.
    clock: <><circle cx="12" cy="12" r="7.5" /><path d="M12 7.6V12l3 1.8" /></>,
  }[kind] ?? null;

  return (
    <svg
      className="vt-run-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {path}
    </svg>
  );
}

/**
 * How long this vehicle has been in its current state, and since when.
 *
 * Two states, deliberately styled differently because they mean opposite
 * things operationally: a truck that has been ON THE ROAD for six hours is a
 * driver-hours question, and one that has been RESTING for six hours is a
 * utilisation question.
 *
 * Prefers the server's movement tracker (lib/movement-state), which knows when
 * the current run actually began and tolerates a short stop at a junction
 * without ending a journey. Falls back to `lastMovedAtMs` — the last ping that
 * showed movement — for a vehicle parked since before the server started,
 * which is the only thing the old version of this row ever used and the reason
 * it rendered nothing for 95 of 224 vehicles.
 *
 * `exact: false` means the run was already under way when we started watching
 * (a restart mid-journey), so the duration is reported as a lower bound rather
 * than overstated.
 */
function RunRow({ vehicle }) {
  const m = vehicle.movement;

  const sinceMs = m?.since ? Date.parse(m.since)
                : vehicle.lastMovedAtMs != null ? vehicle.lastMovedAtMs
                : null;
  if (sinceMs == null || !Number.isFinite(sinceMs)) return null;

  // Trust the tracker's own verdict when we have it; otherwise the fallback
  // only ever describes a stopped vehicle.
  const state    = m?.state ?? "resting";
  const approx   = m ? m.exact === false : false;
  const duration = fmtDuration(Math.max(0, Date.now() - sinceMs));

  // `idling` is only ever produced when the unit reports a real ignition line
  // (Wialon `engine operation` → io_239). Where it does not, the server sends
  // 'resting' rather than guessing — engine-on would otherwise just be a
  // restatement of "moving". See lib/movement-state.
  const RUN = {
    moving:  { cls: "vt-run-row--transit", glyph: "road",  label: "On the road for " },
    idling:  { cls: "vt-run-row--idle",    glyph: "idle",  label: "Idling for " },
    resting: { cls: "vt-run-row--rest",    glyph: "clock", label: "Resting for " },
  }[state] ?? { cls: "vt-run-row--rest", glyph: "clock", label: "Resting for " };

  return (
    <div className={`vt-run-row ${RUN.cls}`}>
      <RunGlyph kind={RUN.glyph} />
      <span className="vt-run-text">
        {RUN.label}
        <b>{approx ? "≥ " : ""}{duration}</b>
        <span className="vt-run-since"> · since {fmtClock(sinceMs)}</span>
      </span>
    </div>
  );
}

/* The assigned-geofence row lived here.
 *
 * It reported which keep-out zones a unit was inside, and it goes with the
 * fences themselves: every geofence we hold came from the tracking provider,
 * none of them is drawn on the map any more, and a hover card is the wrong
 * place to be the last surviving view of a layer the product no longer shows.
 * It was also the only row here that was usually absent — the clear case
 * rendered nothing — so the card changed height with the data, which is what
 * makes a card feel unstable under a pointer that is already on it.
 *
 * The containment test itself is NOT gone. `zoneTestFor` in FleetMap still
 * computes it, and it still decides whether a stopped unit raises the
 * stranded-stop flag — which is the alarm that actually needed it.
 */

/**
 * `withDay` is for a card somebody clicked (the pinned map card, the fuel
 * incident window): it reads the unit's day for the start row. A hover card
 * leaves it off and shows the start only where the day is already held.
 */
export default function VehicleStatsCard({ vehicle, withDay = false, onAlertClick }) {
  const color = STATUS_COLORS[vehicle.status] ?? STATUS_COLORS.ok;

  // ── Derived colour values (same thresholds as fleetdash) ──────────────────
  const engineOn    = vehicle.engine === "on";
  const OFF_COLOR   = "var(--accent-off)"; // uniform "sensor inactive" colour
  const engineColor = engineOn ? "#22c55e" : "#94a3b8";

  const speedColor = !engineOn ? OFF_COLOR
                   : vehicle.speed > 100                        ? "#ef4444"
                   : vehicle.speed > (vehicle.speedLimit ?? 80) ? "#f59e0b"
                   : "#22c55e";

  // Engine-temperature and oil-level grading used to be computed here for two
  // of the vitals tiles. The trackers report neither channel — the Wialon
  // adapter nulls both on every frame — so those tiles now show MILEAGE and
  // ENGINE HRS, which are real counters, and this grading had no consumer left.

  const fuel      = vehicle.fuelLevel ?? 0;
  const fuelColor = fuel < 15 ? "var(--accent-crit)"
                  : fuel < 40 ? "var(--accent-warn)"
                  : "var(--accent-ok)";

  // Generators, motorbikes, plant and light vehicles never carry a load, so
  // they get no payload row at all rather than "No load expected 0 / 30 t".
  const hasPayload = carriesCargo(vehicle);
  const maxPay    = vehicle.maxPayload ?? maxPayloadTonnes(vehicle.vehicleType);
  const loadPct   = maxPay > 0 ? Math.round((vehicle.weight / maxPay) * 100) : 0;
  /* A FULL TRUCK IS THE GOAL, not an alarm.
     This graded the load like the fuel bar above it — red past 95%, amber
     past 80 — which reads the wrong way round: a unit signed out with 29 t on
     a 30 t bed is doing exactly what it was sent to do, and the card said so
     in the same red it uses for a dry tank. 580 bags of sugar is a good day.
     The only number that is news here is one OVER the legal payload, which is
     an offence rather than a full load, so that is the only one that shouts.
     (maxPayloadTonnes is the legal figure per type — see lib/vehicleMap.) */
  const loadColor = loadPct > 100 ? "var(--accent-crit)" : "var(--accent-ok)";

  // The open dispatch, as a round trip, recomputed from the live position —
  // the same source and the same helpers the Active Trip card uses, so hover
  // and panel can never disagree.
  //
  // This block used to read `vehicle.leg`, the retired simulator's journey
  // object, and had not rendered for anyone since the cutover. Sourcing
  // departure/destination from the dispatch brought it back to life with the
  // OTHER leg fields still unmapped, so it returned showing "0 / 0 km" and a
  // blank ETA. Everything it displays now comes from the trip.
  const trip    = liveTrip(vehicle.trip, vehicle.lat, vehicle.lng);
  const hasLeg  = trip != null;
  const total   = roundTripKm(trip);
  const distPct = trip?.percent ?? 0;
  // Ground actually driven today — the server's figure, the same one the
  // vehicle brief and the Active Trip card quote. Only the fallback for
  // OUTBOUND below, where the day's readings are not to hand.
  const drivenToday = trip?.distanceTodayKm ?? null;
  // The FactorySuite serial for the unit's open dispatch, when one has come in
  const serial = (trip?.serialNumber ?? vehicle.sealSerial ?? "").trim() || null;

  // A place name is what an operator can act on; "-6.8530, 39.2266" is not.
  // Resolves in the background and falls back to the coordinates until it lands.
  const placeName = usePlaceName(vehicle.lat, vehicle.lng);

  /* START → NOW, on every unit (operator, 28 Sep: "all the cards when I click
     on a unit should include the start and the current location, departed
     will be the time they start, outbound will be the distance covered since
     start, the serial should be removed").

     This block used to show only on a unit with an open dispatch, and then as
     the dispatch's yard ⇄ destination, its paperwork departure and a position
     along the round trip. KCB 303Z on 28 Sep read DEPARTED 05:43 under "On
     the road since 05:23", and "distance not measured" beside 0.2 km driven
     today at 45 km/h. Now the start is where and when the unit actually set
     off today, read off its own readings (lib/vehicleDay journeySoFar — the
     same start the vehicle panel's "Departed" names), and OUTBOUND is the
     ground covered since then. */
  const { orgId } = useFleetLiveShared() ?? {};
  const journey = useJourneySoFar(orgId, vehicle.vehicleId, withDay, vehicle.tankCapacityL ?? null);
  // Today's burn rate, off the same readings (lib/vehicleDay burnRate)
  const burn = journey?.burn ?? null;
  // Against the register's standard, where FactorySuite rates the unit
  const vsStd = burnAgainst(burn, vehicle.ratedBurn);
  const start = journey?.start ?? null;
  const startName = usePlaceName(start?.lat ?? null, start?.lng ?? null);
  const dayPending = withDay && journey == null;
  const outboundKm = journey ? journey.km : drivenToday;
  const showJourney = withDay || journey != null || hasLeg;

  // ── Copy coordinates ──────────────────────────────────────────────────────
  //
  // `idle` → `copied` → `idle`, or `failed` if the clipboard refused. The
  // handler used to mutate the button's own classList and title inside a
  // `.then()`, which is why it never worked on the box: see lib/copyText for
  // what `navigator.clipboard?.writeText(...).then(...)` actually does on a
  // page served over plain HTTP. State also survives the re-render a live
  // telemetry tick forces through this card, which a DOM class did not — the
  // flash used to vanish mid-flash on a moving unit.
  const coords = formatCoords(vehicle.lat, vehicle.lng);
  const [copyState, setCopyState] = useState("idle");
  const flashRef = useRef(null);

  useEffect(() => () => clearTimeout(flashRef.current), []);

  const onCopyCoords = async (e) => {
    // The card sits inside a marker, a search row and a pinned window, all of
    // which act on a click. Copying a coordinate is not selecting a vehicle.
    e.stopPropagation();
    if (!coords) return;
    const ok = await copyText(coords);
    setCopyState(ok ? "copied" : "failed");
    clearTimeout(flashRef.current);
    flashRef.current = setTimeout(() => setCopyState("idle"), ok ? 1800 : 2600);
  };

  // The row's own tooltip carries the pair as TEXT, because on the hover card
  // the button cannot be reached — see the note at the button. `placeName`
  // falls back to the coordinates until it resolves, and often never does, so
  // appending them unconditionally produced "-0.2877, 36.0446 — -0.287683,
  // 36.044650": the same fix twice at two precisions.
  // A comma alone would not do it — "Nakuru, Kenya" is a name and reads like
  // a pair. Two signed decimals and nothing else is a fix.
  const place = placeName ?? vehicle.location ?? "";
  const isFix = /^\s*-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?\s*$/.test(place);
  const locTitle = !coords ? (vehicle.location || undefined)
    : place && !isFix ? `${place} - ${coords}`
    : coords;

  const copyTitle = !coords ? "No coordinates available"
    : copyState === "copied" ? `Copied ${coords}`
    : copyState === "failed" ? "Could not copy, the coordinates are in the tooltip"
    : `Copy coordinates: ${coords}`;

  // Connection, straight from the provider — see isOnline in lib/vehicleMap.
  const online = vehicle.online ?? isOnline(vehicle);

  // The SAME classification the marker and the filter counts use, so the chip,
  // the truck on the map and the IN TRANSIT / IDLING / PARKED numbers can never
  // describe this vehicle differently. See vehicleActivity in lib/vehicleMap.
  //
  // Green in transit, blue idling, slate parked — and because the three are
  // mutually exclusive, a vehicle that stops with its engine running turns blue
  // here at the same moment it moves out of the in-transit count.
  //
  // Gated on the connection: an offline unit's last frame could still carry
  // engine-on, which would show a blue "Idling" chip for a tracker we have not
  // heard from. Offline reports Parked, as the marker does.
  const activity     = online ? vehicleActivity(vehicle) : "parked";
  const driverColor  = ACTIVITY_COLORS[activity];
  const activityLabel = ACTIVITY_LABELS[activity];

  const inTransit = isInTransit(vehicle);

  const typeLabel = equipmentLabel(vehicle)
    ?? (vehicle.vehicleType && vehicle.vehicleType !== "UNSPECIFIED"
          ? VEHICLE_TYPE_LABELS[vehicle.vehicleType] ?? vehicle.vehicleType
          : null);

  // Alerts only. Activity belongs to the one chip below, so it is stated once.
  const stateLabel = STATE_LABELS[vehicle.status];

  return (
    <>
      {/* ── Header ── */}
      <div className="vt-header">
        <div className="vt-header-left">
          <span className="vt-reg" title={vehicle.name || vehicle.id}>{displayPlate(vehicle)}</span>
          <span className="vt-driver-sub">{vehicle.driver}</span>
          {/* What this machine actually is. KASULU units take the name off
              RaiFactorySuite's machine register ("CASE PUMA", "Bull Dozer");
              otherwise the SPECIFIC equipment name off the unit's code — an
              EX is an "Excavator", not the
              "Plant" its class says, which every dozer and grader also shows.
              Falls back to the class when the code is not one we can name. */}
          {typeLabel && <span className="vt-type-badge">{typeLabel}</span>}
        </div>
        <div className="vt-header-right">
          {/* CONNECTION — always rendered, independent of everything else.
              This is the provider's own verdict (Wialon's netconn, carried by
              the server), not "has pinged recently". A unit can be online and
              idling, online and speeding, or offline mid-journey; each of
              those is two facts and needs two slots. */}
          <span className={`vt-conn ${online ? "vt-conn--on" : "vt-conn--off"}`}>
            <span className="vt-conn-dot" aria-hidden="true" />
            {online ? "ONLINE" : "OFFLINE"}
          </span>

          {/* ALERT — only when something is wrong. Activity lives on the chip
              below; a badge here repeating it stated the same fact twice. */}
          {/* The theft badge opens the unit's fuel theft window when the
              card's owner offers a way to (a clicked map card does; a hover
              card and the window's own copy do not). */}
          {stateLabel && (onAlertClick && vehicle.status === "theft" ? (
            <button
              type="button"
              className="vt-status-badge vt-status-badge--action"
              style={{ background: color + "22", color, border: `1px solid ${color}55` }}
              onClick={onAlertClick}
              title="Open the fuel theft alert"
            >
              {stateLabel}
            </button>
          ) : (
            <span className="vt-status-badge" style={{
              background: color + "22", color,
              border: `1px solid ${color}55`,
            }}>
              {stateLabel}
            </span>
          ))}
        </div>
      </div>

      <div className="vt-info">

        {/* Driver status + location */}
        <div className="vt-person-row">
          <div className="vt-person-chip" style={{
            color: driverColor,
            background: driverColor + "1a",
            border: `1px solid ${driverColor}44`,
            "--vt-transit-color": driverColor,
          }}>
            {/* The rippling dot moved here with the label. It echoes the map
                marker's in-transit ring, so the card and the marker say the
                same thing about the same vehicle. */}
            {inTransit
              ? <span className="vt-transit-dot" aria-hidden="true" />
              : <span className="vt-dot" style={{ background: driverColor }} />}
            {activityLabel}
          </div>
          {/* The location icon copies the pair. It is a real button, not the
              static 📍 it replaced — but only where it can be reached: the
              HOVER card is pointer-events:none and chases the cursor, so this
              is a live control on the pinned card, the search row and the fuel
              incident window, and inert decoration on hover. That is why the
              coordinates are also in the title attribute. */}
          <span className="vt-loc-text" title={locTitle}>
            <button
              type="button"
              className={"vt-loc-icon-btn"
                + (copyState === "copied" ? " vt-loc-icon-btn--copied" : "")
                + (copyState === "failed" ? " vt-loc-icon-btn--failed" : "")}
              title={copyTitle}
              onClick={onCopyCoords}
              disabled={!coords}
              aria-label={coords ? "Copy vehicle coordinates to clipboard" : "No coordinates to copy"}
            >
              {/* The mark swaps to a tick or a warning for the flash, so the
                  result is visible without hovering for the tooltip. */}
              <svg className="vt-loc-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {copyState === "copied" ? (
                  <path d="M20 6L9 17l-5-5" />
                ) : copyState === "failed" ? (
                  <>
                    <path d="M12 3L1.8 20.5h20.4L12 3z" />
                    <path d="M12 10v4M12 17.5v.01" />
                  </>
                ) : (
                  <>
                    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z"/>
                    <circle cx="12" cy="9" r="2.5"/>
                  </>
                )}
              </svg>
            </button>
            {/* Screen readers get the outcome; the icon swap is visual only. */}
            <span className="vt-sr-only" role="status" aria-live="polite">
              {copyState === "copied" ? `Copied ${coords}`
                : copyState === "failed" ? "Could not copy the coordinates"
                : ""}
            </span>
            {placeName ?? vehicle.location}
          </span>
        </div>

        <RunRow vehicle={vehicle} />

        <div className="vt-divider" />

        {/* ── vitals ledger ── */}
        <div className="vt-tiles">
          {/* No consumption figure. This read `${fuelConsumption} L/h`, which
              was 0 on EVERY vehicle: the Wialon adapter sets fuelUsedMl to null
              on every frame (the position payload has no consumption channel),
              and the mapper turned that null into 0. So an idling engine — one
              that is by definition burning fuel — reported burning none.

              It was also the wrong quantity: fuelUsedMl is documented as a
              VOLUME delta between pings, not a rate, so even once populated it
              could not be printed as L/h without dividing by the interval.

              ON / OFF says everything we actually measure here. A real rate
              needs fuel-level deltas over engine hours, computed server side —
              see the note in lib/vehicleMap. */}
          <Tile
            label="ENGINE"
            value={engineOn ? "ON" : "OFF"}
            valColor={engineColor}
          />
          <Tile
            label="SPEED"
            value={engineOn ? vehicle.speed : "-"}
            unit={engineOn ? " km/h" : ""}
            sub={engineOn
              ? (vehicle.speed > (vehicle.speedLimit ?? 80)
                  ? <><WarnGlyph />{` lim ${vehicle.speedLimit}`}</>
                  : `lim ${vehicle.speedLimit}`)
              : "sensor off"}
            valColor={speedColor}
            subColor={engineOn && vehicle.speed > (vehicle.speedLimit ?? 80)
              ? "var(--accent-warn)" : undefined}
          />
          <Tile
            label="MILEAGE"
            value={vehicle.odometerKm != null ? Math.round(vehicle.odometerKm).toLocaleString() : "-"}
            unit={vehicle.odometerKm != null ? " km" : ""}
            sub="total distance"
          />
          <Tile
            label="ENGINE HRS"
            value={vehicle.engineHours != null ? Math.round(vehicle.engineHours).toLocaleString() : "-"}
            unit={vehicle.engineHours != null ? " h" : ""}
            sub="total run time"
          />
          {/* Litres per engine hour today, with litres per km once it has
              driven far enough to say (lib/vehicleDay burnRate): always L/h or
              L/km. A unit the FactorySuite register rates is read on the
              register's basis and set against its standard, amber when well
              over it. */}
          {vsStd ? (
            <Tile
              label="BURN RATE"
              value={vsStd.today != null ? vsStd.today.toFixed(vsStd.digits) : "-"}
              unit={` ${vsStd.unit}`}
              sub={vsStd.over != null
                ? <>{vsStd.high && <WarnGlyph />}{` ${overWords(vsStd.over)} (${vsStd.std.toFixed(vsStd.digits)} ${vsStd.unit})`}</>
                : `standard ${vsStd.std.toFixed(vsStd.digits)} ${vsStd.unit}`}
              valColor={vsStd.high ? "var(--accent-warn)" : undefined}
              subColor={vsStd.high ? "var(--accent-warn)" : undefined}
            />
          ) : (
            <Tile
              label="BURN RATE"
              value={burn?.lPerH != null ? burn.lPerH.toFixed(1)
                : burn?.lPerKm != null ? burn.lPerKm.toFixed(2) : "-"}
              unit={burn?.lPerKm != null && burn.lPerH == null ? " L/km" : " L/h"}
              sub={burn?.lPerH != null && burn.lPerKm != null ? `${burn.lPerKm.toFixed(2)} L/km today`
                : burn ? "today"
                : dayPending ? "reading today…" : "not enough today"}
            />
          )}
          {/* Only once RaiFactorySuite has sent a serial for the unit
              (operator, 28 Sep: "remove the seal serial, this is to be
              dynamically populated when a webhook from FactorySuite sends us a
              serial number for the unit"). The webhook's serial lands on the
              unit's dispatch — the server's eventSerial reads five spellings
              of it — and reaches the card as trip.serialNumber. Until one
              arrives the row is not drawn; it was a permanent "—". */}
          {serial && (
            <Tile
              label="SEAL SERIAL"
              value={serial}
            />
          )}
        </div>

        {/* ── Fuel bar ── */}
        <div className="vt-bar-section">
          <div className="vt-bar-hdr">
            <span className="vt-bar-lbl">FUEL LEVEL</span>
            <span className="vt-bar-amt" style={{ color: fuelColor }}>
              {/* Litres out of tank capacity makes the percentage meaningful —
                  50% of a 20 L saloon tank is not 50% of a 400 L tractor. */}
              {vehicle.fuelLitres != null && vehicle.tankCapacityL != null
                ? `${Math.round(vehicle.fuelLitres)}/${Math.round(vehicle.tankCapacityL)} L · ${fuel}%`
                : vehicle.fuelLevel != null ? `${fuel}%`
                : vehicle.fuelLitres != null ? `${Math.round(vehicle.fuelLitres)} L`
                : "-"}
            </span>
          </div>
          <Bar pct={vehicle.fuelLevel != null ? fuel : 0} color={fuelColor} />
        </div>

        {/* ── Payload bar (carriers only) ── */}
        {hasPayload && (
          <>
            <div className="vt-divider" />
            <div className="vt-bar-section">
              <div className="vt-bar-hdr">
                <span className="vt-bar-lbl">{vehicle.cargo}</span>
                <span className="vt-bar-amt" style={{ color: loadColor }}>
                  {vehicle.weight} / {maxPay} t
                </span>
              </div>
              <Bar pct={loadPct} color={loadColor} />
              <span className="vt-bar-sub">{loadPct}% of payload capacity</span>
            </div>
          </>
        )}

        {/* ── Journey: where it set off today, and where it is now ── */}
        {showJourney && (
          <>
            <div className="vt-divider" />
            <div className="vt-journey-row">
              <span className="vt-jdot dep" />
              <span className="vt-jplace" title={start ? formatCoords(start.lat, start.lng) ?? undefined : undefined}>
                {start ? startName ?? formatCoords(start.lat, start.lng) ?? "Start"
                  : dayPending ? "…" : "Not moved today"}
              </span>
              <span className="vt-jarrow">→</span>
              <span className="vt-jdot dest" />
              <span className="vt-jplace" title={locTitle}>{place || coords || "-"}</span>
            </div>
            <div className="vt-journey-times">
              <span className="vt-jtime">
                {/* Departed only on a FactorySuite dispatch (every open trip is
                    one); otherwise the unit simply started work (operator,
                    2026-10-27). */}
                <span className="vt-jtime-lbl">{hasLeg ? "DEPARTED" : "STARTED"}</span>{" "}
                {start ? fmtClock(start.t) : dayPending ? "…" : "-"}
              </span>
            </div>
            <div className="vt-bar-section" style={{ marginBottom: 8 }}>
              <div className="vt-bar-hdr">
                <span className="vt-bar-lbl">OUTBOUND</span>
                {/* Explicit bright colour — with no colour this span inherited
                    the muted secondary text and the km figure was barely
                    legible. */}
                <span className="vt-bar-amt" style={{ color: "var(--accent-info)" }}>
                  {journey && !start ? "0 km"
                    : outboundKm != null ? `${(+outboundKm).toFixed(1)} km since start`
                    : dayPending ? "…" : "distance not measured"}
                </span>
              </div>
              {/* An open dispatch keeps its round trip: the bar is a position
                  along it, and the line under it says where the run is going.
                  No bar without a measured destination: 58 of Sukari's 152
                  destination names have too few completed trips to place, and
                  an empty bar would read as "nowhere yet" rather than
                  "unmeasurable". */}
              {hasLeg && trip.percent != null && <Bar pct={distPct} color="#38bdf8" />}
              {hasLeg && trip.destination && (
                <span className="vt-bar-sub">
                  {[LEG_LABEL[trip.leg],
                    trip.percent != null && total != null ? `${trip.percent}% of the ${total} km round trip to ${trip.destination}` : `trip to ${trip.destination}`,
                  ].filter(Boolean).join(" · ")}
                </span>
              )}
            </div>
          </>
        )}

      </div>
    </>
  );
}