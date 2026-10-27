// FUEL RATE and FUEL DOWN on one vehicle's day, counted the way the daily
// summary counts them.
//
// Since 2026-09-27 these two reach the fleet once a day rather than one by
// one: fleet-server's lib/queues/fuel-rate-digest reads the closed fleet day
// off the fuel ledger and posts one summary per organisation. This is that
// summary's arithmetic for one unit and the day on screen, so the vehicle
// panel can show it under the fuel chart while the day is still running:
//
//   · a drain whose cause reason is one of the four announced ones — the same
//     `fuelRateKind` the chart labels its bands with;
//   · never a SIPHON: that one is a possible theft and still goes out as it
//     happens;
//   · on the day it BEGAN, which is what the ledger list is filtered on.
//
// One difference, on purpose: the fleet summary leaves out what an operator
// has dismissed, and this keeps it, marked. Its band is still on the chart
// right above, and a summary reading "None today" under a FUEL DOWN band
// would contradict it (KDE 585S, dismissed at 07:37 on 27 Sep).
//
// The litres are the ledger's `stolenMl`, the figure the alert and the summary
// both quote. Same vocabulary rule as theirs: say what the tank did, and never
// the word theft.

import { fuelRateDetail, fuelRateKind } from './fuelEpisodes';

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};

/** The day's FUEL RATE / FUEL DOWN findings, oldest first. */
export function fuelRateFindings(drains = []) {
  const out = [];
  for (const d of drains) {
    if (d.drainCause === 'SIPHON') continue;
    const kind = fuelRateKind(d.causeReason);
    const at = ms(d.beganAt) ?? ms(d.detectedAt);
    if (!kind || at == null) continue;
    out.push({
      id: d.id,
      at,
      kind,
      litres: Number.isFinite(d.stolenMl) ? d.stolenMl / 1000 : null,
      detail: fuelRateDetail(d),
      dismissed: d.dismissedAt != null,
      dismissedAt: ms(d.dismissedAt),
      dismissedBy: d.dismissedBy?.fullName ?? null,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const L1 = (l) => `${l.toLocaleString('en-KE', { maximumFractionDigits: 1 })} L`;

/**
 * The summary's sentence for one unit, or null when there is nothing to say:
 * "2 drops beyond what this machine's measured burn or distance accounts for
 * (1 FUEL RATE, 1 FUEL DOWN), 31.4 L in all. 1 of them was dismissed."
 */
export function fuelRateSummaryText(findings) {
  if (!findings?.length) return null;
  const n = findings.length;
  const rate = findings.filter(f => f.kind === 'FUEL RATE').length;
  const down = n - rate;
  const split = [rate ? `${rate} FUEL RATE` : null, down ? `${down} FUEL DOWN` : null].filter(Boolean).join(', ');
  const total = findings.reduce((s, f) => s + (f.litres ?? 0), 0);
  const gone = findings.filter(f => f.dismissed).length;
  const dismissed = gone === 0 ? ''
    : gone === n ? (n === 1 ? ' It was dismissed.' : ' All were dismissed.')
    : ` ${gone} of them ${gone === 1 ? 'was' : 'were'} dismissed.`;
  return `${plural(n, 'drop', 'drops')} beyond what this machine's measured burn or distance `
    + `accounts for (${split}), ${L1(total)} in all.${dismissed}`;
}
