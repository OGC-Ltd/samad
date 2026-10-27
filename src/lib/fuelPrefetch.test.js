import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../services/api';
import { prefetchFuelAlert } from './fuelPrefetch';
import { _resetFuelDay, cachedTankState, loadTankState } from '../hooks/useFuelDay';
import { _resetVehicleFuelEvents, cachedVehicleFuelEvents, loadVehicleFuelEvents } from '../hooks/useVehicleFuelEvents';
import { _resetVehicleDay, cachedDay } from './vehicleDay';
import { _resetReviews, reviewRightsNow } from './fuelReview';

/**
 * A fuel alert's window and side panel open complete (operator, 27 Sep:
 * "ensure that everything is already mapped on it"): everything they draw is
 * read ahead into the copies they draw from.
 */

const NOW = Date.parse('2026-09-27T15:00:00.000Z');   // 18:00 in Nairobi
const TODAY = '2026-09-27';

// Answers by route; counts every call so re-reads can be checked.
function serve() {
  apiFetch.mockImplementation(async (url) => {
    if (url.includes('/telemetry/day')) return { data: { from: Date.parse('2026-09-26T21:00:00Z'), complete: false, t: [0, 60], lat: [-8.5, -8.5], lng: [35.3, 35.3], spd: [0, 0], eng: [0, 0], fuelMl: [680000, 659000], hrs: [1, 1] } };
    if (url.includes('/fuel/tank-state')) return { data: [{ vehicleId: 'v1', openingMl: 691700 }, { vehicleId: 'v2', openingMl: 1 }] };
    if (url.includes('/fuel/thefts/review-rights')) return { data: { canReview: true } };
    if (url.includes('/fuel/thefts?')) return { data: [{ id: 'd1', drainCause: 'SIPHON' }] };
    if (url.includes('/fuel/fillings?')) return { data: [] };
    throw new Error(`unexpected ${url}`);
  });
}
const calls = (part) => apiFetch.mock.calls.filter(([u]) => u.includes(part)).length;

const unit = (beganAt) => ({
  id: 'CTR 07', vehicleId: 'v1',
  fuelIncident: { id: 'inc-1', beganAt, mayUseTheftWording: true },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  _resetFuelDay();
  _resetVehicleFuelEvents();
  _resetVehicleDay();
  _resetReviews();
  apiFetch.mockReset();
  serve();
});
afterEach(() => vi.useRealTimers());

describe('prefetchFuelAlert', () => {
  it('holds the window\'s day, the panel\'s chart and the review rights before anything opens', async () => {
    await prefetchFuelAlert('org', unit('2026-09-27T05:11:00.000Z'));

    expect(cachedTankState('org', TODAY).byVehicle.get('v1')).toMatchObject({ openingMl: 691700 });
    expect(cachedVehicleFuelEvents('org', 'v1', TODAY).drains).toHaveLength(1);
    expect(cachedDay('org', 'v1', TODAY).pings).toHaveLength(2);
    expect(reviewRightsNow('org')).toBe(true);
  });

  it('reads an incident from yesterday for that day, and today for the chart', async () => {
    await prefetchFuelAlert('org', unit('2026-09-26T18:00:00.000Z'));
    expect(cachedVehicleFuelEvents('org', 'v1', '2026-09-26')).not.toBeNull();
    expect(cachedVehicleFuelEvents('org', 'v1', TODAY)).not.toBeNull();
    expect(cachedTankState('org', '2026-09-26')).not.toBeNull();
  });

  it('never rejects, so one failed read does not stop the rest', async () => {
    apiFetch.mockImplementation(async (url) => {
      if (url.includes('/fuel/tank-state')) throw new Error('down');
      return { data: url.includes('/telemetry/day') ? { t: [], complete: false } : [] };
    });
    await expect(prefetchFuelAlert('org', unit('2026-09-27T05:11:00.000Z'))).resolves.toBeDefined();
    expect(cachedVehicleFuelEvents('org', 'v1', TODAY)).not.toBeNull();
  });

  it('does nothing for a unit with no incident', async () => {
    await prefetchFuelAlert('org', { id: 'X', vehicleId: 'v9', fuelIncident: null });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

describe('the held copies', () => {
  it('serve today again without a request while fresh, and re-read after a minute', async () => {
    await loadVehicleFuelEvents('org', 'v1', TODAY);
    await loadVehicleFuelEvents('org', 'v1', TODAY);
    expect(calls('/fuel/thefts?')).toBe(1);

    vi.setSystemTime(NOW + 61_000);
    await loadVehicleFuelEvents('org', 'v1', TODAY);
    expect(calls('/fuel/thefts?')).toBe(2);
  });

  it('keep a finished day for good', async () => {
    await loadTankState('org', '2026-09-20');
    vi.setSystemTime(NOW + 3_600_000);
    await loadTankState('org', '2026-09-20');
    expect(calls('/fuel/tank-state')).toBe(1);
  });

  it('share one request between two readers asking at once', async () => {
    await Promise.all([loadTankState('org', TODAY), loadTankState('org', TODAY)]);
    expect(calls('/fuel/tank-state')).toBe(1);
  });
});
