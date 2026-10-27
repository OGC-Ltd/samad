/*
 * The vehicle panel's Overview tab, in the Fuel tab's card language
 * (redesigned 2026-10-02; the chart card, readout and day groups are
 * FuelParts'):
 *
 *   ReadingsCard  the unit's four readings (idle today, GPS, engine hours,
 *                 odometer) two by two in one card, each with an icon; a
 *                 reading given a `level` carries a bar in the tank gauge's bands
 *   FactsCard     a row of label-over-value facts in a card (Vehicle)
 *   DriverRow     the driver: avatar (initials on a colour of their own, or an
 *                 outlined person), name, rating; opens the Drivers page
 *   SummaryCard   a lead sentence, then a line each, flags first
 *   OverspeedReadout  the speed chart's readout: overspeeds, worst peak, time
 *                 over the limit (FuelParts' readout styles)
 */

import { tankBand } from './FuelParts';
import { initialsOf, avatarHue } from '../../lib/avatar';
import './OverviewParts.css';
import './FuelParts.css';

const NA = 'Not available';

/**
 * Items are { icon, label, value, sub?, tone? ('alert' | 'warn'), level? } —
 * `level` a fuel share (0–100) drawn as a bar, with `reservePct` for its band.
 */
export function ReadingsCard({ items, reservePct }) {
  return (
    <dl className="ov-read">
      {items.map(it => {
        const band = it.level != null ? tankBand(it.level, reservePct) : null;
        return (
          <div key={it.label} className={`ov-cell${it.tone ? ` ov-cell--${it.tone}` : ''}`}>
            <dt><i className={`ti ${it.icon}`} aria-hidden="true" />{it.label}</dt>
            <dd className="ov-cell-val">{it.value ?? <span title={NA} aria-label={NA}>–</span>}</dd>
            {band && (
              <dd className={`ov-level ov-level--${band}`} aria-hidden="true">
                <span style={{ width: `${Math.max(0, Math.min(100, it.level))}%` }} />
              </dd>
            )}
            {it.sub && <dd className="ov-cell-sub">{it.sub}</dd>}
          </div>
        );
      })}
    </dl>
  );
}

/** Items are { label, value } — value null for "not available". */
export function FactsCard({ items }) {
  return (
    <dl className="ov-facts" style={{ '--ov-cols': items.length }}>
      {items.map(it => (
        <div key={it.label}>
          <dt>{it.label}</dt>
          <dd>{it.value ?? <span title={NA}>–</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Over the Overview's speed chart: the overspeeds today, the worst peak and
 * how long it ran over in all — the Fuel tab's readout, for speed.
 */
export function OverspeedReadout({ runs, topSpeed, limit, hasPings, fmtMinutes }) {
  const overMin = runs.reduce((s, r) => s + (r.end - r.start) / 60_000, 0);
  const worst = runs.length ? runs.reduce((w, r) => (r.max - r.limit > w.max - w.limit ? r : w)) : null;
  const top = hasPings ? Math.round(topSpeed ?? 0) : null;
  const items = [
    {
      label: 'Overspeeds',
      value: hasPings ? String(runs.length) : null,
      sub: !hasPings ? 'No readings' : runs.length ? 'today' : 'none today',
      tone: runs.length ? 'alert' : null,
    },
    {
      label: worst ? 'Worst peak' : 'Top speed',
      value: worst ? `${Math.round(worst.max)} km/h` : top != null ? `${top} km/h` : null,
      sub: worst ? `+${Math.round(worst.max - worst.limit)} over ${worst.limit}` : top != null ? `limit ${limit} km/h` : 'No readings',
      tone: worst ? 'alert' : null,
    },
    {
      label: 'Over the limit',
      value: hasPings ? (overMin === 0 ? '0m' : overMin < 1 ? '< 1m' : fmtMinutes(overMin)) : null,
      sub: hasPings ? 'in all, today' : 'No readings',
      tone: overMin > 0 ? 'alert' : null,
    },
  ];
  return (
    <dl className="fp-readout">
      {items.map(it => (
        <div key={it.label} className={`fp-read${it.tone ? ` fp-read--${it.tone}` : ''}`}>
          <dt>{it.label}</dt>
          <dd className="fp-read-val">{it.value ?? <span title={NA}>–</span>}</dd>
          <dd className="fp-read-sub">{it.sub}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Driver and summary ────────────────────────────────────────────────────────

// One avatar rule for the app (lib/avatar): the header uses it too
export { initialsOf, avatarHue };

/**
 * The driver as a row: an avatar (initials on the name's own colour, or an
 * outlined person where no one is assigned), the name, the rating, and — where
 * the viewer may — the whole row opens the driver on the Drivers page.
 */
export function DriverRow({ name, rating, droveToday, onOpen }) {
  const assigned = Boolean(name);
  const body = (<>
    <span className={`ov-av${assigned ? '' : ' ov-av--none'}`}
          style={assigned ? { '--ov-av': avatarHue(name) } : undefined} aria-hidden="true">
      {assigned ? initialsOf(name) : (
        // An empty seat: a head and shoulders cut off by the disc, drawn
        // rather than a font glyph so it sits exactly on the circle's centre.
        // The dotted ring is drawn here too, not as a CSS dashed border: a
        // browser spaces a dashed border unevenly round a circle and leaves a
        // short gap where it closes, which is what made it look broken.
        // pathLength 28 with a 0.01 dash and round caps gives 28 even dots.
        <svg viewBox="0 0 44 44" width="44" height="44" focusable="false">
          <circle cx="22" cy="17" r="7" className="ov-av-seat" />
          <path d="M8 44c0-8.3 6.3-14 14-14s14 5.7 14 14z" className="ov-av-seat" />
          <circle cx="22" cy="22" r="21" className="ov-av-ring" pathLength="28" strokeDasharray="0.01 0.99" />
        </svg>
      )}
    </span>
    <span className="ov-driver-text">
      <span className="ov-driver-name">{assigned ? name : 'No driver assigned'}</span>
      <span className="ov-driver-sub">
        {rating
          ? <span className="ov-rating"><i className="ti ti-star-filled" aria-hidden="true" />{rating}</span>
          : <span>{assigned ? 'No rating yet' : 'No driver on record for today'}</span>}
        {droveToday && <span className="ov-chip">Drove today</span>}
      </span>
    </span>
    {onOpen && <i className="ti ti-chevron-right ov-driver-go" aria-hidden="true" />}
  </>);
  return onOpen
    ? <button type="button" className="ov-driver ov-driver--link" onClick={onOpen} title="Open this driver on the Drivers page">{body}</button>
    : <div className="ov-driver">{body}</div>;
}

/**
 * What the unit is doing, in one lead sentence, then a line each for what to
 * know: flags first (red, amber), then the plain facts. Written from the live
 * readings by rule — see VehicleDetailPanel unitSummary.
 */
export function SummaryCard({ lead, items, asOf }) {
  return (
    <section className="ov-sum" aria-label="Summary">
      <header className="ov-sum-head">
        <span className="ov-sum-title"><i className="ti ti-list-details" aria-hidden="true" />Summary</span>
        {asOf && <span className="ov-sum-asof">from live readings · {asOf}</span>}
      </header>
      <p className="ov-sum-lead">{lead}</p>
      {items.length > 0 && (
        <ul className="ov-sum-list">
          {items.map(it => (
            <li key={it.text} className={`ov-sum-item${it.tone ? ` ov-sum-item--${it.tone}` : ''}`}>
              <i className={`ti ${it.icon}`} aria-hidden="true" />
              <span>{it.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
