/*
 * The vehicle panel's fuel & overspeed chart: one fleet day of a unit's tank
 * level and speed, with the fuel ledger's events shaded where they happened.
 *
 * ## What is drawn
 *
 *   · the tank level (amber) and speed (sky blue, its own right-hand scale);
 *   · a band per fuel event — possible theft, slosh, redistribution, refill,
 *     and the drops beyond measured burn that are none of those — placed on
 *     the line itself and numbered in the row above the plot. The verdicts
 *     are the server's; lib/fuelEpisodes only names and places them;
 *   · a strip under the plot: the engine on (green) and off (grey), with each
 *     overspeed run marked red on it. Overspeed used to be drawn as red bands
 *     over the plot, and a red band there now means a possible theft only.
 *
 * ## Interactive
 *
 * Move over it (or drag a finger along it) to read the time, fuel, speed,
 * engine state and the event under the pointer. The crosshair carries a label
 * with the litres in the tank at the reading under it, in litres even when the
 * line is drawn in % of the tank (operator, 28 Sep: "I get to see the amount
 * in litres of fuel at that point"). Tap a numbered mark, click inside a band,
 * or pick a row of the event list to zoom to that event and read what the
 * server concluded. The mouse wheel zooms about the pointer and Shift + wheel
 * (or a sideways swipe) moves along the day — see lib/chartView; a mouse drag
 * zooms into a stretch; tap a red mark on the strip for an overspeed run.
 * Arrow keys step the cursor, + and − zoom, Escape clears it, double-click or
 * "Whole day" zooms back out. The legend switches each kind of event on and
 * off.
 *
 * The Fuel tab can hand it a range of days rather than one (its date picker):
 * the same chart over the whole range, with every time given with its day and
 * a line at each midnight. The wheel is how a reader gets from a fortnight
 * down to the minutes around one event.
 *
 * `focus` opens an event from outside the chart — the FUEL RATE / FUEL DOWN
 * summary under it passes the band of the row picked there.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { FUEL_EVENT_KINDS, FUEL_EVENT_ORDER } from '../../lib/fuelEpisodes';
import { zoomView, panView, isWholeDay, wheelPixels, zoomFactor } from '../../lib/chartView';
import './FuelChart.scss';

const HHMM = new Intl.DateTimeFormat('en-KE', { hour: '2-digit', minute: '2-digit', hour12: false });
const DDMM = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short' });
const fmtTime = (ms) => (Number.isFinite(ms) ? HHMM.format(ms) : '-');
const fmtDate = (ms) => (Number.isFinite(ms) ? DDMM.format(ms) : '-');
/** A time with its day, for a chart of several days. */
const fmtDayTime = (ms) => (Number.isFinite(ms) ? `${DDMM.format(ms)} ${HHMM.format(ms)}` : '-');
const num = (n, digits = 0) => (n == null || !Number.isFinite(n)
  ? '-'
  : Number(n).toLocaleString('en-KE', { maximumFractionDigits: digits }));

// Nearest item to `t` in a time-ordered array (binary search)
function nearestByT(arr, t) {
  if (!arr.length) return null;
  let lo = 0, hi = arr.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid; else hi = mid;
  }
  return Math.abs(arr[lo].t - t) <= Math.abs(arr[hi].t - t) ? arr[lo] : arr[hi];
}

const MIN_ZOOM_MS     = 10 * 60_000;  // narrowest stretch a drag can zoom to
const WHEEL_MIN_MS    = 5 * 60_000;   // narrowest the wheel goes: ~20 readings
const READING_NEAR_MS = 15 * 60_000;  // a fuel reading further off than this is "none"
const ENGINE_GAP_MS   = 15 * 60_000;  // silence longer than this breaks the engine strip
const FUEL_COLOR      = '#f59e0b';    // amber
const SPEED_COLOR     = '#0ea5e9';    // sky blue
const OVERSPEED_COLOR = '#b91c1c';
const ENGINE_ON       = '#16a34a';
const ENGINE_OFF      = '#cbd5e1';

/** Runs of one engine state, broken where the unit went quiet. */
function engineRuns(pings) {
  const out = [];
  let cur = null;
  for (const p of pings) {
    if (p.engineOn == null || !Number.isFinite(p.t)) continue;
    if (cur && p.t - cur.end > ENGINE_GAP_MS) { out.push(cur); cur = null; }
    if (cur && p.engineOn !== cur.on) { cur.end = p.t; out.push(cur); cur = null; }
    if (!cur) cur = { on: p.engineOn, start: p.t, end: p.t };
    else cur.end = p.t;
  }
  if (cur) out.push(cur);
  return out;
}

/** "at 14:02" or "14:02–14:30"; over several days the day goes in once. */
function spanText(a, b, withDate = false) {
  if (!withDate) return fmtTime(a) === fmtTime(b) ? `at ${fmtTime(a)}` : `${fmtTime(a)}–${fmtTime(b)}`;
  if (fmtDate(a) !== fmtDate(b)) return `${fmtDayTime(a)}–${fmtDayTime(b)}`;
  return fmtTime(a) === fmtTime(b) ? `${fmtDate(a)} at ${fmtTime(a)}` : `${fmtDate(a)}, ${fmtTime(a)}–${fmtTime(b)}`;
}

const chipWidth = (n) => 7 + String(n).length * 4.4;
const CHIP_NUDGE_MAX = 16;   // px a numbered mark may sit off the middle of its band

/**
 * Where each numbered mark goes, given `marks` [{ e, cx }] with cx the middle
 * of the event's band, inside [lo, hi].
 *
 * Marks that would sit on each other are nudged apart while every one still
 * fits within a few pixels of its band: a refill and the FUEL DOWN that
 * starts the minute it ends (KDE 585S, 27 Sep) are 8 px apart at a day's
 * zoom, and the second mark used to be left off, so the event looked
 * unplotted. On a day too crowded for that, a mark that would sit on its
 * neighbour is still left off — its band shows, and the list and a zoom both
 * name it. `keepId` is never left off.
 */
function placeChips(marks, lo, hi, keepId) {
  const sorted = [...marks].sort((a, b) => a.cx - b.cx);
  if (sorted.length < 2) return sorted.map(m => ({ ...m, at: m.cx }));
  const gap = (a, b) => (chipWidth(a.e.n) + chipWidth(b.e.n)) / 2 + 1.5;
  const xs = sorted.map(m => m.cx);
  for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + gap(sorted[i - 1], sorted[i]));
  for (let i = xs.length - 1; i >= 0; i--) {
    xs[i] = Math.min(xs[i], i === xs.length - 1 ? hi : xs[i + 1] - gap(sorted[i], sorted[i + 1]));
  }
  if (xs[0] >= lo && xs.every((v, i) => Math.abs(v - sorted[i].cx) <= CHIP_NUDGE_MAX)) {
    return sorted.map((m, i) => ({ ...m, at: m.cx, cx: xs[i] }));
  }
  const out = [];
  let lastX = -Infinity;
  for (const m of sorted) {
    if (m.cx - lastX < 12 && m.e.id !== keepId) continue;
    out.push({ ...m, at: m.cx });
    lastX = m.cx;
  }
  return out;
}

// `unit` is '%' when the tank size is known, else 'L' (litres, scaled to the day).
// `pings` supply speed and ignition for the readout. `episodes` are the day's
// ledger events placed on its tank line (hooks/useVehicleFuelEvents
// useFuelEpisodes); `focus` is { id, seq } of one to open; `showList` adds the
// numbered event list; `limitText` is the overspeed limit as the legend
// should state it. `withDate` is for a range of days (the Fuel tab's picker):
// every time shown carries its day, and `dayStarts` (ms) draw a line at each
// midnight.
export default function FuelChart({
  series, unit = '%', loading, overspeeds = [], dayLabel = 'today', pings = [], limit = 80,
  reservePct = 25, episodes = [], focus = null, showList = false, limitText = null,
  withDate = false, dayStarts = [], speedOnly = false, tall = false,
}) {
  // Speed only (the Overview, operator 2026-10-02: fuel belongs to the Fuel
  // tab): no fuel line or fuel events; a limit line and a km/h axis instead,
  // and the speed drawn red wherever it runs over.
  if (speedOnly) { series = []; episodes = []; }
  const speeds = useMemo(() => pings.filter(p => Number.isFinite(p.speedKmh)).map(p => ({ t: p.t, v: p.speedKmh })), [pings]);
  if (loading) return <div className="vdp-empty">Loading {speedOnly ? 'speed' : 'fuel'} readings…</div>;
  // A unit with no fuel probe still gets the chart, drawn from its speed alone
  if (series.length < 2 && speeds.length < 2) return <div className="vdp-empty">No readings for this unit {dayLabel}.</div>;
  return (
    <FuelChartPlot
      series={series} speeds={speeds} unit={unit} overspeeds={overspeeds} pings={pings} limit={limit}
      reservePct={reservePct} episodes={episodes} focus={focus} showList={showList} limitText={limitText}
      withDate={withDate} dayStarts={dayStarts} speedOnly={speedOnly} tall={tall}
    />
  );
}

/** An event's own name where it has one (FUEL DOWN, FUEL RATE), else its kind's. */
const nameOf = (e) => e.label ?? FUEL_EVENT_KINDS[e.kind].label;
/** FUEL RATE / FUEL DOWN to the tenth of a litre, as their alert gives it; the rest to the litre. */
const litresText = (e) => `${num(e.litres, e.kind === 'drop' ? 1 : 0)} L`;

/** Whether this screen has a mouse, so the hint can offer the wheel. */
const hasWheel = () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(hover: hover) and (pointer: fine)').matches);

function FuelChartPlot({ series, speeds, unit, overspeeds, pings, limit, reservePct, episodes, focus, showList, limitText, withDate, dayStarts, speedOnly, tall }) {
  const when = withDate ? fmtDayTime : fmtTime;   // a moment, with its day over a range
  const spanOf = (a, b) => spanText(a, b, withDate);
  const svgRef = useRef(null);
  const overClip = `vdp-over-${useId().replace(/:/g, "")}`;   // one per chart: two on a page shared one limit
  const [cursor, setCursor] = useState(null);     // ms under the pointer, or null
  const [pinnedRun, setPinnedRun] = useState(null);
  const [pinnedId, setPinnedId] = useState(null); // a fuel event zoomed to, by id
  const [chipId, setChipId] = useState(null);     // a numbered mark under the pointer
  const [hidden, setHidden] = useState(() => new Set());
  const [zoom, setZoom] = useState(null);         // [from, to] ms, or null = whole day
  const [drag, setDrag] = useState(null);         // { a, b } ms while mouse-dragging
  const dragRef = useRef(null);                   // same, readable between renders

  const pct = unit === '%';
  // Taller on the Fuel tab, where the chart has the section to itself
  const W = 320, H = tall ? 210 : 150, PL = 24, PT = 18, PB = 28;
  const cW = W - PL, cH = H - PT - PB;
  const stripY = PT + cH + 4, stripH = 4;
  const hasFuel = series.length >= 2;
  // "Over 80 km/h", or "Over limit (60–100 by zone)": short enough that the
  // legend holds one line in the panel
  const limitWords = String(limitText ?? limit);
  const overText = /^\d+$/.test(limitWords) ? `Over ${limitWords} km/h` : `Over limit (${limitWords})`;
  const ends =[series[0]?.t, series[series.length - 1]?.t, speeds[0]?.t, speeds[speeds.length - 1]?.t].filter(Number.isFinite);
  const dayT0 = Math.min(...ends), dayT1 = Math.max(...ends);
  const [t0, t1] = zoom ?? [dayT0, dayT1];
  const span = Math.max(1, t1 - t0);
  const visible = useMemo(() => series.filter(p => p.t >= t0 && p.t <= t1), [series, t0, t1]);
  // Litres: the top of the axis is the day's highest reading, rounded up.
  const top = useMemo(
    () => (pct ? 100 : Math.max(10, Math.ceil(series.reduce((m, p) => Math.max(m, p.v), 0) / 10) * 10)),
    [pct, series],
  );
  // Speed shares the plot on its own scale (right-hand axis), up to the day's
  // top speed or a little over the limit, whichever is higher.
  const sTop = useMemo(
    () => Math.max(20, Math.ceil(Math.max(limit * 1.25, speeds.reduce((m, p) => Math.max(m, p.v), 0)) / 20) * 20),
    [limit, speeds],
  );
  const engine = useMemo(() => engineRuns(pings), [pings]);
  const x = (t) => PL + ((t - t0) / span) * cW;
  const y = (v) => PT + cH - (Math.min(top, Math.max(0, v)) / top) * cH;
  const ys = (v) => PT + cH - (Math.min(sTop, Math.max(0, v)) / sTop) * cH;

  // Thin to ~160 points so a busy day stays light to draw
  const step = Math.max(1, Math.floor(visible.length / 160));
  const pts = visible.filter((_, i) => i % step === 0 || i === visible.length - 1);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = pts.length ? `${line} L${x(pts[pts.length - 1].t)},${PT + cH} L${x(pts[0].t)},${PT + cH} Z` : '';
  const reserveY = y(reservePct);
  const cross = pct && pts.find((p, i) => i > 0 && pts[i - 1].v >= reservePct && p.v < reservePct);
  const runs = overspeeds.filter(o => o.end >= t0 && o.start <= t1);
  const sVisible = speeds.filter(p => p.t >= t0 && p.t <= t1);
  const sStep = Math.max(1, Math.floor(sVisible.length / 240));
  const speedLine = sVisible
    .filter((_, i) => i % sStep === 0 || i === sVisible.length - 1)
    .map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${ys(p.v).toFixed(1)}`).join(' ');
  // Midnights in view, a line at least 14 apart: every day over a fortnight,
  // every few as the range widens, so 90 days reads as weeks, not hatching
  const midnights = [];
  let lastLine = -Infinity, lastLabel = -Infinity;
  for (const s of dayStarts) {
    if (s <= t0 || s >= t1 || x(s) - lastLine < 14) continue;
    lastLine = x(s);
    const label = x(s) - lastLabel > 34 && x(s) < W - 66;
    if (label) lastLabel = x(s);
    midnights.push({ s, label });
  }

  // ── fuel events ────────────────────────────────────────────────────────
  const counts = useMemo(() => {
    const c = {};
    for (const e of episodes) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  }, [episodes]);
  const shown = episodes.filter(e => !hidden.has(e.kind));
  const inView = shown.filter(e => e.end >= t0 && e.start <= t1);
  const byId = (id) => (id == null ? null : episodes.find(e => e.id === id) ?? null);
  const pinned = byId(pinnedId);
  const chipped = byId(chipId);
  /** The event whose band `t` falls in; the narrowest where bands overlap. */
  const eventAt = (t) => {
    let best = null;
    for (const e of inView) {
      if (t < e.start - 60_000 || t > e.end + 60_000) continue;
      if (!best || e.end - e.start < best.end - best.start) best = e;
    }
    return best;
  };
  // Numbered marks over the middle of each band, nudged apart where they
  // would collide — see placeChips.
  const chips = placeChips(
    inView.map(e => ({ e, cx: Math.min(W - 6, Math.max(PL + 6, x((Math.max(e.start, t0) + Math.min(e.end, t1)) / 2))) })),
    PL + 6, W - 6, pinnedId,
  );

  // Pointer position -> time, clamped to the plotted window
  const tAt = (clientX) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || !r.width) return null;
    const vx = ((clientX - r.left) / r.width) * W;
    return Math.round(t0 + ((Math.min(W, Math.max(PL, vx)) - PL) / cW) * span);
  };

  const zoomToEpisode = (e) => {
    const pad = Math.max(10 * 60_000, (e.end - e.start) * 0.75);
    setZoom([e.start - pad, e.end + pad]);
    setPinnedId(e.id);
    setPinnedRun(null);
    setCursor(null);
  };
  // An event picked outside the chart opens here, its kind switched back on
  // if the legend had hidden it. Keyed on the request, not on the events: a
  // live refresh of the day must not yank the view back to it.
  useEffect(() => {
    const e = focus ? episodes.find(x => x.ids?.includes(focus.id) || x.id === focus.id) : null;
    if (!e) return;
    setHidden(h => (h.has(e.kind) ? new Set([...h].filter(k => k !== e.kind)) : h));
    zoomToEpisode(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);
  /* The mouse wheel. Attached by hand because React's onWheel is passive and
     cannot stop the panel scrolling under the chart. It only takes the wheel
     when the view moves: rolling out at the whole day, or on past an end of
     it, scrolls the panel as it would anywhere else, so the chart never traps
     a reader scrolling down past it. Ctrl + wheel, which is a trackpad pinch,
     zooms too rather than zooming the page. */
  const wheelRef = useRef(null);
  wheelRef.current = {
    view: [t0, t1],
    day: [dayT0, dayT1],
    frac: (clientX, r) => Math.min(1, Math.max(0, (((clientX - r.left) / r.width) * W - PL) / cW)),
    plotPx: (r) => (cW / W) * r.width,
  };
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      const { view, day, frac, plotPx } = wheelRef.current;
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const f = frac(e.clientX, r);
      const at = view[0] + f * (view[1] - view[0]);
      const px = wheelPixels(e);
      const next = Math.abs(px.x) > Math.abs(px.y)
        ? panView(view, day, (px.x / plotPx(r)) * (view[1] - view[0]))
        : zoomView(view, day, at, zoomFactor(px.y), WHEEL_MIN_MS);
      if (!next) return;
      e.preventDefault();
      setZoom(isWholeDay(next, day) ? null : next);
      setCursor(Math.round(next[0] + f * (next[1] - next[0])));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onPointerDown = (e) => {
    const t = tAt(e.clientX);
    if (t == null) return;
    setPinnedRun(null);
    if (e.pointerType === 'mouse') {
      if (e.button === 0) { dragRef.current = { a: t, b: t }; setDrag(dragRef.current); }
    }
    else setCursor(t);
  };
  const onPointerMove = (e) => {
    const t = tAt(e.clientX);
    if (t == null) return;
    setCursor(t);
    if (dragRef.current) { dragRef.current = { ...dragRef.current, b: t }; setDrag(dragRef.current); }
  };
  const onPointerUp = () => {
    const d = dragRef.current;
    if (!d) return;
    const a = Math.min(d.a, d.b), b = Math.max(d.a, d.b);
    dragRef.current = null;
    setDrag(null);
    // A drag has to cover a real stretch of time to zoom; a click inside a
    // band opens that event.
    if (b - a >= Math.max(MIN_ZOOM_MS, span * 0.03)) { setZoom([a, b]); return; }
    const hit = eventAt(d.b);
    if (hit) zoomToEpisode(hit);
  };
  const onLeave = (e) => {
    if (e.pointerType === 'mouse') { setCursor(null); dragRef.current = null; setDrag(null); }
  };
  const onKeyDown = (e) => {
    const stepMs = Math.max(60_000, span / 60);
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();   // the panel uses ← → to step tracked units
      const from = cursor ?? (e.key === 'ArrowRight' ? t0 : t1);
      setCursor(Math.min(t1, Math.max(t0, from + (e.key === 'ArrowRight' ? stepMs : -stepMs))));
    } else if (['+', '=', '-', '_'].includes(e.key)) {
      // The wheel's zoom from the keyboard, about the cursor
      e.preventDefault();
      const next = zoomView([t0, t1], [dayT0, dayT1], cursor ?? (t0 + t1) / 2,
        e.key === '-' || e.key === '_' ? 1.5 : 1 / 1.5, WHEEL_MIN_MS);
      if (next) setZoom(isWholeDay(next, [dayT0, dayT1]) ? null : next);
    } else if (e.key === 'Escape' && (cursor != null || pinnedRun || pinnedId)) {
      e.stopPropagation();   // clear the cursor first; the next Escape closes the panel
      setCursor(null);
      setPinnedRun(null);
      setPinnedId(null);
    }
  };
  const zoomOut = () => { setZoom(null); setPinnedRun(null); setPinnedId(null); };
  const zoomToRun = (o) => {
    const pad = Math.max(5 * 60_000, (o.end - o.start) * 2);
    setZoom([Math.max(dayT0, o.start - pad), Math.min(dayT1, o.end + pad)]);
    setPinnedRun(o);
    setPinnedId(null);
    setCursor(null);
  };
  const toggleKind = (k) => setHidden(h => {
    const next = new Set(h);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  const fuelAt = cursor != null ? nearestByT(series, cursor) : null;
  const fuelNear = fuelAt && Math.abs(fuelAt.t - cursor) <= READING_NEAR_MS ? fuelAt : null;
  const pingAt = cursor != null ? nearestByT(pings, cursor) : null;
  const runAt = pinnedRun ?? (cursor != null ? runs.find(o => cursor >= o.start - 60_000 && cursor <= o.end + 60_000) : null);
  const eventUnder = cursor != null ? eventAt(cursor) : null;
  const active = pinned ?? chipped ?? null;           // the event the readout names
  const lit = active ?? (runAt ? null : eventUnder);  // the band drawn stronger
  /* A reading in litres, which is what the operator reads a tank in. `l` is
     on every point (lib/vehicleDay); % is the fallback for a series built
     without it. Tenths below 100 L, where a few litres is a real share. */
  const litresOf = (p) => {
    const l = p.l ?? (pct ? null : p.v);
    return l == null ? `${Math.round(p.v)}%` : `${num(l, l < 100 ? 1 : 0)} L`;
  };
  const fuelText = (p) => (pct && p.l != null ? `${litresOf(p)} (${Math.round(p.v)}%)` : litresOf(p));

  const eventReadout = (e) => {
    const k = FUEL_EVENT_KINDS[e.kind];
    return (
      <span className="fc-readout-ep">
        <i className="fc-dot" style={{ background: k.color }} />
        <b>{e.n}. {nameOf(e)}{e.pending ? ' (not yet checked)' : ''}</b>
        <span>{spanOf(e.start, e.end)}</span>
        {e.litres != null && <span>{litresText(e)}</span>}
        <span className="fc-readout-detail">{e.detail}{e.reports > 1 ? ` (reported ${e.reports} times)` : ''}</span>
      </span>
    );
  };

  let readout;
  if (active) {
    readout = eventReadout(active);
  } else if (runAt) {
    const mins = Math.round((runAt.end - runAt.start) / 60_000);
    readout = (
      <span className="vdp-readout-run">
        Overspeed {spanOf(runAt.start, runAt.end)} · max {Math.round(runAt.max)} km/h{Number.isFinite(runAt.limit) ? ` (limit ${runAt.limit})` : ''}{mins >= 1 ? ` · ${mins} min` : ''}
      </span>
    );
  } else if (cursor != null) {
    const k = eventUnder ? FUEL_EVENT_KINDS[eventUnder.kind] : null;
    readout = (<>
      <b>{when(cursor)}</b>
      {hasFuel && <span>{fuelNear ? fuelText(fuelNear) : 'no fuel reading'}</span>}
      {pingAt && Number.isFinite(pingAt.speedKmh) && <span>{Math.round(pingAt.speedKmh)} km/h</span>}
      {pingAt && pingAt.engineOn != null && <span>engine {pingAt.engineOn ? 'on' : 'off'}</span>}
      {eventUnder && (
        <span className="fc-readout-under">
          <i className="fc-dot" style={{ background: k.color }} />{eventUnder.n}. {nameOf(eventUnder)}
        </span>
      )}
    </>);
  } else {
    const tips = [episodes.length ? 'tap a numbered mark for the fuel event' : null, runs.length ? 'a red mark on the strip for the overspeed' : null]
      .filter(Boolean);
    const what = hasFuel ? 'the litres' : 'it';
    readout = (
      <span className="vdp-readout-hint">
        {hasWheel() ? `Hover to read ${what}, scroll to zoom` : `Slide along the chart to read ${what}`}
        {tips.length ? ` · ${tips.join(', ')}` : ''}
      </span>
    );
  }

  // The crosshair's label: the litres at the reading under it, beside the
  // line and level with the dot, turned to the left once past the middle so
  // it never runs off the panel.
  const tipAt = fuelNear ? y(fuelNear.v) : PT + cH / 2;
  const tip = cursor != null && hasFuel && (
    <div
      className={`fc-tip${x(cursor) > PL + cW * 0.6 ? ' fc-tip--left' : ''}`}
      style={{ left: `${(x(cursor) / W) * 100}%`, top: `${(Math.min(PT + cH - 12, Math.max(PT + 12, tipAt)) / H) * 100}%` }}
      aria-hidden="true"
    >
      <b>{fuelNear ? litresOf(fuelNear) : 'No fuel reading'}</b>
      <span>{when(fuelNear?.t ?? cursor)}{fuelNear && pct && fuelNear.l != null ? ` · ${Math.round(fuelNear.v)}% of tank` : ''}</span>
    </div>
  );

  const cx = cursor != null ? x(cursor) : null;
  const clipX = PL, clipW = cW;
  return (
    <div className="vdp-chart-wrap">
      <div className="fc-plot">
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          className={`vdp-chart vdp-chart--live${drag ? ' vdp-chart--dragging' : ''}`}
          tabIndex={0}
          role="img"
          aria-label={`${hasFuel ? 'Fuel level and speed' : 'Speed'} from ${when(t0)} to ${when(t1)}`
            + `${episodes.length ? `, with ${episodes.length} fuel event${episodes.length === 1 ? '' : 's'} marked` : ''}. Use the arrow keys to read values, plus and minus to zoom.`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onLeave}
          onDoubleClick={zoomOut}
          onKeyDown={onKeyDown}
        >
          <defs>
            <clipPath id="vdp-plot-clip"><rect x={clipX} y={0} width={clipW} height={H} /></clipPath>
            {speedOnly && <clipPath id={overClip}><rect x={clipX} y={0} width={clipW} height={Math.max(0, ys(limit))} /></clipPath>}
          </defs>
          {[top, top / 2, 0].map(p => (
            <g key={p}>
              <line x1={PL} y1={y(p)} x2={W} y2={y(p)} stroke="#eef1f4" strokeWidth="1" />
              {hasFuel && <text x={0} y={y(p) + 3} fontSize="8" fill="#94a3b8">{Math.round(p)}</text>}
              {speedOnly && <text x={0} y={y(p) + 3} fontSize="8" fill="#94a3b8">{Math.round((p / top) * sTop)}</text>}
            </g>
          ))}
          {speedOnly
            ? <text x={W - 2} y={PT - 6} fontSize="7.5" fill="#94a3b8" textAnchor="end">km/h</text>
            : <text x={W - 2} y={PT + 8} fontSize="7.5" fill="#94a3b8" textAnchor="end">{sTop} km/h</text>}
          <g clipPath="url(#vdp-plot-clip)">
            {/* fuel events, behind everything drawn on the plot */}
            {inView.map(e => {
              const k = FUEL_EVENT_KINDS[e.kind];
              const x0 = x(Math.max(e.start, t0 - span)), x1 = x(Math.min(e.end, t1 + span));
              const strong = lit?.id === e.id;
              return (
                <rect key={e.id} x={x0} y={PT} width={Math.max(2, x1 - x0)} height={cH} fill={k.color}
                      opacity={strong ? 0.3 : e.pending ? 0.08 : 0.15}
                      stroke={e.pending ? k.color : 'none'} strokeDasharray={e.pending ? '2 2' : undefined} strokeWidth="0.8" />
              );
            })}
            {/* midnights over a range of days, dated where there is room — clear
              of the last date and of the km/h label top right */}
          {midnights.map(({ s, label }) => (
            <g key={s} pointerEvents="none">
              <line x1={x(s)} y1={PT} x2={x(s)} y2={PT + cH} stroke="#cbd5e1" strokeWidth="0.8" strokeDasharray="3 2" />
              {label && <text x={x(s) + 2} y={PT + 8} fontSize="7" fill="#94a3b8">{fmtDate(s)}</text>}
            </g>
          ))}
          {speedOnly && (
            <g pointerEvents="none">
              <path d={`${speedLine} L${x(sVisible[sVisible.length - 1]?.t ?? t1)},${PT + cH} L${x(sVisible[0]?.t ?? t0)},${PT + cH} Z`} fill="rgba(14,165,233,0.08)" />
              <line x1={PL} y1={ys(limit)} x2={W} y2={ys(limit)} stroke={OVERSPEED_COLOR} strokeWidth="1" strokeDasharray="4 3" />
            </g>
          )}
          <path d={speedLine} fill="none" stroke={SPEED_COLOR} strokeWidth={speedOnly ? 1.6 : 1.2} strokeLinejoin="round" opacity={speedOnly ? 1 : 0.85} />
          {speedOnly && (
            <path d={speedLine} fill="none" stroke={OVERSPEED_COLOR} strokeWidth="2" strokeLinejoin="round" clipPath={`url(#${overClip})`} pointerEvents="none" />
          )}
            {hasFuel && <path d={area} fill="rgba(245,158,11,0.10)" />}
            {pct && hasFuel && <line x1={PL} y1={reserveY} x2={W} y2={reserveY} stroke="#b91c1c" strokeWidth="1" strokeDasharray="4 3" />}
            {hasFuel && <path d={line} fill="none" stroke={FUEL_COLOR} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />}
            {cross && <circle cx={x(cross.t)} cy={y(cross.v)} r="3.5" fill="#b91c1c" />}
            {runAt && (
              <rect x={x(runAt.start)} y={PT} width={Math.max(2, x(runAt.end) - x(runAt.start))} height={cH} fill={OVERSPEED_COLOR} opacity="0.12" pointerEvents="none" />
            )}
            {/* the strip: engine on / off, overspeed runs on top of it */}
            <rect x={PL} y={stripY} width={cW} height={stripH} fill="#f1f5f9" />
            {/* keyed by position too: an ignition that flaps within one second
                (KDE 585S) starts two runs of the same state at the same time */}
            {engine.filter(r => r.end >= t0 && r.start <= t1).map((r, i) => (
              <rect key={`${r.start}-${r.on}-${i}`} x={x(r.start)} y={stripY} width={Math.max(1, x(r.end) - x(r.start))} height={stripH}
                    fill={r.on ? ENGINE_ON : ENGINE_OFF} opacity={r.on ? 0.75 : 1} pointerEvents="none" />
            ))}
            {runs.map((o, i, arr) => {
              // label only when there's room since the previous mark
              const showLabel = i === 0 || x(o.start) - x(arr[i - 1].start) > 26;
              const on = runAt === o;
              return (
                <g key={o.start} className="vdp-run"
                   onPointerDown={(e) => e.stopPropagation()}
                   onClick={(e) => { e.stopPropagation(); zoomToRun(o); }}>
                  <rect x={x(o.start)} y={stripY - 1.5} width={Math.max(2.5, x(o.end) - x(o.start))} height={stripH + 3} fill={OVERSPEED_COLOR} opacity={on ? 1 : 0.85} />
                  {/* a wider, invisible target so a finger can hit the mark */}
                  <rect x={x(o.start) - 8} y={stripY - 8} width={Math.max(16, x(o.end) - x(o.start) + 16)} height="16" fill="transparent" />
                  {showLabel && <text x={x(o.start) + 3} y={stripY - 3} fontSize="7" fill={OVERSPEED_COLOR}>{Math.round(o.max)}</text>}
                </g>
              );
            })}
            {drag && (
              <rect x={x(Math.min(drag.a, drag.b))} y={PT} width={Math.abs(x(drag.b) - x(drag.a))} height={cH} fill="rgba(37,99,235,0.12)" />
            )}
            {cx != null && (
              <g pointerEvents="none">
                <line x1={cx} y1={PT} x2={cx} y2={PT + cH} stroke="#334155" strokeWidth="0.8" />
                {fuelNear && (
                  <line x1={PL} y1={y(fuelNear.v)} x2={W} y2={y(fuelNear.v)} stroke="#334155" strokeWidth="0.6" strokeDasharray="2 2" opacity="0.55" />
                )}
                {fuelNear && <circle cx={x(fuelNear.t)} cy={y(fuelNear.v)} r="3" fill="#fff" stroke={FUEL_COLOR} strokeWidth="1.5" />}
                {pingAt && Number.isFinite(pingAt.speedKmh) && Math.abs(pingAt.t - cursor) <= READING_NEAR_MS && (
                  <circle cx={x(pingAt.t)} cy={ys(pingAt.speedKmh)} r="2.5" fill="#fff" stroke={SPEED_COLOR} strokeWidth="1.2" />
                )}
              </g>
            )}
          </g>
          {/* numbered marks, one per fuel event, in the row above the plot */}
          {chips.map(({ e, cx: mx, at }) => {
            const k = FUEL_EVENT_KINDS[e.kind];
            const label = String(e.n);
            const w = chipWidth(e.n);
            // The pointer under a nudged mark still leans toward its band
            const tip = Math.min(mx + w / 2 - 2.5, Math.max(mx - w / 2 + 2.5, at));
            const strong = lit?.id === e.id;
            return (
              <g key={e.id} className="fc-chip" role="button" tabIndex={0}
                 aria-label={`Fuel event ${e.n}: ${nameOf(e)}, ${spanOf(e.start, e.end)}${e.litres != null ? `, ${num(e.litres, 1)} litres` : ''}`}
                 onPointerDown={(ev) => ev.stopPropagation()}
                 onPointerEnter={() => setChipId(e.id)}
                 onPointerLeave={() => setChipId(c => (c === e.id ? null : c))}
                 onClick={(ev) => { ev.stopPropagation(); zoomToEpisode(e); }}
                 onKeyDown={(ev) => {
                   if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ev.stopPropagation(); zoomToEpisode(e); }
                 }}>
                <rect x={mx - w / 2 - 3} y={0} width={w + 6} height={PT} fill="transparent" />
                <rect x={mx - w / 2} y={2} width={w} height={11} rx="3" fill={k.color} opacity={strong || !lit ? 1 : 0.55}
                      stroke={strong ? '#0f172a' : 'none'} strokeWidth="0.8" />
                <text x={mx} y={10.4} fontSize="7.5" fontWeight="600" fill="#fff" textAnchor="middle" pointerEvents="none">{label}</text>
                <path d={`M${tip - 2.5},13 L${tip + 2.5},13 L${tip},16 Z`} fill={k.color} opacity={strong || !lit ? 1 : 0.55} pointerEvents="none" />
              </g>
            );
          })}
          {pct && hasFuel && <text x={PL + 4} y={reserveY - 4} fontSize="8" fill="#b91c1c" pointerEvents="none">reserve {reservePct}%</text>}
          {speedOnly && <text x={PL + 4} y={ys(limit) - 4} fontSize="8" fill="#b91c1c" pointerEvents="none">limit {/^\d+$/.test(limitWords) ? `${limitWords} km/h` : limitWords}</text>}
          <text x={PL} y={H - 3} fontSize="8" fill="#94a3b8">{when(t0)}</text>
          <text x={W} y={H - 3} fontSize="8" fill="#94a3b8" textAnchor="end">{when(t1)}</text>
        </svg>
        {tip}
      </div>
      <div className="vdp-readout" aria-live="polite">
        <span className="vdp-readout-vals">{readout}</span>
        {zoom && <button type="button" className="vdp-readout-reset" onClick={zoomOut}>{withDate ? 'All days' : 'Whole day'}</button>}
      </div>
      <div className="vdp-legend fc-legend">
        {hasFuel && <span><i className="vdp-legend-line" /> Fuel level ({pct ? '%' : 'litres'})</span>}
        <span><i className="vdp-legend-speed" /> Speed</span>
        <span><i className="fc-swatch fc-swatch--bar" style={{ background: OVERSPEED_COLOR }} /> {overText}</span>
        <span><i className="fc-swatch fc-swatch--bar" style={{ background: ENGINE_ON }} /> Engine on</span>
      </div>
      {episodes.length > 0 && (
        <div className="fc-toggles" role="group" aria-label="Fuel events: show or hide each kind">
          {FUEL_EVENT_ORDER.filter(k => counts[k]).map(k => (
            <button key={k} type="button" className={`fc-toggle${hidden.has(k) ? ' fc-toggle--off' : ''}`}
                    aria-pressed={!hidden.has(k)} onClick={() => toggleKind(k)}>
              <i className="fc-dot" style={{ background: FUEL_EVENT_KINDS[k].color }} />
              {FUEL_EVENT_KINDS[k].label}
              <b>{counts[k]}</b>
            </button>
          ))}
        </div>
      )}
      {showList && shown.length > 0 && (
        <ol className="fc-list" aria-label="Fuel events">
          {shown.map(e => {
            const k = FUEL_EVENT_KINDS[e.kind];
            return (
              <li key={e.id}>
                <button type="button" className={`fc-row${pinnedId === e.id ? ' fc-row--on' : ''}`} onClick={() => zoomToEpisode(e)}>
                  <span className="fc-row-n" style={{ background: k.color }}>{e.n}</span>
                  <span className="fc-row-main">
                    <span className="fc-row-head">
                      <b>{nameOf(e)}{e.pending ? ' (not yet checked)' : ''}</b>
                      <span>{spanOf(e.start, e.end)}</span>
                      {e.litres != null && <span>{litresText(e)}</span>}
                    </span>
                    <span className="fc-row-detail">{e.detail}{e.reports > 1 ? ` (reported ${e.reports} times)` : ''}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
