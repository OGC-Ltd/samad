import { describe, it, expect } from 'vitest';
import { rangeBounds, fleetMidnightIso } from './useVehicleFeed';
import { dayHeading } from '../components/layout/UnitFeed';

describe('unit feed date range', () => {
  it('runs from fleet midnight of the first day to fleet midnight after the last', () => {
    // Nairobi is UTC+3: its midnight is 21:00 UTC the evening before.
    expect(fleetMidnightIso('2026-10-01')).toBe('2026-09-30T21:00:00.000Z');
    expect(rangeBounds('2026-09-30', '2026-10-01')).toEqual({
      start: '2026-09-29T21:00:00.000Z',
      end: '2026-10-01T21:00:00.000Z',
    });
  });

  it('has no bounds without both days', () => {
    expect(rangeBounds(null, '2026-10-01')).toBeNull();
    expect(rangeBounds('2026-10-01', null)).toBeNull();
  });
});

describe('dayHeading', () => {
  it('names today and yesterday, and dates the rest', () => {
    expect(dayHeading('2026-10-02', '2026-10-02')).toBe('Today');
    expect(dayHeading('2026-10-01', '2026-10-02')).toBe('Yesterday');
    expect(dayHeading('2026-09-28', '2026-10-02')).toMatch(/28 Sep/);
  });
});
