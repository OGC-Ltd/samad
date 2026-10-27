import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpeedNow, DayStrip, DaySummary, OverspeedTimeline, meterScale } from './SafetyParts';

const fmtMinutes = (m) => `${Math.round(m)} min`;

describe('SpeedNow', () => {
  it('says how far over and draws the excess past the limit mark in red on the gauge', () => {
    const html = renderToStaticMarkup(h(SpeedNow, { speed: 96, limit: 80, assumed: false, engineWord: 'On', online: true }));
    expect(html).toContain('sf-now--over');
    expect(html).toContain('16 km/h over');
    expect(html).toContain('sf-gauge-over');
    expect(html).toContain('Engine on');
    expect(html).not.toContain('assumed');
  });

  it('says how far under while moving, and flags an assumed limit', () => {
    const html = renderToStaticMarkup(h(SpeedNow, { speed: 50, limit: 80, assumed: true, engineWord: null, online: true }));
    expect(html).toContain('30 km/h under');
    expect(html).not.toContain('sf-gauge-over');
    expect(html).toContain('assumed');
    expect(html).toContain('Engine unknown');
  });

  it('keeps the limit inside the meter and the speed on it', () => {
    expect(meterScale(0, 80)).toBe(120);
    expect(meterScale(150, 80)).toBeCloseTo(165);
  });
});

describe('OverspeedTimeline and DayStrip', () => {
  const day = new Date(2026, 9, 2, 0, 0).getTime();
  const runs = [
    { start: day + 7 * 3600_000, end: day + 7 * 3600_000 + 120_000, max: 87, limit: 80 },
    { start: day + 16 * 3600_000, end: day + 16 * 3600_000 + 30_000, max: 92, limit: 80 },
  ];

  it('lists newest first with the peak, the excess and how long, and marks the worst', () => {
    const html = renderToStaticMarkup(h(OverspeedTimeline, { runs, fmtMinutes }));
    expect(html.indexOf('<strong>92</strong>')).toBeLessThan(html.indexOf('<strong>87</strong>'));
    expect(html.match(/sf-ev-row--worst/g)).toHaveLength(1);
    expect(html).toContain('+12');
    expect(html).toContain('for 2 min');
    expect(html).toContain('for under a minute');
  });

  it('marks each run on the day track', () => {
    const html = renderToStaticMarkup(h(DayStrip, { runs, now: day + 20 * 3600_000 }));
    expect(html.match(/sf-strip-run/g)).toHaveLength(2);
  });

  it('draws the moving spans under the runs', () => {
    const moving = [{ start: day + 6 * 3600_000, end: day + 8 * 3600_000 }];
    const html = renderToStaticMarkup(h(DayStrip, { runs, moving, now: day + 20 * 3600_000 }));
    expect(html.match(/sf-strip-move/g)).toHaveLength(1);
  });

  it('gives each figure its context line', () => {
    const html = renderToStaticMarkup(h(DaySummary, {
      hasPings: true, topSpeed: 92, limit: 80, runs, movingMin: 130, moving: [], fmtMinutes, now: day + 20 * 3600_000,
    }));
    expect(html).toContain('12 over the limit');
    expect(html).toContain('Worst +12 km/h');
    expect(html).toContain('of 130 min moving');
    expect(html.match(/sf-stat--alert/g)).toHaveLength(3);
  });

  it('shows dashes and no strip without readings', () => {
    const html = renderToStaticMarkup(h(DaySummary, {
      hasPings: false, topSpeed: null, limit: 80, runs: [], movingMin: null, moving: [], fmtMinutes,
    }));
    expect(html).toContain('No readings');
    expect(html).not.toContain('sf-strip');
  });
});
