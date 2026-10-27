import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadingsCard, FactsCard, OverspeedReadout, DriverRow, SummaryCard, initialsOf, avatarHue } from './OverviewParts';

describe('ReadingsCard', () => {
  it('draws the fuel level bar in the tank gauge band, and dashes a missing value', () => {
    const html = renderToStaticMarkup(h(ReadingsCard, { reservePct: 25, items: [
      { icon: 'ti-gas-station', label: 'Fuel level', value: '18%', tone: 'alert', level: 18 },
      { icon: 'ti-road', label: 'Odometer', value: null },
    ] }));
    expect(html).toContain('ov-level--low');
    expect(html).toContain('width:18%');
    expect(html).toContain('ov-cell--alert');
    expect(html).toContain('title="Not available"');
    expect(html.match(/class="ov-level /g)).toHaveLength(1);
  });
});

describe('FactsCard', () => {
  it('lays the facts out one column each', () => {
    const html = renderToStaticMarkup(h(FactsCard, { items: [{ label: 'Type', value: 'Truck' }, { label: 'Load', value: null }] }));
    expect(html).toContain('--ov-cols:2');
    expect(html).toContain('Truck');
    expect(html).toContain('title="Not available"');
  });
});

describe('OverspeedReadout', () => {
  const fmtMinutes = (m) => `${Math.round(m)} min`;
  it('names the worst run and the time over in all', () => {
    const runs = [
      { start: 0, end: 120_000, max: 87, limit: 80 },
      { start: 600_000, end: 780_000, max: 104, limit: 80 },
    ];
    const html = renderToStaticMarkup(h(OverspeedReadout, { runs, topSpeed: 104, limit: 80, hasPings: true, fmtMinutes }));
    expect(html).toContain('Worst peak');
    expect(html).toContain('104 km/h');
    expect(html).toContain('+24 over 80');
    expect(html).toContain('5 min');
  });

  it('shows the top speed on a clean day, and dashes without readings', () => {
    const clean = renderToStaticMarkup(h(OverspeedReadout, { runs: [], topSpeed: 62, limit: 80, hasPings: true, fmtMinutes }));
    expect(clean).toContain('Top speed');
    expect(clean).toContain('none today');
    const none = renderToStaticMarkup(h(OverspeedReadout, { runs: [], topSpeed: null, limit: 80, hasPings: false, fmtMinutes }));
    expect(none).toContain('No readings');
  });
});

describe('driver avatar', () => {
  it('takes the first and last initials, and keeps one colour per name', () => {
    expect(initialsOf('Juma Ali Mwakilema')).toBe('JM');
    expect(initialsOf('juma')).toBe('JU');
    expect(avatarHue('Juma Mwakilema')).toBe(avatarHue('Juma Mwakilema'));
  });

  it('shows initials and opens the driver where it may, an outlined person where none is assigned', () => {
    const named = renderToStaticMarkup(h(DriverRow, { name: 'Juma Mwakilema', rating: '4.3 / 5', droveToday: true, onOpen: () => {} }));
    expect(named).toContain('>JM<');
    expect(named).toContain('<button');
    expect(named).toContain('Drove today');
    const none = renderToStaticMarkup(h(DriverRow, { name: null, rating: null }));
    expect(none).toContain('ov-av--none');
    expect(none).toContain('No driver assigned');
    expect(none).not.toContain('<button');
  });
});

describe('SummaryCard', () => {
  it('leads with the sentence and tints the flags', () => {
    const html = renderToStaticMarkup(h(SummaryCard, {
      lead: 'LMV 26 is moving at 92 km/h.', asOf: '07:33',
      items: [{ icon: 'ti-gauge', tone: 'alert', text: 'Over the 80 km/h limit.' }, { icon: 'ti-flag', text: 'Heading to the mill.' }],
    }));
    expect(html).toContain('from live readings · 07:33');
    expect(html).toContain('ov-sum-item--alert');
    expect(html.indexOf('moving at 92')).toBeLessThan(html.indexOf('Over the 80'));
  });
});
