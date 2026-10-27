import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HealthSummary, CheckList, healthVerdict, bySeverity } from './FaultsParts';

const ok = (name) => ({ name, state: 'Reporting', tone: 'ok' });

describe('healthVerdict', () => {
  it('lets the worst state decide', () => {
    expect(healthVerdict([ok('A'), ok('B')]).title).toBe('All parts reporting');
    expect(healthVerdict([ok('A'), { name: 'B', state: 'Not reporting', tone: 'warn' }]).title).toBe('1 part needs attention');
    const bad = healthVerdict([{ name: 'A', tone: 'alert' }, { name: 'B', tone: 'alert' }, { name: 'C', tone: 'warn' }]);
    expect(bad.title).toBe('2 faults reported');
    expect(bad.sub).toContain('1 more');
    expect(healthVerdict([{ name: 'A', tone: 'none' }]).title).toBe('Nothing reporting');
  });
});

describe('CheckList and HealthSummary', () => {
  const items = [ok('Odometer'), { name: 'Engine-hours meter', state: 'No reading', tone: 'none' },
    { name: 'Fuel probe', state: 'Fault', tone: 'alert', icon: 'ti-gas-station' }];

  it('puts faults first and gives each part its icon', () => {
    expect(bySeverity(items).map(c => c.name)).toEqual(['Fuel probe', 'Odometer', 'Engine-hours meter']);
    const html = renderToStaticMarkup(h(CheckList, { items }));
    expect(html.indexOf('Fuel probe')).toBeLessThan(html.indexOf('Odometer'));
    expect(html).toContain('ti-gas-station');
  });

  it('counts each state under a strip of one segment per part', () => {
    const html = renderToStaticMarkup(h(HealthSummary, { items, asOf: '07:37' }));
    expect(html.match(/fx-strip-seg /g)).toHaveLength(3);
    expect(html).toContain('1 fault');
    expect(html).toContain('1 no reading');
    expect(html).toContain('last report 07:37');
  });
});
