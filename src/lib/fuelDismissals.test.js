import { describe, it, expect } from 'vitest';
import { withoutDismissed } from './fuelDismissals.js';
import { deriveStatus } from './vehicleMap.js';

const flagged = { id: 'EX 22', status: 'theft', fuelIncident: { id: 'inc-1' }, speed: 0, engine: 'on', connectionOnline: true, capturedAtMs: Date.now(), movement: { state: 'idling' } };
const clean   = { id: 'T 1', status: 'ok', fuelIncident: null, speed: 30 };

describe('withoutDismissed', () => {
  it('returns the same array when nothing is dismissed', () => {
    const fleet = [flagged, clean];
    expect(withoutDismissed(fleet, new Set(), deriveStatus)).toBe(fleet);
    expect(withoutDismissed(fleet, new Set(['other']), deriveStatus)).toBe(fleet);
  });

  it('takes the deleted incident off its unit and clears the red status', () => {
    const [v, c] = withoutDismissed([flagged, clean], new Set(['inc-1']), deriveStatus);
    expect(v.fuelIncident).toBeNull();
    expect(v.status).toBe('idling');
    expect(c).toBe(clean);
  });

  it('keeps a unit speeding if it is speeding', () => {
    const [v] = withoutDismissed([{ ...flagged, speed: 120, speedLimit: 80 }], new Set(['inc-1']), deriveStatus);
    expect(v.status).toBe('speeding');
  });

  it('brings a newer incident on the same unit back', () => {
    const [v] = withoutDismissed([{ ...flagged, fuelIncident: { id: 'inc-2' } }], new Set(['inc-1']), deriveStatus);
    expect(v.fuelIncident.id).toBe('inc-2');
  });
});
