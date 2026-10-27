// Fleet days picked as one day or a range of them, for the vehicle panel's
// Fuel tab (operator, 28 Sep: "the date picker should be able to pick a range
// of dates or a single date") and its Alerts tab. Days are 'YYYY-MM-DD' keys
// on the fleet's calendar (lib/vehicleDay dayBounds), which sort as strings.

export function addDays(dayKey, n) {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Every day from `fromKey` to `toKey`, both included, at most `cap`. */
export function daysBetween(fromKey, toKey, cap = 366) {
  const out = [];
  for (let k = fromKey; k <= toKey && out.length < cap; k = addDays(k, 1)) out.push(k);
  return out;
}

/**
 * A picked range made sound: in order, not past `today`, and no longer than
 * `maxDays`. `keep` is the end the reader just set — the other one gives way,
 * so moving From back a fortnight pulls To with it rather than undoing the
 * pick.
 */
export function clampRange(from, to, today, maxDays, keep = 'to') {
  let f = from > today ? today : from;
  let t = to > today ? today : to;
  if (f > t) { if (keep === 'from') t = f; else f = t; }
  if (daysBetween(f, t, maxDays + 1).length > maxDays) {
    if (keep === 'from') t = addDays(f, maxDays - 1);
    else f = addDays(t, -(maxDays - 1));
  }
  return [f, t];
}

/**
 * Days of readings as one time-ordered run. Each day comes in order and days
 * do not overlap, but a reading on the stroke of midnight can be in both.
 * One day is handed back as it is, so a single day draws exactly as before.
 */
export function joinDays(parts) {
  const days = parts.filter((p) => p?.length);
  if (days.length <= 1) return days[0] ?? [];
  const out = [];
  let last = -Infinity;
  for (const p of days.flat().sort((a, b) => a.t - b.t)) {
    if (p.t === last) continue;
    out.push(p);
    last = p.t;
  }
  return out;
}

/**
 * A month of the picker's calendar: weeks of seven, Monday first, each cell a
 * day key or null outside the month. `monthKey` is 'YYYY-MM'.
 */
export function monthGrid(monthKey) {
  const first = `${monthKey}-01`;
  const lead = (new Date(`${first}T00:00:00.000Z`).getUTCDay() + 6) % 7;
  const cells = Array(lead).fill(null);
  for (let d = first; d.slice(0, 7) === monthKey; d = addDays(d, 1)) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** 'YYYY-MM' moved by `n` months. */
export function addMonths(monthKey, n) {
  const d = new Date(`${monthKey}-01T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

/**
 * The picker's two-click rule. The first click picks that one day; a second
 * picks the range between the two, whichever way round they came, and the same
 * day twice is still that one day. Returns [from, to].
 */
export function rangeFromClicks(first, second) {
  return second < first ? [second, first] : [first, second];
}

/**
 * How a sentence names the days: "today", "on 27 Sep", "from 21 Sep to
 * 27 Sep". `fmtDay` turns a key into "27 Sep".
 */
export function rangeWords(from, to, today, fmtDay) {
  if (from === to) return from === today ? 'today' : `on ${fmtDay(from)}`;
  return `from ${fmtDay(from)} to ${to === today ? 'today' : fmtDay(to)}`;
}
