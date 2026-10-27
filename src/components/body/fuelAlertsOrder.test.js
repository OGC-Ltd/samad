import { describe, it, expect } from 'vitest';
import { byMostRecent } from './FuelAlertsMenu.jsx';

const unit = (id, beganAt, detectedAt) => ({ id, fuelIncident: { beganAt, detectedAt } });

describe('byMostRecent', () => {
  it('puts the drain that began most recently first, whatever its volume', () => {
    const list = [
      unit('A', '2026-09-24T08:00:00Z', '2026-09-24T08:30:00Z'),
      unit('B', '2026-09-24T17:00:00Z', '2026-09-24T17:20:00Z'),
      unit('C', '2026-09-23T22:00:00Z', '2026-09-24T01:00:00Z'),
    ];
    expect(list.sort(byMostRecent).map(v => v.id)).toEqual(['B', 'A', 'C']);
  });

  it('breaks a tie on start time by the later report', () => {
    const list = [
      unit('early', '2026-09-24T10:00:00Z', '2026-09-24T10:05:00Z'),
      unit('late',  '2026-09-24T10:00:00Z', '2026-09-24T10:40:00Z'),
    ];
    expect(list.sort(byMostRecent).map(v => v.id)).toEqual(['late', 'early']);
  });

  it('falls back to the report time when the start is missing, and sinks rows with neither', () => {
    const list = [
      unit('none', null, null),
      unit('reportOnly', null, '2026-09-24T12:00:00Z'),
      unit('began', '2026-09-24T11:00:00Z', '2026-09-24T11:10:00Z'),
    ];
    expect(list.sort(byMostRecent).map(v => v.id)).toEqual(['reportOnly', 'began', 'none']);
  });
});
