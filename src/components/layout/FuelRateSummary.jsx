/*
 * FUEL RATE / FUEL DOWN for the day on screen, at the top of the vehicle
 * panel's day section, straight under the fuel chart.
 *
 * The same findings, counted the same way, as the daily summary the server
 * posts for the whole organisation each morning (lib/fuelRateSummary says how,
 * and why a dismissed one stays listed here) — for this unit alone, and while
 * the day is still running. Each is listed at the time its alert gives (when
 * the drop began), with the alert's litres and the number of its band on the
 * chart; picking one opens that band.
 */

import { useMemo } from 'react';
import { fuelRateFindings, fuelRateSummaryText } from '../../lib/fuelRateSummary';
import { FUEL_EVENT_KINDS } from '../../lib/fuelEpisodes';
import './FuelRateSummary.scss';

const HHMM = new Intl.DateTimeFormat('en-KE', { hour: '2-digit', minute: '2-digit', hour12: false });
const DAY_HHMM = new Intl.DateTimeFormat('en-KE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const L1 = (l) => `${l.toLocaleString('en-KE', { maximumFractionDigits: 1 })} L`;

/**
 * `drains` are the day's ledger rows and `episodes` the chart's events built
 * from them (hooks/useVehicleFuelEvents). `dayWord` finishes "None …".
 * `max` caps the rows, with `onMore` offered for the rest; `onPick(bandId)`
 * opens a band on the chart. `withDate` puts the day on each row, for a range
 * of days.
 */
export default function FuelRateSummary({
  drains = [], episodes = [], dayWord = 'today', loading = false, error = null,
  max = Infinity, onMore, onPick, withDate = false,
}) {
  const at = (ms) => (withDate ? DAY_HHMM : HHMM).format(ms);
  const findings = useMemo(() => fuelRateFindings(drains), [drains]);
  const text = fuelRateSummaryText(findings);
  const shown = findings.slice(0, max);
  const more = findings.length - shown.length;
  const bandOf = (f) => episodes.find(e => e.ids?.includes(`drain-${f.id}`)) ?? null;

  let body;
  if (!findings.length) {
    body = (
      <p className="frs-none">
        {loading ? 'Checking the fuel ledger…' : error ? 'Could not be loaded.' : `None ${dayWord}.`}
      </p>
    );
  } else {
    body = (<>
      <p className="frs-text">{text}</p>
      <ul className="frs-list">
        {shown.map(f => {
          const band = bandOf(f);
          const litres = f.litres != null ? L1(f.litres) : null;
          const dismissed = f.dismissed
            ? `Dismissed${f.dismissedBy ? ` by ${f.dismissedBy}` : ''}${f.dismissedAt ? ` at ${HHMM.format(f.dismissedAt)}` : ''}`
            : null;
          const label = [at(f.at), f.kind, litres, f.detail, dismissed].filter(Boolean).join(', ');
          return (
            <li key={f.id}>
              <button
                type="button"
                className={`frs-row${f.dismissed ? ' frs-row--dismissed' : ''}`}
                disabled={!band || !onPick}
                onClick={() => band && onPick?.(band.id)}
                title={[f.detail, dismissed, band ? `Show it on the chart (${band.n})` : null].filter(Boolean).join('\n')}
                aria-label={band ? `${label}. Show it on the chart, event ${band.n}` : label}
              >
                <span className="frs-n" style={{ background: FUEL_EVENT_KINDS.drop.color }} aria-hidden="true">
                  {band ? band.n : '·'}
                </span>
                <b className="frs-time">{at(f.at)}</b>
                <span className="frs-kind">{f.kind}</span>
                {f.dismissed && <span className="frs-tag">dismissed</span>}
                {litres && <span className="frs-l">{litres}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {more > 0 && onMore && (
        <button type="button" className="frs-more" onClick={onMore}>
          {more} more on the Fuel tab
        </button>
      )}
    </>);
  }

  return (
    <div className="frs" role="group" aria-label="FUEL RATE and FUEL DOWN">
      <div className="frs-head">FUEL RATE / FUEL DOWN</div>
      {body}
    </div>
  );
}
