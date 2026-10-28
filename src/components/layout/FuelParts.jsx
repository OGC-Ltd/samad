/*
 * The vehicle panel's Fuel tab, around its chart (redesigned 2026-10-02):
 *
 *   DayGroups     the day's nine figures (VehicleDetailPanel's dayFigures) in
 *                 three labelled rows: fuel, driving, engine and speed
 *   TankGauge     the tank as a dashboard fuel gauge, E to F with an arrow,
 *                 red / amber / green by band (low, reserve, good), then
 *                 capacity, room to full and the reserve
 *
 * Nothing here derives a figure the panel does not already have: the groups
 * take dayFigures as they are.
 */

import './FuelParts.scss';

const NA = 'Not available';
const fmtL = (l) => `${Math.round(l).toLocaleString('en-KE')} L`;

const GROUPS = [
  { title: 'Fuel', icon: 'ti-gas-station' },
  { title: 'Driving', icon: 'ti-route' },
  { title: 'Engine & speed', icon: 'ti-gauge' },
];

/**
 * dayFigures' nine, three to a labelled row, in the order it gives them;
 * `only` keeps some rows by title (the Overview leaves Fuel to the Fuel tab).
 */
export function DayGroups({ items, only = null }) {
  return (
    <div className="fp-groups">
      {GROUPS.map((g, gi) => (only && !only.includes(g.title) ? null : (
        <section key={g.title} className="fp-group" aria-label={g.title}>
          <h4 className="fp-group-title"><i className={`ti ${g.icon}`} aria-hidden="true" />{g.title}</h4>
          <dl className="fp-group-row">
            {items.slice(gi * 3, gi * 3 + 3).map(f => (
              <div key={f.label} className={`fp-fig${f.tone ? ` fp-fig--${f.tone}` : ''}`}>
                <dt>{f.label}</dt>
                <dd className="fp-fig-val">{f.value ?? <span title={NA} aria-label={NA}>–</span>}</dd>
                {f.sub && <dd className="fp-fig-sub">{f.sub}</dd>}
              </div>
            ))}
          </dl>
        </section>
      )))}
    </div>
  );
}

// ── The tank as a fuel gauge ──────────────────────────────────────────────────
// A dial whose arc runs from E at the bottom, round the right, to F at the top
// (as a dashboard fuel gauge), ticked every 5%, coloured by band, with an arrow
// that turns to the level.

const D = { c: 80, tickOut: 66, tickIn: 59, majorIn: 53 };
const SWEEP = 220;                       // degrees from E to F
const angleOf = (f) => -SWEEP / 2 + SWEEP * f;   // maths angle: 0 points right
function polar(deg, r) {
  const a = (deg * Math.PI) / 180;
  return [D.c + r * Math.cos(a), D.c - r * Math.sin(a)];
}

/**
 * The level's band: low below the reserve, reserve up to half a tank, good
 * above. One rule for the ticks, the arrow's hub, the number and the status.
 */
export function tankBand(share, reservePct) {
  if (share == null) return 'none';
  if (share < reservePct) return 'low';
  if (share < 50) return 'reserve';
  return 'good';
}
const BAND_WORDS = { low: 'Low · below reserve', reserve: 'Reserve · under half', good: 'Good · above half', none: 'No level' };

export function TankGauge({ pct, litres, capacityL, reservePct, probeFault, probeHold }) {
  // The level as a share of the tank, from the % where the unit reports one,
  // else from litres over a known capacity.
  const share = pct != null ? pct : litres != null && capacityL ? (litres / capacityL) * 100 : null;
  const fill = share != null ? Math.max(0, Math.min(100, share)) : null;
  const band = tankBand(fill, reservePct);
  const room = litres != null && capacityL ? Math.max(0, capacityL - litres) : null;
  const probe = probeHold ? { word: 'Probe reported', tone: 'warn' }
    : probeFault ? { word: 'Probe fault', tone: 'alert' }
    : litres != null || pct != null ? { word: 'Probe reporting', tone: 'ok' }
    : { word: 'No reading', tone: 'none' };

  const ticks = Array.from({ length: 21 }, (_, i) => i * 5);
  const needleDeg = angleOf((fill ?? 0) / 100);
  const [ex, ey] = polar(angleOf(0), 40);
  const [fx, fy] = polar(angleOf(1), 40);

  return (
    <div className={`fp-tank fp-tank--${band}`}>
      <div className="fp-tank-main">
        <div className="fp-dial" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={fill ?? undefined}
             aria-label={fill != null ? `Tank ${Math.round(fill)}% full, ${BAND_WORDS[band]}` : 'Tank level not available'}>
          <svg viewBox="0 0 160 160" aria-hidden="true">
            <circle className="fp-dial-rim" cx={D.c} cy={D.c} r={77} />
            <circle className="fp-dial-face" cx={D.c} cy={D.c} r={73} />
            {ticks.map(v => {
              const major = v % 25 === 0;
              const [x0, y0] = polar(angleOf(v / 100), major ? D.majorIn : D.tickIn);
              const [x1, y1] = polar(angleOf(v / 100), D.tickOut);
              const tb = tankBand(v === 100 ? 100 : v + 0.01, reservePct);
              const lit = fill != null && v <= fill;
              return (
                <line key={v} x1={x0} y1={y0} x2={x1} y2={y1}
                      className={`fp-tick fp-tick--${tb}${major ? ' fp-tick--major' : ''}${lit ? ' fp-tick--lit' : ''}`} />
              );
            })}
            <text className="fp-dial-ef" x={ex} y={ey} textAnchor="middle" dominantBaseline="middle">E</text>
            <text className="fp-dial-ef" x={fx} y={fy} textAnchor="middle" dominantBaseline="middle">F</text>
            {/* The pump, opposite the scale */}
            <g className="fp-dial-pump" transform="translate(30 70)">
              <rect x="0" y="0" width="11" height="15" rx="1.5" />
              <rect className="fp-dial-pump-win" x="2.5" y="2.5" width="6" height="4" rx="0.5" />
              <rect x="-2" y="15" width="15" height="2.5" rx="1" />
              <path d="M11 4 h3 a2 2 0 0 1 2 2 v7 a1.5 1.5 0 0 0 3 0 v-9 l-2.5 -2.5" fill="none" strokeWidth="1.6" />
            </g>
            {/* The arrow, drawn pointing right and turned to the level */}
            <g className="fp-needle" style={{ transform: `rotate(${-needleDeg}deg)` }}>
              <polygon points={`${D.c - 12},${D.c - 2.2} ${D.c + 42},${D.c - 2.2} ${D.c + 42},${D.c - 6} ${D.c + 57},${D.c} ${D.c + 42},${D.c + 6} ${D.c + 42},${D.c + 2.2} ${D.c - 12},${D.c + 2.2}`} />
            </g>
            <circle className="fp-hub" cx={D.c} cy={D.c} r={7} />
            <circle className="fp-hub-dot" cx={D.c} cy={D.c} r={2.5} />
          </svg>
        </div>

        <div className="fp-tank-read">
          <span className="fp-tank-num">{fill != null ? `${Math.round(fill)}%` : litres != null ? fmtL(litres) : '–'}</span>
          {fill != null && litres != null && <span className="fp-tank-l">{fmtL(litres)} in tank</span>}
          <span className="fp-tank-band">
            <span className="fp-tank-band-dot" aria-hidden="true" />{BAND_WORDS[band]}
          </span>
          <span className={`fp-probe fp-probe--${probe.tone}`}>
            <span className="fp-probe-dot" aria-hidden="true" />{probe.word}
          </span>
        </div>
      </div>

      <dl className="fp-tank-facts">
        <div><dt>Capacity</dt><dd>{capacityL != null ? fmtL(capacityL) : 'Not recorded'}</dd></div>
        <div><dt>Room to full</dt><dd>{room != null ? fmtL(room) : <span title={NA}>–</span>}</dd></div>
        <div><dt>Reserve</dt><dd>{reservePct}%{capacityL != null ? ` · ${fmtL((capacityL * reservePct) / 100)}` : ''}</dd></div>
      </dl>
    </div>
  );
}
