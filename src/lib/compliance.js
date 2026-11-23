// Road Safety Compliance (operator, 2026-11-23; components/screens/
// ComplianceScreen): the page's own arithmetic, kept out of React so it can
// be tested. The server measures each requirement (server/compliance.go);
// this picks the period, sums the cards, colours the figures and filters
// the table. Pure: no React, no network.

import { dayStart, dayKey } from './samadReports';

const DAY = 86_400_000;

/** The period picker (spec: Today, This week, Last week, This month). */
export const PERIODS = [
  { key: 'today', label: 'Today', noun: 'today' },
  { key: 'week', label: 'This week', noun: 'this week' },
  { key: 'lastWeek', label: 'Last week', noun: 'last week' },
  { key: 'month', label: 'This month', noun: 'this month' },
];

/** The Monday 00:00 (Nairobi) of the fleet week holding ms. */
export function weekStart(ms) {
  const day = dayStart(ms);
  const dow = new Date(day + 3 * 3_600_000).getUTCDay(); // 0 = Sunday, in Nairobi
  return day - ((dow + 6) % 7) * DAY;
}

/** { from, to } in epoch ms for a period key, as the server takes them. */
export function periodRange(key, now = Date.now()) {
  if (key === 'week') return { from: weekStart(now), to: now };
  if (key === 'lastWeek') { const mon = weekStart(now); return { from: mon - 7 * DAY, to: mon }; }
  if (key === 'month') {
    const first = `${dayKey(now).slice(0, 8)}01`;
    return { from: Date.parse(`${first}T00:00:00+03:00`), to: now };
  }
  return { from: dayStart(now), to: now };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "16 – 22 Nov 2026", "26 Oct – 1 Nov 2026", "23 Nov 2026": the fleet days covered. */
export function periodWords({ from, to }) {
  const a = dayKey(from);
  const b = dayKey(Math.max(from, to - 1));
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  if (a === b) return `${bd} ${MONTHS[bm - 1]} ${by}`;
  if (ay !== by) return `${ad} ${MONTHS[am - 1]} ${ay} – ${bd} ${MONTHS[bm - 1]} ${by}`;
  if (am !== bm) return `${ad} ${MONTHS[am - 1]} – ${bd} ${MONTHS[bm - 1]} ${by}`;
  return `${ad} – ${bd} ${MONTHS[bm - 1]} ${by}`;
}

/**
 * The cards: the average of the rows that could be measured (a row "Not
 * monitored" or with nothing to measure is in no figure), how many are fully
 * met, how many have breaches, and the average per category. As the server's
 * PDF sums them (server/compliance.go summarise).
 */
export function summarise(rows) {
  const measured = (rows ?? []).filter((r) => typeof r.compliance === 'number');
  const avg = (list) => (list.length ? Math.round(list.reduce((s, r) => s + r.compliance, 0) / list.length) : null);
  const categories = {};
  for (const c of new Set(measured.map((r) => r.category))) categories[c] = avg(measured.filter((r) => r.category === c));
  return {
    overall: avg(measured),
    met: measured.filter((r) => r.compliance === 100).length,
    withBreaches: measured.filter((r) => r.compliance < 100).length,
    measured: measured.length,
    categories,
  };
}

/** The pill's colour: green 100 % "Met", amber 60–99 %, red below 60 %, grey when not measured. */
export function tone(compliance) {
  if (typeof compliance !== 'number') return 'none';
  if (compliance === 100) return 'met';
  return compliance >= 60 ? 'amber' : 'red';
}

/** The pill's words. */
export function pillWords(row) {
  if (!row.monitored) return 'Not monitored';
  if (typeof row.compliance !== 'number') return '—';
  return row.compliance === 100 ? 'Met' : `${row.compliance}%`;
}

/** One unit as the "Most breaches" column and the side panel say it. */
export function unitWords(row, u) {
  if (row.unitWord === 'not reporting') return `${u.plate} not reporting`;
  return row.unitWord ? `${u.plate} ${u.n} ${row.unitWord}` : `${u.plate} ${u.n}`;
}

/** The "Most breaches" column: the two units with the most. */
export function mostBreaches(row, unit = '') {
  const list = (row.byUnit ?? []).filter((u) => !unit || u.vehicleId === unit);
  return list.length ? list.slice(0, 2).map((u) => unitWords(row, u)).join(' · ') : '—';
}

export const CATEGORIES = ['Operational', 'Vehicle'];

/**
 * What "OK" means for each requirement, in plain words (operator, 2026-11-23:
 * "make the explanation straightforward"). The side panel says it under the
 * sum: "11 of 12 trucks were OK this week → 91%".
 */
const OK_MEANS = {
  '5.1.3': 'the dashcam never caught the driver on the phone.',
  '5.1.4a': 'the truck worked 8 hours or less that day, and 48 hours or less that week.',
  '5.1.4b': 'the truck worked 12 hours or less that day with overtime, and 60 hours or less that week.',
  '5.1.4c': 'the truck worked over 8 hours on fewer than 3 days that week.',
  '5.1.4d': 'the driver stopped for 30 minutes after every 4.5 hours of driving.',
  '5.1.4e': 'the truck rested for 11 hours in a row in every 24 hours.',
  '5.1.4f': 'the truck rested for 24 hours in a row that week.',
  '5.1.4g': 'the truck was driven 9 hours or less that day, and 48 hours or less that week.',
  '5.1.5': 'the tracker sent the truck\'s position at least once.',
  '5.1.6': 'someone reviewed the alarm on the Alerts page within 6 hours.',
  '5.2.2e': 'the dashcam never caught the driver without a seat belt.',
};

/**
 * The side panel's per-unit heading, in the row's own words (operator,
 * 2026-11-23: "units with On phone incidents", not "By unit").
 */
const UNITS_TITLE = {
  '5.1.3': 'Units with On phone incidents',
  '5.1.5': 'Units not reporting',
  '5.1.6': 'Units with alarms reviewed late',
  '5.2.2e': 'Units with No seatbelt incidents',
  '5.2.2h': 'Units over the speed limit',
};

export function unitsTitle(row) {
  if (UNITS_TITLE[row.ref]) return UNITS_TITLE[row.ref];
  return row.ref?.startsWith('5.1.4') ? 'Units that broke this hours rule' : 'Units in breach';
}

/** "OK means: …" for a row; the limiter's speed is read off its measure. */
export function okMeans(row) {
  if (row.ref === '5.2.2h') {
    const kmh = /(\d+(?:\.\d+)?) km\/h/.exec(row.measure ?? '')?.[1];
    return `the truck never went faster than ${kmh ? `${kmh} km/h` : 'the speed-limiter setting'}.`;
  }
  return OK_MEANS[row.ref] ?? null;
}

/**
 * The plain sum for the side panel: { text, pct } such as
 * "11 of 12 trucks were OK this week", or why there is none.
 */
export function plainSum(row, periodNoun) {
  if (!row.monitored) return { text: 'Not checked: driver hours were not being tracked yet in this period.', pct: null };
  if (!row.total) return { text: row.result, pct: null };
  return { text: `${row.passed} of ${row.total} ${row.noun} were OK ${periodNoun}`, pct: row.compliance };
}

/**
 * The table's rows under the filters: the search (reference or words), a
 * category, only those with breaches, one unit (the rows where it has any).
 */
export function filterRows(rows, { q = '', category = 'all', breaches = false, unit = '' } = {}) {
  const needle = q.trim().toLowerCase();
  return (rows ?? []).filter((r) => {
    if (category !== 'all' && r.category !== category) return false;
    if (breaches && !(typeof r.compliance === 'number' && r.compliance < 100)) return false;
    if (unit && !(r.byUnit ?? []).some((u) => u.vehicleId === unit)) return false;
    if (needle && !`${r.ref} ${r.requirement} ${r.measure}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

/**
 * The unit picker: every unit the server lists (operator, 2026-11-23: all
 * units, not only those with breaches), with any unit a row names that the
 * list lacks; plate order.
 */
export function unitsNamed(rows, vehicles = []) {
  const seen = new Map();
  for (const v of vehicles ?? []) if (v?.vehicleId && !seen.has(v.vehicleId)) seen.set(v.vehicleId, v.plate || v.vehicleId);
  for (const r of rows ?? []) for (const u of r.byUnit ?? []) if (!seen.has(u.vehicleId)) seen.set(u.vehicleId, u.plate);
  return [...seen].map(([id, plate]) => ({ id, plate })).sort((a, b) => a.plate.localeCompare(b.plate));
}
