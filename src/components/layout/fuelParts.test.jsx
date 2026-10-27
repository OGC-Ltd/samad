import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DayGroups, TankGauge, tankBand } from './FuelParts';

describe('DayGroups', () => {
  it('puts the nine figures in three labelled rows', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ label: `F${i}`, value: String(i) }));
    const html = renderToStaticMarkup(h(DayGroups, { items }));
    expect(html.match(/fp-group-row/g)).toHaveLength(3);
    expect(html).toContain('Engine &amp; speed');
  });
});

describe('tankBand', () => {
  it('is low below the reserve, reserve up to half, good above', () => {
    expect(tankBand(10, 25)).toBe('low');
    expect(tankBand(25, 25)).toBe('reserve');
    expect(tankBand(49, 25)).toBe('reserve');
    expect(tankBand(50, 25)).toBe('good');
    expect(tankBand(null, 25)).toBe('none');
  });
});

describe('TankGauge', () => {
  it('turns the arrow to the level and colours it by band', () => {
    const html = renderToStaticMarkup(h(TankGauge, { pct: 18, litres: 69, capacityL: 382, reservePct: 25 }));
    expect(html).toContain('fp-tank--low');
    expect(html).toContain('below reserve');
    expect(html).toContain('313 L');
    // 18% of a 220° sweep from E at -110°: -70.4°, drawn as rotate(70.4deg)
    expect(html).toContain("rotate(70.4deg)");
    // Ticks at 0, 5, 10, 15 are lit
    expect(html.match(/fp-tick--lit/g)).toHaveLength(4);
  });

  it('rests at E, grey, without a level, and shows the probe state', () => {
    const html = renderToStaticMarkup(h(TankGauge, { pct: null, litres: null, capacityL: null, reservePct: 25, probeFault: true }));
    expect(html).toContain('fp-tank--none');
    expect(html).toContain('Probe fault');
    expect(html).not.toContain('fp-tick--lit');
  });
});
