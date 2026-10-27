/**
 * Fuel › Report › Statistics & events — the two tabs that used to split one
 * question ("what did the tank do?") into a list of numbers and a list of
 * rows, merged into one page that answers it at a glance first:
 *
 *   1. One band of three — how full the tank ended and how much of the
 *      period the engine ran (flat meters on their own scales), and how the
 *      period divided between moving, parked and the rest (one split bar).
 *   2. The fuel events — a rail of the kinds (Analytics > Fleet state's
 *      rail: one bar, each segment its share of the litres, and the segments
 *      filter the table under it), then every filling and drain.
 *   3. The figures the pictures do not carry, as a compact list.
 *
 * No figure appears twice. The page's KPI strip already reads the tank's
 * balance (start + filled − possible theft − consumed = end), so nothing here
 * repeats a litre of it: the old "where the fuel went" donut was that strip
 * drawn round, the gauge gives the end level as a share of the tank, and the
 * rail's keys carry counts and shares, with litres left to the strip, the
 * tooltip and the table's own rows.
 *
 * Every number is read off the report as lib/fuelReport built it; nothing is
 * estimated here. Where a figure is missing (no fuel readings, no tank size on
 * record) the picture says so instead of drawing a guess.
 */

import { useState } from "react";
import { durationLabel } from "../../lib/fuelReport";

const H = 3_600_000;

// ── geometry ───────────────────────────────────────────────────────────────

const polar = (cx, cy, r, deg) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};

/** A ring segment from a0 to a1 degrees (0 = 12 o'clock, clockwise). */
function arcPath(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0);
  const [x1, y1] = polar(cx, cy, r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1}`;
}

// ── meter and split ────────────────────────────────────────────────────────

const share = (x) => `${Math.min(1, Math.max(0, x ?? 0)) * 100}%`;

/**
 * One ratio as a flat meter on its own scale: the figure, a track with the
 * fill and an optional tick for a second reading (where the tank started),
 * and the scale's two ends under it — so "88%" is read against "0 – 273.7 L",
 * not against a dial's sweep.
 */
function Meter({ ratio, tick, tone, value, unit, lo, hi, ariaLabel }) {
  return (
    <div className="frv-meter" role="img" aria-label={ariaLabel}>
      <p className="frv-meter__fig"><b>{value}</b> {unit}</p>
      <div className="frv-meter__track">
        <span className={`frv-meter__fill frv-meter__fill--${tone}`} style={{ width: share(ratio) }} />
        {tick != null && <span className="frv-meter__tick" style={{ left: share(tick) }} />}
      </div>
      <p className="frv-meter__scale"><span>{lo}</span><span>{hi}</span></p>
    </div>
  );
}

/**
 * Parts of one whole as a single bar, each part its share of the length, with
 * the rows under it carrying every name and value — no part is read by colour
 * alone. Hovering a part or its row lifts it and dims the rest.
 */
function Split({ parts, unit, ariaLabel }) {
  const [hot, setHot] = useState(null);
  const whole = parts.reduce((n, p) => n + p.value, 0);
  const pct = (v) => (whole > 0 ? Math.round((v / whole) * 100) : 0);
  return (
    <div className="frv-split">
      <div className="frv-split__bar" role="img" aria-label={ariaLabel}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <span key={p.key} className={`frv-split__seg${hot && hot !== p.key ? " is-dim" : ""}`}
                style={{ flexGrow: p.value, background: p.color }}
                onMouseEnter={() => setHot(p.key)} onMouseLeave={() => setHot(null)}
                title={`${p.label}: ${p.display ?? p.value} ${unit} · ${pct(p.value)}%`} />
        ))}
      </div>
      <ul className="frv-legend">
        {parts.map((p) => (
          <li key={p.key} className={hot && hot !== p.key ? "frv-legend--dim" : ""}
              onMouseEnter={() => setHot(p.key)} onMouseLeave={() => setHot(null)}>
            <i style={{ background: p.color }} aria-hidden="true" />
            <span className="frv-legend__k">{p.label}</span>
            <span className="frv-legend__v">{p.display ?? p.value} {unit}</span>
            <span className="frv-legend__p">{pct(p.value)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── gauge ──────────────────────────────────────────────────────────────────

/**
 * A single ratio against a limit, as a 240° meter: a recessive track, one fill
 * from the same hue, an optional tick for a second reading (where the tank
 * started), and the figure in the middle.
 */
export function Gauge({ ratio, tick, color, value, unit, caption, ariaLabel }) {
  const size = 132; const r = 52; const c = size / 2; const stroke = 12;
  const START = -120; const SWEEP = 240;
  const clamp = (x) => Math.min(1, Math.max(0, x));
  const end = START + SWEEP * clamp(ratio ?? 0);
  const tickDeg = tick != null ? START + SWEEP * clamp(tick) : null;
  const [tx0, ty0] = tickDeg != null ? polar(c, c, r - stroke / 2 - 3, tickDeg) : [];
  const [tx1, ty1] = tickDeg != null ? polar(c, c, r + stroke / 2 + 3, tickDeg) : [];
  return (
    <svg className="frv-gauge" viewBox={`0 0 ${size} ${size - 22}`}
         role="img" aria-label={ariaLabel}>
      <path d={arcPath(c, c, r, START, START + SWEEP)} fill="none" className="frv-track"
            strokeWidth={stroke} strokeLinecap="round" />
      {ratio > 0 && (
        <path d={arcPath(c, c, r, START, Math.max(START + 0.5, end))} fill="none" stroke={color}
              strokeWidth={stroke} strokeLinecap="round" />
      )}
      {tickDeg != null && <line x1={tx0} y1={ty0} x2={tx1} y2={ty1} className="frv-gauge__tick" />}
      <text x={c} y={c + 2} textAnchor="middle" className="frv-donut__n">{value}</text>
      <text x={c} y={c + 18} textAnchor="middle" className="frv-donut__l">{unit}</text>
      {caption && <title>{caption}</title>}
    </svg>
  );
}

export function Card({ title, note, children, className = "" }) {
  return (
    <section className={`frv-card ${className}`}>
      <h3 className="frv-card__t">{title}</h3>
      {children}
      {note && <p className="frv-card__note">{note}</p>}
    </section>
  );
}

// ── the page ───────────────────────────────────────────────────────────────

export default function FuelReportOverview({
  report: r, unit, from, to, series, events, fmtNum, at, dropWord, onHoverAt,
}) {
  const s = r.stats;
  const n1 = (v) => fmtNum(v, 1);
  const n0 = (v) => fmtNum(v, 0);

  const haveLevel = s.fuelStartL != null && s.fuelEndL != null;

  // 2 · Tank level at the end, against the tank — or, with no size on
  // record, against the highest reading of the period, and labelled so.
  const levels = series.map((p) => p.fuelL).filter((v) => v != null);
  const peak = levels.length ? Math.max(...levels) : null;
  const capacity = Number(unit?.tankCapacityL) > 0 ? Number(unit.tankCapacityL) : null;
  const scale = capacity ?? peak;
  const endRatio = haveLevel && scale ? s.fuelEndL / scale : null;
  const startRatio = haveLevel && scale ? s.fuelStartL / scale : null;

  // 3 · Engine use: engine hours over the hours in the period.
  const periodH = Math.max(0, (to - from) / H);
  const engineRatio = periodH > 0 ? s.engineHours / periodH : null;

  // 4 · The period, divided. What is neither a trip nor a parking is stops
  // and the time the unit did not report.
  const otherH = Math.max(0, periodH - s.movingHours - s.parkingHours);
  const timeParts = [
    { key: "move", label: "Moving",             value: s.movingHours,  display: n1(s.movingHours),  color: "var(--frv-s1)" },
    { key: "park", label: "Parked",             value: s.parkingHours, display: n1(s.parkingHours), color: "var(--frv-s2)" },
    { key: "rest", label: "Stopped or silent",  value: otherH,         display: n1(otherH),         color: "var(--frv-neutral)" },
  ];

  // Litres by kind of event: fillings first (fuel in), then each kind of
  // drain, largest first. Colour follows the kind, never its rank: fillings
  // aqua, possible theft critical red, fuel that came back blue, every other
  // drain a grey. The three hues are validated against each other in any
  // order, so a rail whose order changes with the litres cannot put two
  // lookalikes side by side. Each segment is labelled, so no kind is read by
  // colour alone.
  const kindOf = (e) => (e.kind === "filling" ? "Filling" : dropWord(e));
  const kinds = new Map();
  for (const e of events) {
    const k = kindOf(e);
    const row = kinds.get(k) ?? {
      key: k, litres: 0, count: 0,
      tone: e.kind === "filling" ? "in" : e.theft ? "theft" : e.verdict === "REDISTRIBUTION" ? "back" : "out",
    };
    row.litres += e.volumeL ?? 0;
    row.count += 1;
    kinds.set(k, row);
  }
  const kindRows = [...kinds.values()].sort((a, b) =>
    (a.tone === "in" ? -1 : 0) - (b.tone === "in" ? -1 : 0) || b.litres - a.litres);
  const totalL = kindRows.reduce((n, k) => n + k.litres, 0);
  // Alternate the greys, so two neighbouring "other" kinds still part.
  let grey = 0;
  for (const k of kindRows) if (k.tone === "out") k.shade = grey++ % 2;

  const [kindFilter, setKindFilter] = useState(null);
  const [hotKind, setHotKind] = useState(null);
  const shownEvents = kindFilter ? events.filter((e) => kindOf(e) === kindFilter) : events;

  const consumption = [
    s.lPer100Km != null ? `${n1(s.lPer100Km)} L/100 km` : null,
    s.lPerHour != null ? `${n1(s.lPerHour)} L/h` : null,
  ].filter(Boolean).join(" · ") || "-";

  return (
    <div className="frv">
      {/* ── 1 · The period at a glance: one band, three cells ── */}
      <section className="frv-band" aria-label="The period at a glance">
        <div className="frv-band__cell">
          <h3 className="frv-h">Tank at the End</h3>
          {endRatio != null
            ? <Meter ratio={endRatio} tick={startRatio} tone="tank"
                     value={`${Math.round(endRatio * 100)}%`} unit={capacity ? "of the tank" : "of the peak"}
                     lo="0 L" hi={`${n1(scale)} L`}
                     ariaLabel={`Tank at ${Math.round(endRatio * 100)}% at the end of the period, ${n1(s.fuelEndL)} litres.`} />
            : <p className="frv-none">No fuel level to show.</p>}
          {haveLevel && (
            <p className="frv-band__note">
              <i className="frv-band__tick" aria-hidden="true" /> Started at {n1(s.fuelStartL)} L, ended at {n1(s.fuelEndL)} L
              {capacity ? `, of a ${n0(capacity)} L tank.` : ". No tank size on record, so the scale is the period's highest reading."}
            </p>
          )}
        </div>

        <div className="frv-band__cell">
          <h3 className="frv-h">Engine Running</h3>
          {engineRatio != null
            ? <Meter ratio={engineRatio} tone="engine"
                     value={`${Math.round(Math.min(1, engineRatio) * 100)}%`} unit="of the period"
                     lo="0 h" hi={`${n1(periodH)} h`}
                     ariaLabel={`Engine ran ${n1(s.engineHours)} of ${n1(periodH)} hours.`} />
            : <p className="frv-none">No period to measure.</p>}
          <p className="frv-band__note">{n1(s.engineHours)} h of the {n1(periodH)} h in this period.</p>
        </div>

        <div className="frv-band__cell frv-band__cell--wide">
          <h3 className="frv-h">How the Time Was Spent <span>{n1(periodH)} h</span></h3>
          <Split parts={timeParts} unit="h"
                 ariaLabel={`Of ${n1(periodH)} hours: moving ${n1(s.movingHours)}, parked ${n1(s.parkingHours)}, stopped or silent ${n1(otherH)}.`} />
        </div>
      </section>

      {/* ── 2 · The fuel events ── */}
      <section className="frv-events">
        <h3 className="frv-sec">
          Fuel Events <span className="sp4-tab-n">{events.length}</span>
        </h3>
        {events.length === 0
          ? <div className="sp4-empty">No filling or drain in this period.</div>
          : (
            <>
              {/* The rail: the track is one bar split strictly by litres; the
                  keys under it, in the same order, carry the names and figures
                  (a small kind's label would not fit inside its own sliver).
                  Either half filters the table; hovering one lifts the other. */}
              <div className="frv-rail">
                <div className="frv-rail__track" aria-hidden="true">
                  {kindRows.map((k) => (
                    <span
                      key={k.key}
                      className={`frv-rail__bar frv-rail__bar--${k.tone}${k.shade ? " frv-rail__bar--alt" : ""}`
                        + (kindFilter === k.key ? " is-on" : "") + (hotKind === k.key ? " is-hot" : "")}
                      style={{ flexGrow: Math.max(k.litres, 0.0001) }}
                      onClick={() => setKindFilter(kindFilter === k.key ? null : k.key)}
                      onMouseEnter={() => setHotKind(k.key)}
                      onMouseLeave={() => setHotKind(null)}
                      title={`${k.key}: ${n1(k.litres)} L, ${totalL > 0 ? Math.round((k.litres / totalL) * 100) : 0}% of the litres moved`}
                    />
                  ))}
                </div>
                <div className="frv-rail__keys" role="group" aria-label="Fuel events by kind. Choose one to filter the table">
                  {kindRows.map((k) => {
                    const on = kindFilter === k.key;
                    return (
                      <button
                        key={k.key}
                        type="button"
                        className={`frv-rail__key frv-rail__key--${k.tone}${k.shade ? " frv-rail__key--alt" : ""}`
                          + (on ? " is-on" : "") + (hotKind === k.key ? " is-hot" : "")}
                        aria-pressed={on}
                        onClick={() => setKindFilter(on ? null : k.key)}
                        onMouseEnter={() => setHotKind(k.key)}
                        onMouseLeave={() => setHotKind(null)}
                        title={`${k.key}: ${n1(k.litres)} L in ${k.count}, ${totalL > 0 ? Math.round((k.litres / totalL) * 100) : 0}% of the litres moved. Click to ${on ? "show every event" : "show only these"}.`}
                      >
                        <span className="frv-rail__k"><i aria-hidden="true" />{k.key}</span>
                        <span className="frv-rail__v">{k.count}<small>{k.count === 1 ? " event" : " events"} · {totalL > 0 ? Math.round((k.litres / totalL) * 100) : 0}%</small></span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {kindFilter && (
                <div className="frv-filter">
                  Showing {shownEvents.length} of {events.length}: <b>{kindFilter}</b>
                  <button type="button" className="sp4-ghost-btn" onClick={() => setKindFilter(null)}>Show all</button>
                </div>
              )}
              <div className="sp4-table-scroll frv-table">
                <table className="sp4-table sp4-probe-table sp4-probe-table--comfortable">
                  <thead><tr>
                    <th className="sp4-th--left">Time</th>
                    <th className="sp4-th--left">Event</th>
                    <th className="sp4-th--right">Before</th>
                    <th className="sp4-th--right">After</th>
                    <th className="sp4-th--right">Volume</th>
                    <th className="sp4-th--left">Location</th>
                  </tr></thead>
                  <tbody>
                    {shownEvents.map((e) => (
                      <tr key={`${e.kind}-${e.id}`} className="sp4-tr"
                          onMouseEnter={() => { onHoverAt(e.at); setHotKind(kindOf(e)); }}
                          onMouseLeave={() => { onHoverAt(null); setHotKind(null); }}>
                        <td className="sp4-td--left sp4-num">{at(e.at)}</td>
                        <td className="sp4-td--left">
                          <span className={`sp4-pill sp4-pill--${e.kind === "filling" ? "con" : e.theft ? "inc" : "none"}`}>
                            {e.kind === "filling" ? "Filling" : dropWord(e)}
                          </span>
                        </td>
                        <td className="sp4-td--right sp4-num">{fmtNum(e.beforeL)} L</td>
                        <td className="sp4-td--right sp4-num">{fmtNum(e.afterL)} L</td>
                        <td className="sp4-td--right sp4-num"><b>{fmtNum(e.volumeL)} L</b></td>
                        <td className="sp4-td--left sp4-muted">{e.location ?? "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
      </section>

      {/* ── 3 · The rest of the figures ── */}
      <section className="frv-figs-wrap">
        <h3 className="frv-sec">Figures</h3>
        <dl className="frv-figs">
          <div><dt>Avg consumption</dt><dd>{consumption}</dd></div>
          <div><dt>Max / avg speed</dt><dd>{n0(s.maxSpeedKmh)} / {n0(s.avgSpeedKmh)} km/h</dd></div>
          <div><dt>Trips · parkings · stops</dt><dd>{s.tripCount} · {s.parkingCount} · {s.stopCount}</dd></div>
          <div><dt>Longest parking</dt><dd>{r.parkings.length ? durationLabel(Math.max(...r.parkings.map((p) => p.durationMs))) : "-"}</dd></div>
          <div><dt>Readings</dt><dd>{r.readings.toLocaleString("en-KE")}</dd></div>
        </dl>
      </section>
    </div>
  );
}
