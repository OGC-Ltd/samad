import { describe, expect, it } from 'vitest';
import { eventMl } from './eventLitres';

describe('eventMl', () => {
  it('takes ml when the server sends it', () => {
    expect(eventMl({ ml: 120_000, detail: 'KTCC 453L refuelled 99 L.' })).toBe(120_000);
  });

  it('reads the volume, not the plate, from a feed line (issue #47)', () => {
    expect(eventMl({ detail: 'KTCC 453L refuelled 120 L at Ndhiwa-Uriri. The tank now holds 300 L.' })).toBe(120_000);
    expect(eventMl({ detail: 'POSSIBLE THEFT — FUEL DRAINED FROM A PARKED MACHINE: KTCC 453L lost 19.4 L (210.0 L to 190.6 L)' })).toBe(19_400);
  });

  it('gives no volume for a line that only carries the plate', () => {
    expect(eventMl({ detail: 'FUEL DROP REVIEWED: KTCC 453L; it will be included in the fuel summary.' })).toBeNull();
  });

  it('still reads the ledger detail', () => {
    expect(eventMl({ detail: '120.0 L · probe saw 118.0 L' })).toBe(120_000);
    expect(eventMl({ detail: '0.4 L' })).toBe(400);
  });

  it('is null with nothing to read', () => {
    expect(eventMl({})).toBeNull();
    expect(eventMl(null)).toBeNull();
  });
});
