import { describe, it, expect } from 'vitest';
import { filterRows, mostBreaches, okMeans, periodRange, periodWords, pillWords, plainSum, summarise, tone, unitsNamed, unitsTitle, weekStart } from './compliance';

// Mon 23 Nov 2026, 10:00 in Nairobi.
const NOW = Date.parse('2026-11-23T10:00:00+03:00');
const ms = (s) => Date.parse(s);

const rows = [
  { ref: '5.1.3', category: 'Operational', requirement: 'No phone use while driving', measure: 'Dashcam phone-use alarms', compliance: 75, monitored: true,
    byUnit: [{ vehicleId: '1', plate: 'KDT953D', n: 9 }, { vehicleId: '2', plate: 'KCN530E', n: 3 }, { vehicleId: '3', plate: 'KDA1', n: 1 }] },
  { ref: '5.1.4a', category: 'Operational', requirement: 'Working hours', measure: 'Engine on or moving', compliance: null, monitored: false, byUnit: [] },
  { ref: '5.1.4c', category: 'Operational', requirement: 'Overtime is not structural', measure: 'Days over 8 h', compliance: 50, monitored: true, unitWord: 'days',
    byUnit: [{ vehicleId: '1', plate: 'KDT953D', n: 4 }] },
  { ref: '5.1.5', category: 'Operational', requirement: 'Telematics', measure: 'Units sending positions', compliance: 100, monitored: true, unitWord: 'not reporting', byUnit: [] },
  { ref: '5.2.2e', category: 'Vehicle', requirement: 'Seat belts', measure: 'No-seatbelt alarms', compliance: 80, monitored: true,
    byUnit: [{ vehicleId: '2', plate: 'KCN530E', n: 24 }] },
];

describe('periods', () => {
  it('starts the week on Monday in Nairobi', () => {
    expect(weekStart(NOW)).toBe(ms('2026-11-23T00:00:00+03:00'));
    expect(weekStart(ms('2026-11-22T23:30:00+03:00'))).toBe(ms('2026-11-16T00:00:00+03:00'));
  });
  it('gives each picker choice its range', () => {
    expect(periodRange('today', NOW)).toEqual({ from: ms('2026-11-23T00:00:00+03:00'), to: NOW });
    expect(periodRange('week', NOW)).toEqual({ from: ms('2026-11-23T00:00:00+03:00'), to: NOW });
    expect(periodRange('lastWeek', NOW)).toEqual({ from: ms('2026-11-16T00:00:00+03:00'), to: ms('2026-11-23T00:00:00+03:00') });
    expect(periodRange('month', NOW)).toEqual({ from: ms('2026-11-01T00:00:00+03:00'), to: NOW });
  });
  it('says the fleet days a period covers', () => {
    expect(periodWords(periodRange('lastWeek', NOW))).toBe('16 – 22 Nov 2026');
    expect(periodWords(periodRange('today', NOW))).toBe('23 Nov 2026');
    expect(periodWords({ from: ms('2026-10-26T00:00:00+03:00'), to: ms('2026-11-02T00:00:00+03:00') })).toBe('26 Oct – 1 Nov 2026');
  });
});

describe('summarise', () => {
  it('averages the measured rows only, and per category', () => {
    expect(summarise(rows)).toEqual({ overall: 76, met: 1, withBreaches: 3, measured: 4, categories: { Operational: 75, Vehicle: 80 } });
  });
  it('has no overall figure when nothing could be measured', () => {
    expect(summarise([rows[1]]).overall).toBe(null);
  });
});

describe('the pill', () => {
  it('is green at 100, amber 60–99, red under 60, grey unmeasured', () => {
    expect([100, 99, 60, 59, 0, null].map(tone)).toEqual(['met', 'amber', 'amber', 'red', 'red', 'none']);
    expect(pillWords(rows[3])).toBe('Met');
    expect(pillWords(rows[0])).toBe('75%');
    expect(pillWords(rows[1])).toBe('Not monitored');
  });
});

describe('the table', () => {
  it('names the two units with the most, in the row\'s own words', () => {
    expect(mostBreaches(rows[0])).toBe('KDT953D 9 · KCN530E 3');
    expect(mostBreaches(rows[2])).toBe('KDT953D 4 days');
    expect(mostBreaches(rows[3])).toBe('—');
    expect(mostBreaches({ unitWord: 'not reporting', byUnit: [{ vehicleId: '9', plate: 'KD9', n: 0 }] })).toBe('KD9 not reporting');
    expect(mostBreaches(rows[0], '2')).toBe('KCN530E 3');
  });
  it('filters by words, category, breaches and unit', () => {
    const refs = (o) => filterRows(rows, o).map((r) => r.ref);
    expect(refs({ q: 'seat' })).toEqual(['5.2.2e']);
    expect(refs({ q: '5.1.4' })).toEqual(['5.1.4a', '5.1.4c']);
    expect(refs({ category: 'Vehicle' })).toEqual(['5.2.2e']);
    expect(refs({ breaches: true })).toEqual(['5.1.3', '5.1.4c', '5.2.2e']);
    expect(refs({ unit: '2' })).toEqual(['5.1.3', '5.2.2e']);
  });
  it('lists every unit named, by plate', () => {
    expect(unitsNamed(rows)).toEqual([{ id: '2', plate: 'KCN530E' }, { id: '3', plate: 'KDA1' }, { id: '1', plate: 'KDT953D' }]);
  });
  it('lists every unit the server sends, not only those with breaches', () => {
    const all = unitsNamed(rows, [{ vehicleId: '9', plate: 'KBZ900A' }, { vehicleId: '1', plate: 'KDT953D' }]);
    expect(all.map((u) => u.plate)).toEqual(['KBZ900A', 'KCN530E', 'KDA1', 'KDT953D']);
  });
});

describe('the plain explanation', () => {
  it('says how many were OK, and the figure', () => {
    const seatbelts = { ref: '5.2.2e', monitored: true, compliance: 91, passed: 11, total: 12, noun: 'trucks' };
    expect(plainSum(seatbelts, 'today')).toEqual({ text: '11 of 12 trucks were OK today', pct: 91 });
    expect(okMeans(seatbelts)).toBe('the dashcam never caught the driver without a seat belt.');
  });
  it('says working days for the hours rules', () => {
    expect(plainSum({ ref: '5.1.4d', monitored: true, compliance: 80, passed: 37, total: 46, noun: 'working days' }, 'this week').text)
      .toBe('37 of 46 working days were OK this week');
    expect(okMeans({ ref: '5.1.4d' })).toBe('the driver stopped for 30 minutes after every 4.5 hours of driving.');
  });
  it('reads the limiter speed off the measure', () => {
    expect(okMeans({ ref: '5.2.2h', measure: 'Highest speed recorded vs 70 km/h limit (alarms and positions)' })).toBe('the truck never went faster than 70 km/h.');
  });
  it('says when hours were not tracked, or there was nothing to count', () => {
    expect(plainSum({ monitored: false }, 'this week').pct).toBe(null);
    expect(plainSum({ monitored: false }, 'this week').text).toMatch(/^Not checked/);
    expect(plainSum({ monitored: true, total: 0, result: 'No driver-days in the period' }, 'today').text).toBe('No driver-days in the period');
  });
  it('names the per-unit list in the row\'s own words', () => {
    expect(unitsTitle({ ref: '5.1.3' })).toBe('Units with On phone incidents');
    expect(unitsTitle({ ref: '5.2.2e' })).toBe('Units with No seatbelt incidents');
    expect(unitsTitle({ ref: '5.1.4d' })).toBe('Units that broke this hours rule');
  });
  it('has words for every requirement', () => {
    for (const ref of ['5.1.3', '5.1.4a', '5.1.4b', '5.1.4c', '5.1.4d', '5.1.4e', '5.1.4f', '5.1.4g', '5.1.5', '5.1.6', '5.2.2e', '5.2.2h']) {
      expect(okMeans({ ref, measure: '70 km/h' })).toBeTruthy();
    }
  });
});
