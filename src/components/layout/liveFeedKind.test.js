import { describe, it, expect } from 'vitest';
import { feedKind } from './LiveFeed';

const k = (text, type = 'info') => feedKind({ text, type }).icon;

describe('feedKind', () => {
  it('reads what happened from the sentences the fleet publishes', () => {
    expect(k('KDW 548J arrived at Kitale town.', 'success')).toBe('map-pin-check');
    expect(k('KDW 593J left Kabras Sugar Factory (West Kenya).')).toBe('arrow-up-right');
    expect(k('KHMA994J refuelled 177.1 L at D267, 2.93 km from Mwonyonyi.')).toBe('gas-station');
  });

  it('lets severity win over the wording', () => {
    expect(k('KCQ 735A left the zone', 'critical')).toBe('alert-octagon');
    expect(k('KCQ 735A arrived late', 'warning')).toBe('alert-triangle');
  });

  it('shows maintenance tools for every repair notice, whatever its wording', () => {
    const line = 'CTR 19 · RT-2026-00011 · Fuel probe: fixing remotely · ticket issued';
    for (const source of ['repair', 'repair_flag', 'repair_ticket', 'repair_verified']) {
      expect(feedKind({ text: line, type: 'info', source }).icon).toBe('tools');
    }
    expect(feedKind({ text: line, type: 'warning', source: 'repair' })).toEqual({ icon: 'tools', tone: 'warning' });
    // A weighbridge ticket still gets its scale.
    expect(k('Ticket 4410 weighed 32.1 tonne')).toBe('scale');
  });

  it('falls back to a plain point for anything unrecognised or missing', () => {
    expect(k('Something else entirely')).toBe('point');
    expect(feedKind(undefined).icon).toBe('point');
  });
});
