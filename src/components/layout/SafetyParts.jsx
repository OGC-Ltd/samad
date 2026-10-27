/*
 * The vehicle panel's Safety tab, in three parts (redesigned 2026-10-02):
 *
 *   SpeedNow           the unit's speed against its limit as a speedometer
 *                      gauge, the state, limit and engine beside it — "is it
 *                      over, and by how much" in one glance
 *   DaySummary         today as one card: top speed, overspeeds and time over
 *                      the limit, each with its context line, over DayStrip —
 *                      the 24-hour track, blue where it moved and red where
 *                      it ran over, so "when" reads before "what"
 *   OverspeedTimeline  each overspeed as a row: start and end, the peak on a
 *                      bar that marks the limit, and the excess, on one
 *                      scale across the day's rows
 *   HarshTimeline      each harsh acceleration or brake as a row, in a
 *                      warning's amber (added 2026-10-21)
 *
 * The figures are VehicleDetailPanel's (overspeedRuns, limitLabel, and
 * vehicleDay's summariseDay / movingSpans); nothing
 * here derives a number the panel did not already compute.
 */

import './SafetyParts.css';

const HHMM = new Intl.DateTimeFormat('en-KE', { hour: '2-digit', minute: '2-digit', hour12: false });

/** The meter's span: the limit plus headroom, and always past the speed. */
export function meterScale(speed, limit) {
  return Math.max(limit * 1.5, (speed ?? 0) * 1.1, 1);
}

// The gauge: a half circle, 0 at the left end, the scale's top at the right.
const G = { cx: 80, cy: 82, r: 64 };
/** The point on the arc `f` of the way round (0 left, 1 right). */
function arcPoint(f, r = G.r) {
  const a = Math.PI * (1 - f);
  return [G.cx + r * Math.cos(a), G.cy - r * Math.sin(a)];
}
const ARC = (() => {
  const [x0, y0] = arcPoint(0);
  const [x1, y1] = arcPoint(1);
  return `M ${x0} ${y0} A ${G.r} ${G.r} 0 0 1 ${x1} ${y1}`;
})();

/**
 * Speed against the limit as a speedometer: the arc fills to the speed, blue
 * up to the limit and red past it, with the limit marked and the part of the
 * dial above it tinted. The state, the limit and the engine sit beside it.
 */
export function SpeedNow({ speed, limit, assumed, engineWord, online }) {
  const s = Math.max(0, Math.round(speed ?? 0));
  const scale = meterScale(s, limit);
  const over = s > limit;
  const f = (v) => Math.min(1, Math.max(0, v / scale));
  const state = !online ? 'offline' : over ? 'over' : s > 0 ? 'moving' : 'still';
  const word = { offline: 'Last known', over: `${s - limit} km/h over`, moving: `${limit - s} km/h under`, still: 'Standing' }[state];
  const fl = f(limit) * 100;
  const fs = f(s) * 100;
  const [tx0, ty0] = arcPoint(f(limit), G.r - 11);
  const [tx1, ty1] = arcPoint(f(limit), G.r + 11);
  const [lx, ly] = arcPoint(f(limit), G.r + 21);

  return (
    <div className={`sf-now sf-now--${state}`}>
      <div className="sf-gauge" role="meter" aria-valuemin={0} aria-valuemax={Math.round(scale)} aria-valuenow={s}
           aria-label={`Speed ${s} km/h, limit ${limit} km/h`}>
        <svg viewBox="0 0 160 96" aria-hidden="true">
          <path className="sf-gauge-track" d={ARC} pathLength="100" />
          <path className="sf-gauge-zone" d={ARC} pathLength="100" strokeDasharray={`0 ${fl} ${100 - fl} 100`} />
          <path className="sf-gauge-fill" d={ARC} pathLength="100" strokeDasharray={`${Math.min(fs, fl)} 100`} />
          {over && (
            <path className="sf-gauge-over" d={ARC} pathLength="100"
                  strokeDasharray={`0 ${fl} ${fs - fl} 100`} />
          )}
          <line className="sf-gauge-limit" x1={tx0} y1={ty0} x2={tx1} y2={ty1} />
          <text className="sf-gauge-lbl" x={lx} y={ly} textAnchor="middle" dominantBaseline="middle">{limit}</text>
          <text className="sf-gauge-end" x={G.cx - G.r} y={G.cy + 12} textAnchor="middle">0</text>
          <text className="sf-gauge-end" x={G.cx + G.r} y={G.cy + 12} textAnchor="middle">{Math.round(scale)}</text>
        </svg>
        <div className="sf-gauge-read">
          <span className="sf-now-num">{s}</span>
          <span className="sf-now-unit">km/h</span>
        </div>
      </div>

      <dl className="sf-now-facts">
        <div>
          <dt>Now</dt>
          <dd className="sf-now-word">{word}</dd>
        </div>
        <div>
          <dt>Limit</dt>
          <dd>
            <strong>{limit} km/h</strong>{assumed && <span className="sf-now-assumed"> · assumed</span>}
          </dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd>
            <span className={`sf-chip${engineWord === 'On' ? ' sf-chip--on' : ''}`}>
              <i className="ti ti-engine" aria-hidden="true" /> Engine {engineWord ? engineWord.toLowerCase() : 'unknown'}
            </span>
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Midnight of the day `ms` falls in, local time (the fleet's own clock). */
const dayStart = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
const DAY_MS = 24 * 3600_000;

/**
 * The fleet day as a 24-hour track: blue where the unit moved, red where it
 * ran over the limit, a mark at now, and the hours still to come left pale.
 */
export function DayStrip({ runs, moving = [], now = Date.now() }) {
  const start = dayStart(now);
  const at = (ms) => `${Math.max(0, Math.min(100, ((ms - start) / DAY_MS) * 100))}%`;
  const span = (a, b) => `max(2px, calc(${at(b)} - ${at(a)}))`;
  return (
    <div className="sf-strip">
      <div className="sf-strip-track" aria-hidden="true">
        <span className="sf-strip-future" style={{ left: at(now) }} />
        <span className="sf-strip-hour" style={{ left: '25%' }} />
        <span className="sf-strip-hour" style={{ left: '50%' }} />
        <span className="sf-strip-hour" style={{ left: '75%' }} />
        {moving.map(m => (
          <span key={`m${m.start}`} className="sf-strip-move" style={{ left: at(m.start), width: span(m.start, m.end) }} />
        ))}
        {runs.map(r => (
          <span key={r.start} className="sf-strip-run"
                style={{ left: at(r.start), width: `max(3px, calc(${at(r.end)} - ${at(r.start)}))` }} />
        ))}
        <span className="sf-strip-now" style={{ left: at(now) }} />
      </div>
      <div className="sf-strip-ticks" aria-hidden="true">
        <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
      </div>
      <div className="sf-strip-key">
        <span><i className="sf-key sf-key--move" />Moving</span>
        <span><i className="sf-key sf-key--run" />Over the limit</span>
        <span><i className="sf-key sf-key--now" />Now</span>
      </div>
    </div>
  );
}

/**
 * Today on the Safety tab as one card: the top speed, the overspeeds and the
 * time over the limit, each with the line that gives it meaning, over the day
 * strip. A null figure (no readings) is a dash, never a zero.
 */
export function DaySummary({ hasPings, topSpeed, limit, runs, movingMin, moving, fmtMinutes, now }) {
  const top = hasPings ? Math.round(topSpeed ?? 0) : null;
  const overMin = runs.reduce((s, r) => s + (r.end - r.start) / 60_000, 0);
  const worst = runs.length ? Math.round(Math.max(...runs.map(r => r.max - r.limit))) : null;
  const dur = (m) => (m < 1 ? (m > 0 ? '< 1m' : '0m') : fmtMinutes(m));

  const stats = [
    {
      label: 'Top speed',
      value: top == null ? null : <>{top}<small> km/h</small></>,
      sub: top == null ? 'No readings' : top > limit ? `${top - limit} over the limit` : top > 0 ? 'Within the limit' : 'Not moved',
      tone: top != null && top > limit ? 'alert' : null,
    },
    {
      label: 'Overspeeds',
      value: hasPings ? String(runs.length) : null,
      sub: !hasPings ? 'No readings' : worst != null ? `Worst +${worst} km/h` : 'None today',
      tone: runs.length ? 'alert' : null,
    },
    {
      label: 'Over the limit',
      value: hasPings ? dur(overMin) : null,
      sub: !hasPings ? 'No readings' : movingMin != null ? `of ${dur(movingMin)} moving` : 'Moving time unknown',
      tone: overMin > 0 ? 'alert' : null,
    },
  ];

  return (
    <div className="sf-day">
      <dl className="sf-day-stats">
        {stats.map(s => (
          <div key={s.label} className={`sf-stat${s.tone ? ` sf-stat--${s.tone}` : ''}`}>
            <dt>{s.label}</dt>
            <dd className="sf-stat-val">{s.value ?? <span title="Not available">–</span>}</dd>
            <dd className="sf-stat-sub">{s.sub}</dd>
          </div>
        ))}
      </dl>
      {hasPings && <DayStrip runs={runs} moving={moving} now={now} />}
    </div>
  );
}

/**
 * The day's harsh accelerations and harsh brakes, newest first (lib/harshDriving):
 * when, what, where and how fast, and the force the tracker measured.
 */
export function HarshTimeline({ events }) {
  return (
    <ol className="sf-ev">
      {events.map(e => (
        <li key={e.id} className="sf-ev-row">
          <span className="sf-ev-when">
            <time dateTime={new Date(e.t).toISOString()}>{HHMM.format(e.t)}</time>
          </span>
          <span className="sf-ev-body">
            <span className="sf-hd-kind">
              <i className={`sf-hd-icon ti ${e.type === 'HARSH_BRAKING' ? 'ti-arrow-big-down' : 'ti-arrow-big-up'}`} aria-hidden="true" />
              {e.title}
            </span>
            {e.where && <span className="sf-hd-where">{e.where}</span>}
          </span>
          {e.force != null && <span className="sf-hd-force" title="Force the tracker measured">{e.force.toFixed(1)} m/s²</span>}
        </li>
      ))}
    </ol>
  );
}

function runLength(run, fmtMinutes) {
  const min = (run.end - run.start) / 60_000;
  return min < 1 ? 'under a minute' : fmtMinutes(min);
}

/**
 * Each overspeed as a row, newest first: when it began and ended, how fast at
 * its worst against a bar that marks the limit, and how far over. One scale
 * across the rows, so a long red tail is a bad run beside the others.
 */
export function OverspeedTimeline({ runs, fmtMinutes }) {
  const scale = Math.max(...runs.map(r => Math.max(r.max, r.limit))) * 1.08;
  const pct = (v) => `${Math.min(100, (v / scale) * 100)}%`;
  const worst = Math.max(...runs.map(r => r.max - r.limit));
  return (
    <ol className="sf-ev">
      {[...runs].reverse().map(r => {
        const over = Math.round(r.max - r.limit);
        return (
          <li key={r.start} className={`sf-ev-row${r.max - r.limit === worst && runs.length > 1 ? ' sf-ev-row--worst' : ''}`}>
            <span className="sf-ev-when">
              <time dateTime={new Date(r.start).toISOString()}>{HHMM.format(r.start)}</time>
              {HHMM.format(r.end) !== HHMM.format(r.start) && <span className="sf-ev-to">to {HHMM.format(r.end)}</span>}
            </span>

            <span className="sf-ev-body">
              <span className="sf-ev-peak">
                Peak <strong>{Math.round(r.max)}</strong> km/h
              </span>
              <span className="sf-ev-bar" aria-hidden="true">
                <span className="sf-ev-bar-ok" style={{ width: pct(r.limit) }} />
                <span className="sf-ev-bar-over" style={{ left: pct(r.limit), width: `calc(${pct(r.max)} - ${pct(r.limit)})` }} />
                <span className="sf-ev-bar-limit" style={{ left: pct(r.limit) }} />
              </span>
              <span className="sf-ev-sum">Over {r.limit} km/h for {runLength(r, fmtMinutes)}</span>
            </span>

            <span className="sf-ev-excess" title={`${over} km/h over the limit`}>+{over}</span>
          </li>
        );
      })}
    </ol>
  );
}
