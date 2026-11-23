import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComplianceView, UnitList } from './ComplianceScreen';

// A stubbed /api/v1/compliance response (server/compliance.go's shape).
const data = {
  units: 12,
  monitoredSince: '2026-11-07T03:08:00Z',
  rows: [
    { ref: '5.1.3', category: 'Operational', requirement: 'No phone use while driving',
      measure: 'Dashcam alarms: phone use, smoking, driver distracted', result: '14 alarms · 3 of 12 units', compliance: 75, monitored: true, breaches: 14,
      byUnit: [{ vehicleId: '1', plate: 'KDT953D', driver: 'FRED SIMIYU', n: 9 }, { vehicleId: '2', plate: 'KCN530E', n: 3 }], byDay: [] },
    { ref: '5.1.4d', category: 'Operational', requirement: 'A 30-minute break after every 4½ hours of driving', measure: 'Driving = engine on at ≥ 1 km/h',
      result: '9 breaches · 37 of 46 driver-days within', compliance: 80, monitored: true, breaches: 9,
      byUnit: [{ vehicleId: '3', plate: 'KDR336R', n: 3 }], byDay: [] },
    { ref: '5.1.5', category: 'Operational', requirement: "Every truck's tracker is working", measure: 'Units sending positions · units with dashcam',
      result: '12 of 12 reporting · 12 of 12 with dashcam', compliance: 100, monitored: true, breaches: 0, unitWord: 'not reporting', byUnit: [], byDay: [] },
    { ref: '5.2.2e', category: 'Vehicle', requirement: 'Seat belts worn', measure: 'Dashcam no-seatbelt alarms',
      result: '61 alarms · 3 of 12 units', compliance: 75, monitored: true, breaches: 61, byUnit: [], byDay: [] },
  ],
};

const range = { from: Date.parse('2026-11-16T00:00:00+03:00'), to: Date.parse('2026-11-23T00:00:00+03:00') };
const render = (props) => renderToStaticMarkup(h(ComplianceView, { data, periodKey: 'lastWeek', range, ...props }));
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('ComplianceView', () => {
  it('shows one category at a time, as tabs', () => {
    const operational = render();
    for (const r of data.rows.filter((x) => x.category === 'Operational')) {
      expect(text(operational)).toContain(r.requirement);
      expect(operational).toContain(r.result);
    }
    expect(operational).not.toContain('Seat belts worn');
    expect(text(operational)).toMatch(/Operational requirements 3 85%/);
    expect(text(operational)).toMatch(/Vehicle requirements 1 75%/);
    expect(operational).toContain('aria-selected="true" aria-controls="cmp-tabpanel" class="cmp-tab cmp-tab--on">Operational');

    const vehicle = render({ initialTab: 'Vehicle' });
    expect(vehicle).toContain('Seat belts worn');
    expect(vehicle).not.toContain('No phone use while driving');
  });

  it('shows no reference numbers', () => {
    const t = text(render()) + text(render({ initialTab: 'Vehicle' }));
    for (const r of data.rows) expect(t).not.toContain(r.ref);
    expect(t).not.toMatch(/\bRef\b/);
  });

  it('names each requirement without the line on how it is measured', () => {
    const t = text(render());
    expect(t).toContain('No phone use while driving');
    expect(t).not.toContain('Dashcam alarms: phone use'); // the measure is in the side panel only
    expect(t).not.toContain('how it is measured');
  });

  it('renders the rows from the response', () => {
    const t = text(render());
    expect(t).toContain('KDT953D 9 · KCN530E 3');
    expect(t).toContain('Safety Compliance');
    expect(t).not.toContain('Road Safety Compliance');
    expect(t).not.toContain('Measured by the system'); // the line under the title is gone (operator, 2026-11-23)
    expect(t).not.toContain('IntelliFleet360'); // the source note is gone (operator, 2026-11-23)
  });

  it('sums the cards from the rows', () => {
    const t = text(render());
    // (75 + 80 + 100 + 75) / 4 = 82.5 → 83; one fully met, three with breaches; 12 units.
    expect(t).toMatch(/83% Compliance last week/);
    expect(t).toMatch(/Fully met 1/);
    expect(t).toMatch(/With breaches 3/);
    expect(t).toMatch(/Units monitored 12/);
    expect(t).toMatch(/Operational 85%/); // (75 + 80 + 100) / 3
    expect(t).toMatch(/Vehicle 75%/);
    expect(render()).toContain('cmp-pill cmp-tone--met');
  });

  it('shows an hours row before monitoring as "Not monitored", in no figure', () => {
    const before = {
      ...data,
      rows: [
        { ...data.rows[0] },
        { ref: '5.1.4a', category: 'Operational', requirement: "No more than 8 hours' work a day", measure: 'Engine on or moving, per vehicle',
          result: 'Not monitored', compliance: null, monitored: false, breaches: 0, byUnit: [], byDay: [] },
      ],
    };
    const html = render({ data: before });
    expect(html).toContain('cmp-pill cmp-tone--none');
    expect(text(html)).toContain('Not monitored');
    expect(text(html)).not.toContain('100%');
    // Only 5.1.3 is measured: the overall is its 75 %, not pulled up by the unmonitored row.
    expect(text(html)).toMatch(/75% Compliance last week/);
  });

  it('opens a unit to its incidents', () => {
    const row = { ref: '5.1.3', byUnit: [
      { vehicleId: '1', plate: 'KDT953D', driver: 'FRED SIMIYU', n: 2, items: [
        { at: '2026-11-23T03:40:00Z', what: 'Phone Use', speed: 54.2, lat: -1.3, lon: 36.8 },
        { at: '2026-11-22T15:05:00Z', what: 'Phone Use', driver: 'MARK WEKESA' },
      ] },
      { vehicleId: '2', plate: 'KCN530E', n: 1 },
    ] };
    const shut = renderToStaticMarkup(h(UnitList, { row }));
    expect(shut).toContain('aria-expanded="false"');
    expect(shut).not.toContain('Phone Use');
    const t = text(renderToStaticMarkup(h(UnitList, { row, initialOpen: '1' })));
    expect(t).toContain('Mon 23 Nov, 06:40 Phone Use · 54 km/h · Map');
    expect(t).toContain('Sun 22 Nov, 18:05 Phone Use · MARK WEKESA');
    expect(renderToStaticMarkup(h(UnitList, { row: { ref: '5.1.4c', unitWord: 'days', byUnit: [
      { vehicleId: '1', plate: 'KD1', n: 3, items: [{ at: '2026-11-22T21:00:00Z', what: 'worked 9 h 30 min', wholeDay: true }] },
    ] }, initialOpen: '1' }))).toContain('Mon 23 Nov');
    const rest = text(renderToStaticMarkup(h(UnitList, { row: { ref: '5.1.4e', byUnit: [
      { vehicleId: '1', plate: 'KDU566F', n: 1, items: [{ at: '2026-11-22T06:32:00Z', until: '2026-11-23T06:32:00Z',
        what: 'Longest rest was 6 h 43 min. Needed 11 h (4 h 17 min short).' }] },
    ] }, initialOpen: '1' })));
    expect(rest).toContain('Sun 22 Nov, 09:32 → Mon 23 Nov, 09:32 Longest rest was 6 h 43 min. Needed 11 h (4 h 17 min short).');
    const week = text(renderToStaticMarkup(h(UnitList, { row: { ref: '5.1.4f', byUnit: [
      { vehicleId: '1', plate: 'KD1', n: 1, items: [{ at: '2026-11-15T22:00:00Z', until: '2026-11-22T22:00:00Z', wholeDay: true, what: 'x' }] },
    ] }, initialOpen: '1' })));
    expect(week).toContain('Mon 16 Nov → Sun 22 Nov');
  });

  it('says it is loading, or why it failed, before any rows', () => {
    expect(text(render({ data: null, loading: true }))).toContain('Measuring the Requirements');
    expect(text(render({ data: null, error: new Error('Network down') }))).toContain('Network down');
  });
});
