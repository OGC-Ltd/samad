/**
 * The stat-chart cell of the Drivers strip: muted title + trend delta pill,
 * big total, a caption, and a daily bar or line chart underneath. Shared so
 * the Alerts strip draws the same cell (operator, 2026-11-06). Styles live in
 * DriversScreen.scss (.dr-statchart, .dr-spark).
 */
import { useId, useState } from "react";
import "./DriversScreen.scss";

const fmt = (n, d = 0) =>
  Number(n ?? 0).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });

const fmtDay = (day) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// Trend delta over a daily series — this half vs the previous half. Mirrors the
// stat cards on the Analytics page so the driver trend charts read as siblings.
export function periodDelta(values) {
  if (values.length < 2) return null;
  const half = Math.max(1, Math.floor(values.length / 2));
  const cur = values.slice(-half);
  const prev = values.slice(-2 * half, -half);
  const total = (arr) => arr.reduce((s, x) => s + x, 0);
  const c = total(cur), p = total(prev);
  if (p <= 0) return c > 0 ? 100 : 0;
  return Math.round(((c - p) / p) * 100);
}

// Selected-driver trend as a stat chart - muted title + trend delta pill, big
// total value, a sub caption, and a daily chart underneath.
//
// The card's own headline IS the chart's readout. Moving the cursor over the
// line rewrites the value and the caption in place rather than floating a
// tooltip over the plot: the number is already set in the size the card wants
// it read at, the caption row already exists, and nothing moves when the
// pointer does. A tooltip would have been a second, smaller copy of both.
export default function TrendStat({ title, series, valueKey, unit, value, tone, type, sub, loading, upIsBad = false, pointWords, what = "tonnage" }) {
  // No pill for a window with nothing in it: "▲ 0%" in red read as a rise.
  const deltaPct = series.some((s) => s[valueKey]) ? periodDelta(series.map((s) => s[valueKey])) : null;
  const up = (deltaPct ?? 0) >= 0;
  const [cursor, setCursor] = useState(null);

  const at = cursor != null && series[cursor] ? series[cursor] : null;
  const decimals = unit === "t" ? 1 : 0;

  return (
    <div className={`dr-cell dr-statchart dr-statchart--${tone}`}>
      <div className="dr-statchart__head">
        <span className="dr-statchart__label">{title}</span>
        {deltaPct != null && (
          <span className={`dr-statchart__delta ${up !== upIsBad ? "up" : "down"}`}>
            {up ? "▲" : "▼"} {Math.abs(deltaPct)}%
          </span>
        )}
      </div>
      <div className={"dr-statchart__value" + (at ? " dr-statchart__value--reading" : "")}>
        {at ? fmt(at[valueKey], decimals) : value}
        {unit && <span className="dr-statchart__unit"> {unit}</span>}
      </div>
      <div className="dr-statchart__sub">{at && pointWords ? pointWords(at) : at ? fmtDay(at.day) : sub}</div>
      {type === "line" ? (
        <TrendLine
          series={series} valueKey={valueKey} unit={unit} title={title}
          decimals={decimals} loading={loading} cursor={cursor} onCursor={setCursor}
        />
      ) : (
        <TrendMini series={series} valueKey={valueKey} unit={unit} what={what} loading={loading} cursor={cursor} onCursor={setCursor} />
      )}
    </div>
  );
}

/* Monotone cubic interpolation (Fritsch-Carlson).
 *
 * Not Catmull-Rom, which is the usual reach for "make the line smooth": it
 * overshoots between points, and on a series that touches zero - which an idle
 * day does, most weeks - the overshoot dips the curve and its area fill BELOW
 * the baseline. A distance chart that draws negative kilometres is worse than
 * a jagged one. Monotone cubic is smooth and cannot overshoot: between two
 * samples the curve stays between their two values. */
function smoothPath(pts) {
  const n = pts.length;
  if (n === 0) return "";
  if (n === 1) return `M${pts[0][0]},${pts[0][1]}`;

  const dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    slope[i] = (pts[i + 1][1] - pts[i][1]) / dx[i];
  }
  // Tangents: zero at every local extremum (that is what kills the overshoot),
  // a weighted harmonic mean of the neighbouring slopes everywhere else.
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * dx[i] + dx[i - 1];
      const w2 = dx[i] + 2 * dx[i - 1];
      m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]);
    }
  }
  m[n - 1] = slope[n - 2];

  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d += ` C${pts[i][0] + h},${pts[i][1] + m[i] * h}` +
         ` ${pts[i + 1][0] - h},${pts[i + 1][1] - m[i + 1] * h}` +
         ` ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

/* The plot's aspect ratio IS the card's height, because the SVG scales
 * uniformly (height:auto) — so this ratio is what has to agree with Analytics,
 * not a pixel height. .an-kpi__spark measures 115px inside a 324px card at
 * 1440; 264/84 lands the same plot at 116px there and 97px on a phone. At the
 * 96 it was, the chart came out 130px and made every card in the row 14px
 * taller than the KPI tiles it sits under on the next tab. */
/* The plot is PAD_T..H-PAD_B, and only the bottom band has changed: 84/15
   became 73/4, so `base` is still 69 and every point, bar and crosshair lands
   exactly where it did. What went is the 11 units under the baseline that
   existed to seat two date ticks, which is ~11px of card height at this
   chart's width — on a four-up row of equal-height cards, off all four.
   4 rather than 0 because a marker sitting on the baseline has r=3.2. */
const CHART = { W: 264, H: 73, PAD_X: 7, PAD_T: 10, PAD_B: 4 };

// Per-day mileage as a smooth, readable line.
function TrendLine({ series, valueKey, unit, title, decimals, loading, cursor, onCursor }) {
  // useId, not a module counter: a duplicated gradient id would make the second
  // chart's fill resolve to the first one's stops.
  const gid = useId();

  if (loading) return <div className="dr-chart__empty" aria-busy="true">Loading…</div>;
  if (!series || series.length === 0) return <div className="dr-chart__empty">No activity in window</div>;
  // A series of nothing but zeros draws a flat line pinned to the axis inside a
  // full-height plot — a 110px box holding one horizontal rule. Say it instead.
  if (series.every((s) => !s[valueKey])) return <div className="dr-chart__empty">Nothing recorded in this window</div>;

  const { W, H, PAD_X, PAD_T, PAD_B } = CHART;
  const n = series.length;
  const step = n > 1 ? (W - PAD_X * 2) / (n - 1) : 0;
  const max = Math.max(1, ...series.map((s) => s[valueKey]));
  const base = H - PAD_B;
  const xOf = (i) => (n > 1 ? PAD_X + i * step : W / 2);
  const yOf = (v) => PAD_T + (1 - v / max) * (base - PAD_T);

  const pts = series.map((s, i) => [xOf(i), yOf(s[valueKey])]);
  const line = smoothPath(pts);
  const area = n > 1 ? `${line} L${xOf(n - 1)},${base} L${xOf(0)},${base} Z` : "";

  const clamp = (i) => Math.max(0, Math.min(n - 1, i));
  const pick = (e) => {
    if (n < 2) return onCursor(0);
    const box = e.currentTarget.getBoundingClientRect();
    if (!box.width) return undefined;
    // Client px -> viewBox units. The SVG scales uniformly, so one ratio does it.
    const vx = ((e.clientX - box.left) / box.width) * W;
    return onCursor(clamp(Math.round((vx - PAD_X) / step)));
  };
  const onKeyDown = (e) => {
    const move = { ArrowLeft: -1, ArrowRight: 1, Home: -n, End: n }[e.key];
    if (move === undefined) {
      if (e.key === "Escape") onCursor(null);
      return;
    }
    e.preventDefault();
    onCursor(clamp((cursor ?? n - 1) + move));
  };

  const read = cursor != null && series[cursor];

  return (
    /* Focusable and arrow-driven, not hover-only. This is the one chart on the
       page carrying a per-day number, and a pointer was the only way to get at
       it. role=img with a label so a screen reader is told the shape rather
       than handed thirty unlabelled path nodes. */
    <svg
      className={"dr-spark" + (read ? " dr-spark--reading" : "")}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      tabIndex={0}
      /* The window's dates live here now rather than under the plot. They were
         two 7.5px ticks that never changed while the cursor moved and cost the
         card the band they sat in; the day a reader actually wants is the one
         under the pointer, and that is written into the caption above in the
         size the card sets its numbers. Nothing is lost to a screen reader. */
      aria-label={`${title} by day, ${fmtDay(series[0].day)} to ${fmtDay(series.at(-1).day)}. ${n} day${n === 1 ? "" : "s"}, highest ${fmt(max, decimals)} ${unit}. Arrow keys read each day.`}
      onPointerMove={pick}
      onPointerDown={pick}
      onPointerLeave={() => onCursor(null)}
      onFocus={() => onCursor((c) => (c == null ? n - 1 : c))}
      onBlur={() => onCursor(null)}
      onKeyDown={onKeyDown}
    >
      <defs>
        <linearGradient id={`dr-fill-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="dr-spark__stop-a" />
          <stop offset="100%" className="dr-spark__stop-b" />
        </linearGradient>
      </defs>

      <line className="dr-spark__base" x1={PAD_X} y1={base} x2={W - PAD_X} y2={base} />
      {area && <path className="dr-spark__area" d={area} fill={`url(#dr-fill-${gid})`} />}
      {/* non-scaling-stroke so the line is the same weight at every card width -
          the SVG is laid out fluid and would otherwise thin out on a phone. */}
      <path className="dr-spark__line" d={line} vectorEffect="non-scaling-stroke" />
      {n === 1 && <circle className="dr-spark__marker" cx={xOf(0)} cy={pts[0][1]} r="3" />}

      {read && (
        <g className="dr-spark__cursor">
          <line
            className="dr-spark__crosshair" vectorEffect="non-scaling-stroke"
            x1={pts[cursor][0]} y1={PAD_T - 5} x2={pts[cursor][0]} y2={base}
          />
          <circle className="dr-spark__marker" cx={pts[cursor][0]} cy={pts[cursor][1]} r="3.2" />
        </g>
      )}
    </svg>
  );
}

// Per-day tonnes as bars. A bar carries its own hit target and its <title>
// answers "which day", which is why this one needed no cursor of its own — and
// why the date ticks came off it too.
function TrendMini({ series, valueKey, unit, what, loading, cursor = null, onCursor }) {
  if (loading) return <div className="dr-chart__empty" aria-busy="true">Loading…</div>;
  if (!series || series.length === 0) return <div className="dr-chart__empty">No activity in window</div>;
  // Every bar zero-height is an empty box, not a chart. Same call as TrendLine.
  if (series.every((s) => !s[valueKey])) return <div className="dr-chart__empty">Nothing recorded in this window</div>;
  const { W, H, PAD_X, PAD_T, PAD_B } = CHART;
  const n = series.length;
  const stepX = (W - PAD_X * 2) / n;
  const base = H - PAD_B;
  const max = Math.max(1, ...series.map((s) => s[valueKey]));
  const decimals = unit === "t" ? 1 : 0;
  const words = (s) => {
    return `${fmtDay(s.day)}: ${fmt(s[valueKey], decimals)} ${unit}`;
  };

  return (
    <svg className={`dr-spark${cursor != null ? " dr-spark--reading" : ""}`} viewBox={`0 0 ${W} ${H}`} role="img"
         aria-label={`${fmt(n)} days of ${what}, ${fmtDay(series[0].day)} to ${fmtDay(series.at(-1).day)}, highest ${fmt(max, 1)} ${unit}. Point at a bar for its day.`}
         onMouseLeave={() => onCursor?.(null)}>
      <line className="dr-spark__base" x1={PAD_X} y1={base} x2={W - PAD_X} y2={base} />
      {series.map((s, i) => {
        const bh = (s[valueKey] / max) * (base - PAD_T);
        const x = PAD_X + i * stepX;
        return (
          <g key={i}>
            <rect
              className={`dr-spark__bar${cursor === i ? " dr-spark__bar--on" : ""}`}
              x={x + 0.5} y={base - bh} width={Math.max(1, stepX - 1.5)} height={bh} rx="1.5"
            />
            {/* The whole column answers, so a short bar is as easy to point at as a tall one. */}
            <rect
              className="dr-spark__hit" x={x} y={0} width={stepX} height={H}
              onMouseEnter={() => onCursor?.(i)} onFocus={() => onCursor?.(i)} onBlur={() => onCursor?.(null)}
              tabIndex={onCursor ? 0 : undefined}
            >
              <title>{words(s)}</title>
            </rect>
          </g>
        );
      })}
    </svg>
  );
}
