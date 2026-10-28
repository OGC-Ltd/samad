/*
 * The vehicle panel's Faults tab (redesigned 2026-10-02):
 *
 *   HealthSummary  the verdict over the parts that report — a line in words,
 *                  a strip with a segment per part in its colour, and the
 *                  count in each state
 *   CheckList      each part as a row: its icon in its state's tint, the name
 *                  and what it last said, and the state as a pill; faults
 *                  first, then quiet, reporting, no reading
 *
 * Items are VehicleDetailPanel's checks: { name, icon, state, sub?, tone },
 * tone 'alert' (fault) · 'warn' (quiet / hold) · 'ok' (reporting) · 'none' (not fitted, no reading).
 */

import './FaultsParts.scss';

const ORDER = { alert: 0, warn: 1, ok: 2, none: 3 };
// Grey is a part not fitted or with no reading: 'no reading' is true of both
const WORDS = { alert: 'Fault', warn: 'Attention', ok: 'Reporting', none: 'No reading' };

export const bySeverity = (items) => [...items].sort((a, b) => (ORDER[a.tone] ?? 4) - (ORDER[b.tone] ?? 4));

/** The tab's headline: the worst state decides it. */
export function healthVerdict(items) {
  const n = (t) => items.filter(c => c.tone === t).length;
  const faults = n('alert'), quiet = n('warn'), ok = n('ok');
  if (faults) return { tone: 'alert', icon: 'ti-alert-octagon', title: `${faults} ${faults === 1 ? 'fault' : 'faults'} reported`,
    sub: quiet ? `and ${quiet} more needing attention` : 'Check the part below' };
  if (quiet) return { tone: 'warn', icon: 'ti-alert-triangle', title: `${quiet} ${quiet === 1 ? 'part needs' : 'parts need'} attention`,
    sub: 'No faults reported' };
  if (ok) return { tone: 'ok', icon: 'ti-circle-check', title: ok === items.length ? 'All parts reporting' : `${ok} of ${items.length} parts reporting`,
    sub: 'No faults reported' };
  return { tone: 'none', icon: 'ti-plug-x', title: 'Nothing reporting', sub: 'No sensors fitted or heard from' };
}

export function HealthSummary({ items, asOf }) {
  const v = healthVerdict(items);
  const sorted = bySeverity(items);
  const counts = ['alert', 'warn', 'ok', 'none']
    .map(t => ({ t, n: items.filter(c => c.tone === t).length }))
    .filter(c => c.n);
  return (
    <div className={`fx-health fx-health--${v.tone}`} role="status">
      <div className="fx-health-top">
        <span className="fx-health-icon" aria-hidden="true"><i className={`ti ${v.icon}`} /></span>
        <span className="fx-health-text">
          <span className="fx-health-title">{v.title}</span>
          <span className="fx-health-sub">{v.sub}{asOf ? ` · last report ${asOf}` : ''}</span>
        </span>
      </div>
      <div className="fx-strip" aria-hidden="true">
        {sorted.map(c => <span key={c.name} className={`fx-strip-seg fx-strip-seg--${c.tone}`} title={`${c.name}: ${c.state}`} />)}
      </div>
      <div className="fx-counts">
        {counts.map(c => (
          <span key={c.t} className={`fx-count fx-count--${c.t}`}>
            <i aria-hidden="true" />{c.n} {WORDS[c.t].toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

export function CheckList({ items }) {
  return (
    <ul className="fx-list">
      {bySeverity(items).map(c => (
        <li key={c.name} className={`fx-row fx-row--${c.tone}`}>
          <span className="fx-row-icon" aria-hidden="true"><i className={`ti ${c.icon ?? 'ti-cpu'}`} /></span>
          <span className="fx-row-main">
            <span className="fx-row-name">{c.name}</span>
            {c.sub && <span className="fx-row-sub">{c.sub}</span>}
          </span>
          <span className="fx-pill">{c.state}</span>
        </li>
      ))}
    </ul>
  );
}
