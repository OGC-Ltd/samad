// VehicleDetailPanel — corporate right panel, wired to live server data.
// Tabs: Overview | Fuel | Alerts | Safety | Faults
//
// Data sources
//   vehicle (prop)      FleetLiveContext snapshot + SSE, normalised by lib/vehicleMap
//   telemetry per day   GET /organisations/:org/vehicles/:id/telemetry  (fuel curve, overspeed, fuel used, idle)
//   playback per day    GET /organisations/:org/vehicles/:id/playback   (Alerts tab, date range)
//   place name          GET /reverse-geocode                            (subtitle)
//
// Anything the server does not provide yet is shown as "Not available" — never invented.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '../../services/api';
import { useFleetLiveShared } from '../../context/FleetLiveContext';
import { useAppSelector, useAppActions, useCompanies } from '../../context/AppContext';
import { useMapLayers } from '../../context/MapLayersContext';
import { usePermissions } from '../../hooks/usePermissions';
import { requestOpenDriver } from '../../lib/driverHandoff';
import { createReport, addSectionTitle, addSummaryCards, addTable, downloadReport } from '../../utils/pdfReport';
import { usePlaceName } from '../../hooks/usePlaceName';
import { fleetDayKey } from '../../hooks/useFuelEvents';
import { vehicleReadings } from '../../lib/vehicleReadings';
import { burnAgainst, burnRate, cachedDay, dayBounds, loadDay, overWords, summariseDay, movingSpans } from '../../lib/vehicleDay';
import { useFuelEpisodes, useVehicleFuelEventsRange } from '../../hooks/useVehicleFuelEvents';
import { clampRange, daysBetween, joinDays, rangeWords } from '../../lib/dayRange';
import { settleLimited } from '../../lib/settleLimited';
import { fuelRateKind } from '../../lib/fuelEpisodes';
import FuelChart from './FuelChart';
import FuelRateSummary from './FuelRateSummary';
import DateRangePicker from './DateRangePicker';
import UnitFeed from './UnitFeed';
import TripTrafficEta from './TripTrafficEta';
import { SpeedNow, DaySummary, OverspeedTimeline, HarshTimeline } from './SafetyParts';
import { harshEvents, harshCountWords, HARSH_TYPES } from '../../lib/harshDriving';
import { getNotifications, fleetToday } from '../../api/notifications';
import { useApiData } from '../../hooks/useApiData';
import LoadError from '../shared/LoadError';
import { DayGroups, TankGauge } from './FuelParts';
import { ReadingsCard, FactsCard, OverspeedReadout, DriverRow, SummaryCard } from './OverviewParts';
import { HealthSummary, CheckList } from './FaultsParts';
import './VehicleHeader.scss';
// The panel's shared list, filter and empty-state styles (af-*): the Alerts
// tab's filter row, the Safety timeline, EmptyNote.
import './AlertsFeed.scss';
import './VehicleDetailPanel.scss';
import { displayPlate } from '../../lib/plate';

// ── Config ──────────────────────────────────────────────────────────────────
// KSh per litre, for the cost estimate: EPRA's Nairobi pump price as the
// operator gave it on 28 Sep (petrol, 214.03)
const FUEL_PRICE_KSH = 214.03;
const RESERVE_PCT    = 25;           // fuel reserve threshold (%)
const NA             = 'Not available';
const TODAY_REFRESH_MS = 60_000;     // re-read today's tail while the panel is open

// ── Helpers ─────────────────────────────────────────────────────────────────

// status comes from lib/vehicleMap deriveStatus(): theft | speeding | parked | idling | ok
function statusTag(v) {
  if (v.status === 'theft')    return fuelTag(v.fuelIncident);
  if (v.status === 'speeding') return { text: 'Speeding',   tone: 'danger' };
  if (!v.online)               return { text: 'Offline',    tone: 'muted'  };
  if (v.status === 'idling')   return { text: 'Idling',     tone: 'idle'   };  // cyan, as on the map and the status chips
  if ((v.speed ?? 0) > 0)      return { text: 'Moving',     tone: 'ok'     };
  return { text: 'Parked', tone: 'muted' };
}

/**
 * The tag for a unit with an open fuel finding. deriveStatus calls every one
 * of them 'theft', FUEL RATE and FUEL DOWN included, and this tag used to
 * print that as "Fuel theft" — which is how a FUEL DOWN on KDE 585S (27 Sep)
 * read as a theft that the chart then did not show. Only a siphon may say
 * theft, and only as "Possible theft"; the server decides which one is
 * (fuelIncident.mayUseTheftWording).
 */
function fuelTag(inc) {
  if (inc?.mayUseTheftWording) return { text: 'Possible theft', tone: 'danger' };
  return { text: fuelRateKind(inc?.reason) ?? 'Fuel alert', tone: 'warn' };
}

const HHMM = new Intl.DateTimeFormat('en-KE', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtTime = (ms) => (Number.isFinite(ms) ? HHMM.format(ms) : '-');

function fmtMinutes(min) {
  if (min == null || !Number.isFinite(min)) return NA;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function num(n, digits = 0) {
  return n == null || !Number.isFinite(n)
    ? NA
    : Number(n).toLocaleString('en-KE', { maximumFractionDigits: digits });
}

function timeAgo(ms) {
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

// ── Today's telemetry (fuel series, fuel used, idle time) ───────────────────

// Fleet days run on Nairobi time (UTC+3), same calendar as hooks/useFuelEvents
const dayStart = (dayKey) => new Date(dayBounds(dayKey).start);
const DAY_LABEL = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const fmtDay = (key) => DAY_LABEL.format(new Date(`${key}T00:00:00.000Z`));

// One day of this unit's readings, via lib/vehicleDay: one request, kept for
// the session. What is already held draws at once; today's tail is re-read in
// the background and every TODAY_REFRESH_MS while the panel is open.
function useDayTelemetry(orgId, vehicleId, dayKey) {
  const initial = () => {
    const held = orgId && vehicleId && dayKey ? cachedDay(orgId, vehicleId, dayKey) : null;
    return { pings: held?.pings ?? [], loading: Boolean(orgId && vehicleId && dayKey && !held), error: null };
  };
  const [state, setState] = useState(initial);

  useEffect(() => {
    if (!orgId || !vehicleId || !dayKey) { setState({ pings: [], loading: false, error: null }); return undefined; }
    let live = true;
    setState(initial());
    const pull = () => loadDay(orgId, vehicleId, dayKey)
      .then(r => { if (live) setState(s => (s.pings === r.pings && !s.loading ? s : { pings: r.pings, loading: false, error: null })); return r; })
      .catch(err => {
        if (!live) return null;
        // Keep what is already drawn; only an empty chart reports the failure.
        setState(s => (s.pings.length ? { ...s, loading: false } : { pings: [], loading: false, error: err?.message ?? 'Could not load telemetry' }));
        return null;
      });
    let timer = null;
    pull().then(r => {
      if (live && r && !r.complete) timer = setInterval(pull, TODAY_REFRESH_MS);
    });
    return () => { live = false; if (timer) clearInterval(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, vehicleId, dayKey]);

  return state;
}

/**
 * The Fuel tab's readings for one day or a range of them (lib/dayRange), as
 * one run. Each past day comes through loadDay, so a day already opened costs
 * nothing; today, when in the range, is the Overview's live telemetry rather
 * than a second request, which is what the tab did for today before. A day
 * that fails to load leaves a gap in the line, not an empty chart.
 */
const NO_DAYS = { key: null, parts: [], loading: false, error: null };

function useRangeTelemetry(orgId, vehicleId, days, todayTele) {
  const today = fleetDayKey();
  const past = days.filter(d => d !== today);
  const key = orgId && vehicleId && past.length ? `${orgId}|${vehicleId}|${past.join(',')}` : null;
  // What is held for `key`, drawn from the first frame of a new pick; the state
  // below is only ever the loaded copy of the same days.
  const fromHeld = () => {
    const h = past.map(d => cachedDay(orgId, vehicleId, d));
    return { key, parts: h.map(x => x?.pings ?? []), loading: h.some(x => !x), error: null };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const pending = useMemo(() => (key ? fromHeld() : NO_DAYS), [key]);
  const [state, setState] = useState(pending);
  const cur = state.key === key ? state : pending;

  useEffect(() => {
    if (!key) return undefined;
    let live = true;
    settleLimited(past, DAY_REQUESTS, d => loadDay(orgId, vehicleId, d)).then(rs => {
      if (!live) return;
      const failed = rs.filter(r => r.status === 'rejected');
      setState({
        key,
        parts: rs.map((r, i) => (r.status === 'fulfilled' ? r.value.pings : pending.parts[i])),
        loading: false,
        error: failed.length === rs.length ? failed[0].reason?.message ?? 'Could not load telemetry' : null,
      });
    });
    return () => { live = false; };
  // `key` carries the org, the unit and every past day
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const withToday = days.includes(today);
  const pings = useMemo(
    () => joinDays([...cur.parts, ...(withToday ? [todayTele.pings] : [])]),
    [cur.parts, withToday, todayTele.pings],
  );
  return {
    pings,
    loading: cur.loading || (withToday && todayTele.loading),
    error: cur.error ?? (withToday ? todayTele.error : null),
  };
}

/**
 * Today's telemetry, kept live.
 *
 * The day's pings are fetched once when the panel opens. After that, every
 * live frame the map receives for this unit (SSE `position`, merged onto the
 * vehicle by lib/vehicleMap) is added as another ping. That way the fuel line
 * and the overspeed marks keep growing while the panel is open, without
 * re-fetching the day.
 *
 * A frame is added only if it is newer than the last ping held, so a fetch
 * that already includes it doesn't draw it twice. The fetch replacing `pings`
 * starts the live tail again. Live frames don't carry the consumption counter
 * (`fuelUsedMl`), so "fuel used" still comes from the fetched pings only.
 */
export function appendLiveFrame(tail, fetched, vehicle) {
  const t = vehicle?.capturedAtMs;
  if (!Number.isFinite(t)) return tail;
  const last = tail.length ? tail[tail.length - 1].t
    : fetched.length ? fetched[fetched.length - 1].t : -Infinity;
  if (t <= last) return tail;
  return [...tail, {
    t,
    speedKmh:    Number.isFinite(vehicle.speed) ? vehicle.speed : null,
    fuelLevelMl: Number.isFinite(vehicle.fuelLitres) ? vehicle.fuelLitres * 1000 : null,
    engineOn:    vehicle.engine === 'on' ? true : vehicle.engine === 'off' ? false : null,
    // The snapshot's limit is the one where the unit is now
    limitKmh:    Number.isFinite(vehicle.speedLimit) ? vehicle.speedLimit : null,
  }];
}

function useLiveTelemetry(tele, vehicle) {
  const [tail, setTail] = useState([]);
  const unitId = vehicle?.id;

  useEffect(() => { setTail([]); }, [tele.pings, unitId]);

  const t = vehicle?.capturedAtMs;
  useEffect(() => {
    if (tele.loading || !Number.isFinite(t)) return;
    // Only today's frames belong on today's chart
    if (t < dayStart(fleetDayKey()).getTime()) return;
    setTail(prev => appendLiveFrame(prev, tele.pings, vehicle));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, tele.loading, tele.pings]);

  return useMemo(
    () => (tail.length ? { ...tele, pings: [...tele.pings, ...tail] } : tele),
    [tele, tail],
  );
}

// Overspeed runs: consecutive pings above the limit, merged into one event
// Each ping is judged by its own limit where the server sent one (an org whose
// limit depends on place), else by the unit's single `limit`.
function overspeedRuns(pings, limit) {
  const runs = [];
  let cur = null;
  for (const p of pings) {
    const spd = p.speedKmh ?? 0;
    const lim = Number.isFinite(p.limitKmh) ? p.limitKmh : limit;
    if (spd > lim) {
      if (cur && p.t - cur.end <= 2 * 60_000) {
        cur.end = p.t;
        if (spd > cur.max) { cur.max = spd; cur.limit = lim; }
      } else { cur = { start: p.t, end: p.t, max: spd, limit: lim }; runs.push(cur); }
    } else if (cur && p.t - cur.end > 2 * 60_000) {
      cur = null;
    }
  }
  return runs;
}

// "80", or "60–100 by zone" where the day's readings carry more than one limit
function limitLabel(pings, limit) {
  const seen = new Set(pings.map(p => p.limitKmh).filter(Number.isFinite));
  if (seen.size < 2) return String(seen.size ? [...seen][0] : limit);
  return `${Math.min(...seen)}–${Math.max(...seen)} by zone`;
}

// ── Layout pieces shared by the tabs ────────────────────────────────────────
//
// Every tab is built from the same three things (operator, 28 Sep: "have it
// well designed, right typography and layout" — Overview, Fuel, Safety and
// Faults alike). Figures are cards, label over value (FuelParts, OverviewParts,
// SafetyParts, redesigned 2026-10-02); on Faults, a list of checks with a
// state each.

/**
 * A day's (or a range's) figures, the same nine wherever they are shown —
 * Overview's "Today so far" and the Fuel tab's picked dates: fuel, then
 * driving, then engine and speed.
 */
function dayFigures(sum, { limit, runs, hasPings }) {
  const cost = sum.usedL != null ? sum.usedL * FUEL_PRICE_KSH : null;
  const top  = hasPings ? Math.round(sum.topSpeed ?? 0) : null;
  return [
    { label: 'Fuel used',  value: sum.usedL != null ? `${num(sum.usedL, 1)} L` : null,
      sub: sum.usedL != null && sum.usedSource === 'level' ? 'from tank level' : null },
    { label: 'Refuelled',  value: sum.refilledL != null ? `${num(sum.refilledL)} L` : null },
    { label: 'Est. cost',  value: cost != null ? `KSh ${num(Math.round(cost))}` : null,
      sub: cost != null ? `at KSh ${num(FUEL_PRICE_KSH, 2)}/L` : null },
    { label: 'Distance',   value: sum.distanceKm != null ? `${num(sum.distanceKm, 1)} km` : null },
    { label: 'Moving',     value: sum.movingMin != null ? fmtMinutes(sum.movingMin) : null },
    { label: 'Idle',       value: sum.idleMin != null ? fmtMinutes(sum.idleMin) : null },
    { label: 'Engine hours', value: sum.engineHoursToday != null ? `${num(sum.engineHoursToday, 1)} h` : null },
    { label: 'Top speed',  value: top != null ? `${top} km/h` : null, tone: top > limit ? 'alert' : null },
    { label: 'Overspeeds', value: hasPings ? String(runs.length) : null, tone: runs.length ? 'alert' : null },
  ];
}

/**
 * Nothing to list, said in the middle of what is left of the tab: an icon, a
 * title and one line under it (AlertsFeed.scss, .af-empty). The section holding
 * it takes `vdp-block--fill` so there is a middle. `tone` 'error' is red.
 */
function EmptyNote({ icon, title, children, tone }) {
  return (
    <div className={`af-empty${tone === 'error' ? ' af-empty--error' : ''}`} role="status">
      <span className="af-empty-icon" aria-hidden="true"><i className={`ti ${icon}`} /></span>
      <div className="af-empty-title">{title}</div>
      {children && <div className="af-empty-sub">{children}</div>}
    </div>
  );
}

// ── Summary (written by rule from the live fields — no model involved) ──────

/**
 * What the unit is doing as one lead sentence, then a line each for what to
 * know: flags first (red, then amber), then fuel, load and where it is going.
 */
function unitSummary({ vehicle, readings, place, usedL }) {
  const where = place ? ` near ${place}` : '';
  let lead;
  if (!vehicle.online) {
    const ago = timeAgo(readings.lastReportedAt);
    lead = `${displayPlate(vehicle)} is offline${ago ? `, last reported ${ago}` : ''}${where}.`;
  } else if ((vehicle.speed ?? 0) > 0) {
    lead = `${displayPlate(vehicle)} is moving at ${vehicle.speed} km/h${where}.`;
  } else {
    lead = `${displayPlate(vehicle)} is stationary${where}${vehicle.engine === 'on' ? ' with the engine running' : ''}.`;
  }

  const items = [];
  if (vehicle.status === 'theft') {
    const inc = vehicle.fuelIncident;
    items.push(inc?.mayUseTheftWording
      ? { icon: 'ti-alert-triangle', tone: 'alert', text: 'Possible fuel theft flagged. Review it and consider dispatching security.' }
      : { icon: 'ti-alert-circle', tone: 'warn', text: `${fuelRateKind(inc?.reason) ?? 'A fuel'} finding is open. Check it against the fuel records.` });
  }
  if (vehicle.status === 'speeding' && vehicle.speedLimit) {
    items.push({ icon: 'ti-gauge', tone: 'alert', text: `Over the ${vehicle.speedLimit} km/h limit.` });
  }
  if (readings.fuelPct != null) {
    const low = readings.fuelPct < RESERVE_PCT;
    items.push({ icon: 'ti-gas-station', tone: low ? 'warn' : null, text: `Fuel at ${readings.fuelPct}%${low ? ', below reserve' : ''}.` });
  } else if (readings.fuelProbeFault) {
    items.push({ icon: 'ti-gas-station-off', tone: 'warn', text: 'The fuel probe is reporting a fault.' });
  }
  if (usedL != null) items.push({ icon: 'ti-droplet', text: `${num(usedL, 1)} L used today.` });
  const loaded = vehicle.cargo && vehicle.cargo !== 'Empty' && vehicle.cargo !== 'No load expected';
  if (loaded) items.push({ icon: 'ti-package', text: `Carrying ${vehicle.cargo}${vehicle.weight ? ` (${vehicle.weight} t)` : ''}.` });
  // "Running empty" after the fuel line read as an empty tank
  else if (vehicle.cargo === 'Empty') items.push({ icon: 'ti-package-off', text: 'Carrying no load.' });
  if (vehicle.destination) items.push({ icon: 'ti-flag', text: `Heading to ${vehicle.destination}.` });

  const rank = { alert: 0, warn: 1 };
  items.sort((a, b) => (rank[a.tone] ?? 2) - (rank[b.tone] ?? 2));
  return { lead, items };
}

// ── Fuel level chart — see ./FuelChart ──────────────────────────────────────

// ── Alerts tab (the unit's feed — see ./UnitFeed) ──────────────────────────

// Up to 90 days a pick on the Fuel tab (operator, 28 Sep: "even more than 30
// days"), one request a day, DAY_REQUESTS at a time — see lib/settleLimited.
const MAX_RANGE_DAYS = 90;
const DAY_REQUESTS   = 4;

/** The longest period the feed's date picker offers — its last preset. */
const FEED_MAX_DAYS = 90;

/**
 * The unit's own feed (UnitFeed): its live items over its history, as the
 * Live feed shows the fleet's — the shape dash gives a clicked unit (operator,
 * 2026-10-02). All history by default; "Period" narrows it to fleet days.
 */
/**
 * The Safety tab's harsh accelerations and brakes for today: the stored day,
 * with whatever the live feed has brought since (lib/harshDriving).
 */
function HarshDay({ orgId, vehicleId }) {
  const { feed: liveFeed = [] } = useFleetLiveShared();
  const day = fleetToday();
  const { data, loading, error, retry } = useApiData(
    () => getNotifications({ orgId, vehicleId, day, limit: 500, alertTypes: HARSH_TYPES }),
    [orgId, vehicleId, day]
  );
  const events = useMemo(
    () => harshEvents([...liveFeed.filter((it) => fleetDayKey(new Date(it.ts)) === day), ...(data?.items ?? [])], vehicleId),
    [liveFeed, data, vehicleId, day]
  );
  const words = harshCountWords(events);
  return (
    // Its own heading, as "Today" above it; the count only when there is one,
    // and a quiet day said once (operator, 2026-10-21).
    <div className={`sf-hd${events.length ? '' : ' sf-hd--clear'}`}>
      <div className="sf-hd-head">
        <h3 className="vdp-block-title sf-hd-title">
          <span className="sf-hd-badge"><i className="ti ti-steering-wheel" aria-hidden="true" /></span>
          Harsh driving
        </h3>
        {loading && !events.length
          ? <span className="vdp-meta">Loading…</span>
          : words && <span className="sf-ev-count">{words}</span>}
      </div>
      {error && !events.length
        ? <LoadError label="Harsh driving" onRetry={retry} />
        : events.length > 0
          ? <HarshTimeline events={events} />
          : !loading && (
            <p className="sf-hd-none">
              <i className="ti ti-circle-check" aria-hidden="true" />
              No harsh acceleration or braking today.
            </p>
          )}
    </div>
  );
}

function AlertsTab({ vehicle }) {
  const today = fleetDayKey();
  const [range, setRangeState] = useState(null);   // null: all history
  const setRange = (f, t) => {
    const [a, b] = clampRange(f, t, today, FEED_MAX_DAYS);
    setRangeState({ from: a, to: b });
  };
  const periodWords = !range ? 'All history'
    : range.from === range.to ? (range.from === today ? 'Today' : fmtDay(range.from))
    : `${fmtDay(range.from)} – ${fmtDay(range.to)}`;

  return (
    <section className="vdp-block vdp-block--last vdp-block--fill">
      <div className="vdp-block-head">
        <div className="vdp-block-title">Alerts</div>
        <span className="vdp-meta">{periodWords}</span>
      </div>

      {/* Everything the unit has logged, or a period of it. */}
      <div className="af-filters">
        <div className="af-seg" role="radiogroup" aria-label="Period">
          <button type="button" role="radio" aria-checked={!range} onClick={() => setRangeState(null)}>
            All history
          </button>
          <button type="button" role="radio" aria-checked={Boolean(range)}
                  onClick={() => { if (!range) setRange(today, today); }}>
            Period
          </button>
        </div>
        {range && (
          <DateRangePicker from={range.from} to={range.to} today={today} maxDays={FEED_MAX_DAYS}
                           onChange={setRange} align="right" label="Feed dates" />
        )}
      </div>

      {!vehicle?.vehicleId
        ? <div className="vdp-empty">{NA}</div>
        : (
          <UnitFeed
            key={vehicle.vehicleId}
            vehicle={vehicle}
            range={range}
            todayKey={today}
            renderEmpty={({ error, retry }) => (error
              ? (<>
                <EmptyNote icon="ti-alert-triangle" tone="error" title="The Feed Could Not Be Loaded">
                  {error.message ?? String(error)}
                </EmptyNote>
                <button type="button" className="uf-more" onClick={retry}>Try again</button>
              </>)
              : (
                <EmptyNote icon="ti-bell-off" title={range ? 'Nothing in This Period' : 'Nothing Logged Yet'}>
                  {range
                    ? 'No arrivals, departures, fuel or alerts were logged for this unit. Pick other dates, or switch to All history.'
                    : 'Arrivals, departures, fuel and alerts for this unit show here as they happen.'}
                </EmptyNote>
              ))}
          />
        )}
    </section>
  );
}

// ── Fuel tab (one day, or a range of days) ──────────────────────────────────

function FuelTab({ orgId, vehicle, vehicleId, readings, todayTele }) {
  const today = fleetDayKey();
  // One day, or a range of up to MAX_RANGE_DAYS, from the one picker in the
  // heading (operator, 28 Sep: "the date picker should be able to pick a range
  // of dates or a single date" — "just one interface").
  const [[from, to], setDays] = useState([today, today]);
  const days = useMemo(() => daysBetween(from, to, MAX_RANGE_DAYS), [from, to]);
  const multiDay = from !== to;
  const isToday = !multiDay && from === today;
  // Today comes from the Overview's request rather than a second one
  const tele  = useRangeTelemetry(orgId, vehicleId, days, todayTele);
  const limit = vehicle.speedLimit ?? 80;
  const events = useVehicleFuelEventsRange(orgId, vehicleId, days);
  const episodes = useFuelEpisodes(events.drains, events.fillings, tele.pings);
  // A band opened from the FUEL RATE / FUEL DOWN summary, and the chart to bring into view
  const [focus, setFocus] = useState(null);
  const chartRef = useRef(null);
  const pickBand = (id) => {
    setFocus({ id });
    chartRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  };

  const sum   = useMemo(() => summariseDay(tele.pings, vehicle.tankCapacityL), [tele.pings, vehicle.tankCapacityL]);
  const runs  = useMemo(() => overspeedRuns(tele.pings, limit), [tele.pings, limit]);
  const dayLabel = rangeWords(from, to, today, fmtDay);
  const title = isToday ? 'Today'
    : multiDay ? `${fmtDay(from)} – ${to === today ? 'today' : fmtDay(to)}`
    : fmtDay(from);
  // Where each day after the first begins, for the chart's midnight lines
  const dayStarts = useMemo(() => days.slice(1).map(d => dayBounds(d).start), [days]);

  const pick = (f, t) => { setDays(clampRange(f, t, today, MAX_RANGE_DAYS)); setFocus(null); };

  return (<>
    {/* The tank first, then the chart (operator, 2026-10-02) */}
    <section className="vdp-block">
      <div className="vdp-block-title">Tank</div>
      <TankGauge
        pct={readings.fuelPct} litres={readings.fuelLitres} capacityL={vehicle.tankCapacityL}
        reservePct={RESERVE_PCT} probeFault={readings.fuelProbeFault} probeHold={vehicle.probeHold}
      />
    </section>
    <section className="vdp-block" ref={chartRef}>
      <div className="vdp-block-head">
        <div className="vdp-block-title">
          Fuel &amp; overspeed
          {to === today && vehicle.online && <span className="vdp-live">live</span>}
        </div>
        <DateRangePicker from={from} to={to} today={today} maxDays={MAX_RANGE_DAYS} onChange={pick} align="right" label="Chart dates" />
      </div>
      {/* The whole width and a taller plot: no readout over it (operator, 2026-10-02) */}
      <div className="fp-chart fp-chart--bare">
        <FuelChart
          key={`${from}|${to}`} series={sum.series} unit={sum.unit} loading={tele.loading} overspeeds={runs} dayLabel={dayLabel}
          pings={tele.pings} limit={limit} reservePct={RESERVE_PCT} limitText={limitLabel(tele.pings, limit)}
          episodes={episodes} focus={focus} showList withDate={multiDay} dayStarts={dayStarts} tall
        />
      </div>
      {events.error && <div className="vdp-empty">Fuel events could not be loaded: {events.error}</div>}
    </section>
    <section className="vdp-block vdp-block--last">
      <div className="vdp-block-head">
        <div className="vdp-block-title">{title}</div>
        {tele.loading && <span className="vdp-meta">Loading…</span>}
      </div>
      <FuelRateSummary
        drains={events.drains} episodes={episodes} dayWord={dayLabel} withDate={multiDay}
        loading={events.loading} error={events.error} onPick={pickBand}
      />
      <DayGroups items={dayFigures(sum, { limit, runs, hasPings: tele.pings.length > 0 })} />
    </section>
  </>);
}

// ── Quick-action helpers ────────────────────────────────────────────────────

async function buildVehicleReport({ orgId, vehicle, readings, today, runs, place, companyName }) {
  // Today's recorded events for the report body
  let events = [];
  try {
    const res = await apiFetch(`/api/v1/organisations/${orgId}/vehicles/${vehicle.vehicleId}/playback?day=${fleetDayKey()}`);
    events = res.data?.events ?? [];
  } catch { /* report still useful without events */ }

  const doc = createReport({
    companyName: companyName || 'Fleet',
    reportTitle: 'Vehicle Report',
    subtitle: `${displayPlate(vehicle)} · ${fmtDay(fleetDayKey())}`,
  });
  addSummaryCards(doc, [
    { label: 'Fuel level',   value: readings.fuelPct != null ? `${readings.fuelPct}%` : '-' },
    { label: 'Fuel used',    value: today.usedL != null ? `${num(today.usedL, 1)} L` : '-' },
    { label: 'Engine hours', value: readings.engineHours != null ? `${num(readings.engineHours)} h` : '-' },
    { label: 'Odometer',     value: readings.odometerKm != null ? `${num(readings.odometerKm)} km` : '-' },
  ]);
  addSectionTitle(doc, 'Vehicle');
  addTable(doc, {
    head: ['Item', 'Value'],
    body: [
      ['Plate', vehicle.id],
      ['Driver', vehicle.driver ?? 'Unassigned'],
      ['Type', vehicle.vehicleType ?? '-'],
      ['Status', statusTag(vehicle).text],
      ['Location', place ?? vehicle.location ?? '-'],
      ['Last report', readings.lastReportedAt ? new Date(readings.lastReportedAt).toLocaleString('en-KE') : '-'],
      ['Load', vehicle.cargo ?? '-'],
      ['Idle time today', today.idleMin != null ? fmtMinutes(today.idleMin) : '-'],
      ['Distance today', today.distanceKm != null ? `${num(today.distanceKm, 1)} km` : '-'],
      ['Overspeed events today', String(runs.length)],
      ['Fuel probe', readings.fuelProbeFault ? 'Fault reported' : readings.fuelPct != null ? 'OK' : '-'],
    ],
  });
  if (events.length) {
    addSectionTitle(doc, "Today's events");
    addTable(doc, {
      head: ['Time', 'Event', 'Detail', 'Severity'],
      body: events.map(e => [fmtTime(e.t), e.label ?? '', e.detail ?? '', e.severity ?? '']),
    });
  }
  downloadReport(doc, `Vehicle-Report-${vehicle.id.replace(/\s+/g, '')}-${fleetDayKey()}.pdf`);
}

// ── Main component ──────────────────────────────────────────────────────────

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'fuel',     label: 'Fuel'     },
  { key: 'alerts',   label: 'Alerts'   },
  { key: 'safety',   label: 'Safety'   },
  { key: 'faults',   label: 'Faults'   },
];

export default function VehicleDetailPanel({ vehicle, onClose }) {
  const [tab, setTab] = useState('overview');
  const { orgId, vehicles = [] } = useFleetLiveShared();
  const trackedIds = useAppSelector((a) => a.trackedIds);
  const { setTrackedIds, setDesktopActiveTab } = useAppActions();
  const { activeCompany } = useCompanies();
  const { focusVehicle, startPlayback } = useMapLayers() ?? {};
  const { can } = usePermissions();
  const [reporting, setReporting] = useState(false);

  // Tracked list — only units that still exist in the live fleet, in the order added
  const trackedList = useMemo(() => {
    const live = new Set(vehicles.map(v => v.id));
    return (trackedIds ?? []).filter(id => live.has(id));
  }, [trackedIds, vehicles]);
  const isTracked = vehicle ? (trackedIds ?? []).includes(vehicle.id) : false;
  const navIndex  = vehicle ? trackedList.indexOf(vehicle.id) : -1;
  const canNav    = trackedList.length >= 2;

  const toggleTrack = () => {
    if (!vehicle) return;
    const id = vehicle.id;
    setTrackedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  // Step through the tracked list (wraps). If the open unit isn't tracked,
  // "next" starts at the first tracked unit and "previous" at the last.
  const step = useCallback((dir) => {
    if (trackedList.length < 2) return;
    const i = navIndex === -1 ? (dir > 0 ? -1 : 0) : navIndex;
    const next = trackedList[(i + dir + trackedList.length) % trackedList.length];
    focusVehicle?.(next);
  }, [trackedList, navIndex, focusVehicle]);

  // ← / → keys while the panel is open (ignored while typing in a field)
  useEffect(() => {
    if (!vehicle || !canNav) return undefined;
    const onKey = (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
      if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [vehicle, canNav, step]);

  /* Escape closes it.
   *
   * Separate from the arrow-key effect above because that one is gated on
   * `canNav` — with fewer than two tracked units it does not run at all, and
   * Escape has to work whether or not anything is tracked. On a tablet the
   * panel covers the map, which makes a keyboard dismissal the difference
   * between a panel and a trap. */
  useEffect(() => {
    if (!vehicle) return undefined;
    const onEsc = (e) => {
      if (e.key !== 'Escape') return;
      const tag = e.target?.tagName;
      // Escape inside a field means "clear what I typed", not "close the
      // panel I typed it in".
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      onClose?.();
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [vehicle, onClose]);

  const vehicleId = vehicle?.vehicleId ?? null;
  const readings  = useMemo(() => vehicleReadings(vehicle), [vehicle]);
  const place     = usePlaceName(
    Number.isFinite(vehicle?.lat) ? vehicle.lat : null,
    Number.isFinite(vehicle?.lng) ? vehicle.lng : null,
  );
  const dayTele = useDayTelemetry(orgId, vehicleId, fleetDayKey());
  const tele  = useLiveTelemetry(dayTele, vehicle);
  const today = useMemo(
    () => summariseDay(tele.pings, vehicle?.tankCapacityL),
    [tele.pings, vehicle?.tankCapacityL],
  );
  const burn = useMemo(() => burnRate(today), [today]);
  const vsStd = burnAgainst(burn, vehicle?.ratedBurn);
  // Where today's driving began, for the header when no trip is on record
  const startPlace = usePlaceName(
    vehicle?.departure ? null : today.firstMove?.lat ?? null,
    vehicle?.departure ? null : today.firstMove?.lng ?? null,
  );

  const todayRuns = useMemo(() => overspeedRuns(tele.pings, vehicle?.speedLimit ?? 80), [tele.pings, vehicle?.speedLimit]);
  const todayMoving = useMemo(() => movingSpans(tele.pings), [tele.pings]);

  useEffect(() => { setTab('overview'); }, [vehicle?.id]);

  if (!vehicle) return <div className="vdp" />;

  const tag      = statusTag(vehicle);
  const hasDriver = Boolean(vehicle.driver && vehicle.driver !== 'Unassigned');
  const fuelPct  = readings.fuelPct;
  const updated  = readings.lastReportedAt ? fmtTime(readings.lastReportedAt) : null;
  const rating   = Number.isFinite(vehicle.driverRatingScore) ? `${num(vehicle.driverRatingScore, 1)} / 5` : null;
  const summary  = unitSummary({ vehicle, readings, place, usedL: today.usedL });
  const lastSeen = timeAgo(readings.lastReportedAt);
  // A unit that has reported has a tracker, whatever the provider's connection
  // verdict: `hasTracker` reads that verdict alone, and a fleet without one
  // (KASULU) showed "No tracker" over a fix two hours old.
  const tracked  = readings.hasTracker || readings.lastReportedAt != null;
  const gps = !tracked
    ? { label: 'No tracker', sub: 'no GPS unit fitted', tone: null }
    : readings.isReporting
      ? { label: 'Reporting', sub: lastSeen ? `last fix ${lastSeen}` : 'live', tone: null }
      : { label: 'Not reporting', sub: lastSeen ? `last fix ${lastSeen}` : 'no fix received', tone: 'warn' };
  const limit    = vehicle.speedLimit ?? 80;
  const engineWord = readings.engineOn == null ? null : readings.engineOn ? 'On' : 'Off';
  const hasPings = tele.pings.length > 0;
  const limitWords = limitLabel(tele.pings, limit);   // '80', or '60–100 by zone'
  const lastReport = readings.lastReportedAt ? `${fmtTime(readings.lastReportedAt)} · ${timeAgo(readings.lastReportedAt)}` : null;

  // Faults: each part that reports, and how it is doing
  const checks = [
    vehicle.probeHold
      ? { name: 'Fuel probe', icon: 'ti-gas-station', state: 'Reported', tone: 'warn', sub: 'Awaiting repair · alerts still come' }
      : readings.fuelProbeFault
      ? { name: 'Fuel probe', icon: 'ti-gas-station', state: 'Fault', tone: 'alert', sub: 'Reporting a fault instead of a level' }
      : readings.fuelLitres != null
        ? { name: 'Fuel probe', icon: 'ti-gas-station', state: 'Reporting', tone: 'ok', sub: `${num(readings.fuelLitres)} L in tank${fuelPct != null ? ` · ${fuelPct}%` : ''}` }
        : { name: 'Fuel probe', icon: 'ti-gas-station', state: 'No reading', tone: 'none', sub: 'No calibrated probe' },
    !tracked
      ? { name: 'GPS tracker', icon: 'ti-satellite', state: 'Not fitted', tone: 'none', sub: 'No GPS unit on this vehicle' }
      : readings.isReporting
        ? { name: 'GPS tracker', icon: 'ti-satellite', state: 'Reporting', tone: 'ok', sub: lastReport ? `Last report ${lastReport}` : null }
        : { name: 'GPS tracker', icon: 'ti-satellite', state: 'Not reporting', tone: 'warn', sub: lastReport ? `Last report ${lastReport}` : 'No report received' },
    readings.engineHours != null
      ? { name: 'Engine-hours meter', icon: 'ti-engine', state: `${num(readings.engineHours)} h`, tone: 'ok', sub: engineWord ? `Engine ${engineWord.toLowerCase()}` : 'Engine state unknown' }
      : { name: 'Engine-hours meter', icon: 'ti-engine', state: 'No reading', tone: 'none' },
    readings.odometerKm != null
      ? { name: 'Odometer', icon: 'ti-road', state: `${num(readings.odometerKm)} km`, tone: 'ok', sub: 'Total mileage' }
      : { name: 'Odometer', icon: 'ti-road', state: 'No reading', tone: 'none' },
  ];

  return (
    <div className="vdp vdp--open">

      {/* ── Header: who and where (VehicleHeader.scss) ── */}
      <header className="vdp-header vh">
        <div className="vh-top">
          <h2 className="vh-name" title={vehicle.name && vehicle.name !== vehicle.id ? `${vehicle.id} · ${vehicle.name}` : vehicle.id}>
            {displayPlate(vehicle)}
          </h2>
          <div className="vh-tools">
            {canNav && (
              <div className="vh-nav" title="Step through tracked vehicles (← →)">
                <button type="button" className="vh-icon-btn" onClick={() => step(-1)} aria-label="Previous tracked vehicle">
                  <i className="ti ti-chevron-left" aria-hidden="true" />
                </button>
                <span className="vh-nav-count">{navIndex === -1 ? '–' : navIndex + 1}/{trackedList.length}</span>
                <button type="button" className="vh-icon-btn" onClick={() => step(1)} aria-label="Next tracked vehicle">
                  <i className="ti ti-chevron-right" aria-hidden="true" />
                </button>
              </div>
            )}
            <button type="button" className="vh-icon-btn" onClick={onClose} aria-label="Close">
              <i className="ti ti-x" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Status first, then who drives and where it last reported */}
        <div className="vh-meta">
          <span className={`vh-status vh-status--${tag.tone}`}>
            <span className="vh-status-dot" aria-hidden="true" />{tag.text}
          </span>
          <span className="vh-fact" title="Driver">
            <i className="ti ti-user" aria-hidden="true" />{vehicle.driver ?? 'Unassigned'}
          </span>
          {updated && (
            <span className="vh-fact" title="Last report">
              <i className="ti ti-clock" aria-hidden="true" />{updated}
            </span>
          )}
        </div>
        {(place ?? vehicle.location) && (
          <div className="vh-where" title={place ?? vehicle.location}>
            <i className="ti ti-map-pin" aria-hidden="true" />
            <span>{place ?? vehicle.location}</span>
          </div>
        )}

        {/* Reported for a fuel probe repair. Its fuel alerts are no longer
            held back (operator, 2026-10-13: "do not put a unit on hold, but
            we can highlight it was reported"), so this says why a fuel alert
            on it may be the probe rather than a loss. */}
        {vehicle.probeHold && (
          <div className="vdp-hold" role="note">
            <i className="ti ti-tool" aria-hidden="true" />
            <span><strong>Probe reported</strong> · Waiting on a fuel probe repair. Fuel alerts still come, marked as reported.</span>
          </div>
        )}

        {/* Trip: from, then to, as two stops on one line */}
        <ol className="vh-route" aria-label="Trip">
          <li className="vh-stop vh-stop--from">
            {/* Departed when FactorySuite dispatched it; its own first
                movement otherwise is when it started (operator, 2026-10-27). */}
            <span className="vh-stop-lbl">{vehicle.departure ? 'Departed' : 'Started'}</span>
            <span className="vh-stop-val" title={vehicle.departure ?? ''}>
              {vehicle.departure
                ?? (today.firstMove ? `${startPlace ?? 'Moved'} · ${fmtTime(today.firstMove.t)}` : tele.loading ? '…' : 'Not moved today')}
            </span>
          </li>
          <li className={`vh-stop vh-stop--to${vehicle.destination ? '' : ' vh-stop--none'}`}>
            <span className="vh-stop-lbl">Destination</span>
            <span className="vh-stop-val" title={vehicle.destination ?? ''}>{vehicle.destination ?? 'No trip assigned'}</span>
          </li>
          <TripTrafficEta vehicle={vehicle} />
        </ol>

        {/* Quick actions */}
        <div className="vh-actions">
          <button
            type="button"
            className={`vh-action${isTracked ? ' vh-action--on' : ''}`}
            onClick={toggleTrack}
            aria-pressed={isTracked}
            title={isTracked ? 'Stop tracking this vehicle' : 'Add to tracked vehicles'}
          >
            <i className={`ti ${isTracked ? 'ti-pinned-off' : 'ti-pin'}`} aria-hidden="true" />
            {/* Says what pressing it again does: "✓ Tracking" read as a status. */}
            {isTracked ? 'Untrack' : 'Track'}
          </button>
          <button
            type="button"
            className="vh-action"
            onClick={() => startPlayback?.(vehicle.id)}
            title="Replay today's route on the map"
          >
            <i className="ti ti-player-play" aria-hidden="true" />
            Playback
          </button>
          {can('report:export') && (
            <button
              type="button"
              className="vh-action"
              data-state={reporting ? 'loading' : undefined}
              disabled={reporting || !vehicle.vehicleId || !orgId}
              onClick={async () => {
                setReporting(true);
                try {
                  await buildVehicleReport({ orgId, vehicle, readings, today, runs: todayRuns, place, companyName: activeCompany?.name });
                } finally {
                  setReporting(false);
                }
              }}
              title="Download today's vehicle report (PDF)"
            >
              <i className={`ti ${reporting ? 'ti-loader-2' : 'ti-file-download'}`} aria-hidden="true" />
              {reporting ? 'Preparing' : 'Report'}
            </button>
          )}
        </div>
      </header>

      {/* ── Tabs ── */}
      <div className="vdp-tabs" role="tablist">
        {TABS.map(t => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`vdp-tab${tab === t.key ? ' vdp-tab--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="vdp-body">

        {/* ═════ OVERVIEW ═════ */}
        {tab === 'overview' && (<>

          {/* The driver first (operator, 28 Sep), then the summary in words and
              the four readings under it */}
          <section className="vdp-block">
            <div className="vdp-block-title">Driver</div>
            {/* The driver and what the unit is doing, as one card */}
            <div className="ov-person">
              <DriverRow
                name={hasDriver ? vehicle.driver : null}
                rating={rating}
                droveToday={vehicle.driverSource === 'last-dispatch'}
                onOpen={hasDriver && can('driver:read')
                  ? () => { requestOpenDriver(vehicle.driver); setDesktopActiveTab('drivers'); onClose?.(); }
                  : null}
              />
              <SummaryCard {...summary} asOf={updated} />
            </div>
            <ReadingsCard reservePct={RESERVE_PCT} items={[
              // Idle in place of the fuel level, which the Fuel tab shows (operator, 2026-10-02)
              { icon: 'ti-hourglass', label: 'Idle today', value: today.idleMin != null ? fmtMinutes(today.idleMin) : null,
                sub: today.idleMin != null ? 'engine on, standing' : 'no engine state reported' },
              { icon: 'ti-satellite', label: 'GPS', value: gps.label, sub: gps.sub, tone: gps.tone },
              // Litres per engine hour today, and litres per km once it has
              // driven far enough (lib/vehicleDay burnRate, as the unit card)
              // A unit the FactorySuite register rates: in the register's
              // unit, against its standard, amber when well over it
              vsStd
                ? { icon: 'ti-flame', label: 'Burn rate', tone: vsStd.high ? 'warn' : null,
                    value: vsStd.today != null ? `${num(vsStd.today, vsStd.digits)} ${vsStd.unit}` : null,
                    sub: vsStd.over != null ? `${overWords(vsStd.over)} (${num(vsStd.std, vsStd.digits)} ${vsStd.unit})`
                      : `standard ${num(vsStd.std, vsStd.digits)} ${vsStd.unit}${tele.loading ? '' : ', not enough today'}` }
                : { icon: 'ti-flame', label: 'Burn rate', value: burn?.lPerH != null ? `${num(burn.lPerH, 1)} L/h`
                    : burn?.lPerKm != null ? `${num(burn.lPerKm, 2)} L/km` : null,
                  sub: !burn ? (tele.loading ? 'reading today…' : 'not enough today')
                    : burn.lPerH != null && burn.lPerKm != null ? `${num(burn.lPerKm, 2)} L/km · ${num(burn.usedL, 1)} L today`
                    : `${num(burn.usedL, 1)} L used today` },
              { icon: 'ti-engine', label: 'Engine hours', value: readings.engineHours != null ? `${num(readings.engineHours)} h` : null,
                sub: readings.engineHours != null ? `engine ${engineWord ? engineWord.toLowerCase() : 'state unknown'}` : NA },
              { icon: 'ti-road', label: 'Odometer', value: readings.odometerKm != null ? `${num(readings.odometerKm)} km` : null,
                sub: readings.odometerKm != null ? 'total mileage' : NA },
            ]} />
          </section>

          {/* Speed & overspeed — today, growing with every live frame. Fuel is the
              Fuel tab's (operator, 2026-10-02: the Overview should not repeat it). */}
          <section className="vdp-block">
            <div className="vdp-block-head">
              <div className="vdp-block-title">
                Speed &amp; overspeed
                {vehicle.online && <span className="vdp-live">live</span>}
              </div>
              <span className="vdp-meta">{updated ? `updated ${timeAgo(readings.lastReportedAt)}` : ''}</span>
            </div>
            <div className="fp-chart">
              <OverspeedReadout runs={todayRuns} topSpeed={today.topSpeed} limit={limit} hasPings={hasPings} fmtMinutes={fmtMinutes} />
              <div className="fp-chart-body">
                <FuelChart
                  key={vehicle.id} series={today.series} unit={today.unit} loading={tele.loading} overspeeds={todayRuns}
                  pings={tele.pings} limit={limit} limitText={limitLabel(tele.pings, limit)} speedOnly
                />
              </div>
            </div>
          </section>

          {/* Today, from the day's readings (lib/vehicleDay) */}
          <section className="vdp-block">
            <div className="vdp-block-head">
              <div className="vdp-block-title">Today so far</div>
              {tele.loading && <span className="vdp-meta">Loading…</span>}
            </div>
            {/* Fuel and FUEL RATE / FUEL DOWN are the Fuel tab's */}
            <DayGroups items={dayFigures(today, { limit, runs: todayRuns, hasPings })} only={['Driving', 'Engine & speed']} />
          </section>

          {/* What it is */}
          <section className="vdp-block vdp-block--last">
            <div className="vdp-block-title">Vehicle</div>
            <FactsCard items={[
              { label: 'Type', value: vehicle.vehicleType ? vehicle.vehicleType.charAt(0) + vehicle.vehicleType.slice(1).toLowerCase() : null },
              { label: 'Load', value: vehicle.cargo ? `${vehicle.cargo}${vehicle.weight ? ` · ${vehicle.weight} t` : ''}` : 'No load recorded' },
            ]} />
          </section>
        </>)}

        {/* ═════ FUEL ═════ */}
        {tab === 'fuel' && (
          <FuelTab orgId={orgId} vehicle={vehicle} vehicleId={vehicleId} readings={readings} todayTele={tele} />
        )}

        {/* ═════ ALERTS ═════ */}
        {tab === 'alerts' && <AlertsTab key={vehicleId} vehicle={vehicle} />}

        {/* ═════ SAFETY ═════ */}
        {tab === 'safety' && (<>
          <section className="vdp-block">
            <div className="vdp-block-title">Right now</div>
            {/* One meter, speed against limit, rather than three boxes to
                compare (SafetyParts). */}
            <SpeedNow
              speed={vehicle.speed}
              limit={limit}
              assumed={vehicle.speedLimit == null}
              engineWord={engineWord}
              online={vehicle.online}
            />
          </section>

          <section className="vdp-block vdp-block--last vdp-block--fill">
            <div className="vdp-block-head">
              <div className="vdp-block-title">Today</div>
              {tele.loading && <span className="vdp-meta">Loading…</span>}
            </div>
            {/* One card: the day's three figures over its 24-hour strip */}
            <DaySummary
              hasPings={hasPings} topSpeed={today.topSpeed} limit={limit} runs={todayRuns}
              movingMin={today.movingMin} moving={todayMoving} fmtMinutes={fmtMinutes}
            />
            {todayRuns.length > 0 && (<>
              <div className="sf-ev-head">
                <span className="vdp-sub-title">Overspeed events</span>
                <span className="sf-ev-count">{todayRuns.length} · newest first</span>
              </div>
              <OverspeedTimeline runs={todayRuns} fmtMinutes={fmtMinutes} />
            </>)}
            {/* None: said in the middle, as on the Alerts tab (operator, 28 Sep) */}
            {todayRuns.length === 0 && !tele.loading && (hasPings
              ? (
                <EmptyNote icon="ti-shield-check" title="No overspeed events today">
                  Never over {/^\d+$/.test(limitWords)
                    ? `the ${limitWords} km/h limit`
                    : `its zone limits (${limitWords.replace(' by zone', '')} km/h)`} today.
                </EmptyNote>
              ) : (
                <EmptyNote icon="ti-map-pin-off" title="No readings today">
                  The unit has not reported since midnight, so there is no speed to check.
                </EmptyNote>
              ))}
            {vehicle.vehicleId && orgId && <HarshDay key={vehicle.vehicleId} orgId={orgId} vehicleId={vehicle.vehicleId} />}
          </section>
        </>)}

        {/* ═════ FAULTS ═════ */}
        {tab === 'faults' && (
          <section className="vdp-block vdp-block--last">
            <div className="vdp-block-title">Diagnostics</div>
            {/* The verdict first, then each part, faults at the top (FaultsParts) */}
            <HealthSummary items={checks} asOf={updated} />
            <CheckList items={checks} />
          </section>
        )}

      </div>
    </div>
  );
}