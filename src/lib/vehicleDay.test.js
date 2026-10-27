import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../services/api';
import { _resetVehicleDay, burnAgainst, burnRate, overWords, cachedDay, decodeColumns, fuelFromLevel, journeySoFar, loadDay, mergeNewer, summariseDay, movingSpans } from './vehicleDay';

const DAY = '2026-09-20'; // a finished day
const FROM = Date.parse('2026-09-19T21:00:00.000Z');

const columns = (over = {}) => ({
  from: FROM, complete: true,
  t: [0, 30], lat: [-1, -1.001], lng: [36, 36], spd: [0, 40], eng: [1, null], fuelMl: [100000, null], hrs: [10, 10.01],
  ...over,
});

beforeEach(() => {
  _resetVehicleDay();
  apiFetch.mockReset();
});

describe('decodeColumns', () => {
  it('turns columns back into pings', () => {
    const p = decodeColumns(columns());
    expect(p).toHaveLength(2);
    expect(p[0]).toMatchObject({ t: FROM, speedKmh: 0, engineOn: true, fuelLevelMl: 100000 });
    expect(p[1]).toMatchObject({ t: FROM + 30_000, engineOn: null, fuelLevelMl: null });
  });
});

describe('mergeNewer', () => {
  it('keeps only rows after the last one held', () => {
    const held = [{ t: 1 }, { t: 2 }];
    expect(mergeNewer(held, [{ t: 2 }, { t: 3 }]).map((p) => p.t)).toEqual([1, 2, 3]);
    expect(mergeNewer(held, [{ t: 1 }])).toBe(held);
  });
});

describe('loadDay', () => {
  it('reads the day in one request and keeps a finished day for good', async () => {
    apiFetch.mockResolvedValue({ data: columns() });
    const a = await loadDay('o', 'v', DAY);
    expect(a.pings).toHaveLength(2);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe(`/api/v1/organisations/o/vehicles/v/telemetry/day?day=${DAY}`);
    expect(cachedDay('o', 'v', DAY)).toBe(a);
    await loadDay('o', 'v', DAY);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('shares one request between two readers', async () => {
    apiFetch.mockResolvedValue({ data: columns() });
    await Promise.all([loadDay('o', 'v', DAY), loadDay('o', 'v', DAY)]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('asks only for what came after the last row of an unfinished day', async () => {
    apiFetch.mockResolvedValueOnce({ data: columns({ complete: false }) })
      .mockResolvedValueOnce({ data: columns({ complete: false, t: [60], lat: [-1], lng: [36], spd: [5], eng: [1], fuelMl: [99000], hrs: [10.02] }) });
    await loadDay('o', 'v', DAY);
    const b = await loadDay('o', 'v', DAY);
    expect(apiFetch.mock.calls[1][0]).toContain(`&since=${FROM + 30_000}`);
    expect(b.pings.map((p) => p.t - FROM)).toEqual([0, 30_000, 60_000]);
  });

  it('falls back to the list, read in parallel windows, where the day route is missing', async () => {
    apiFetch.mockImplementation(async (url) => {
      if (url.includes('/telemetry/day')) throw Object.assign(new Error('Not found'), { status: 404 });
      const from = Date.parse(new URL(url, 'http://x').searchParams.get('from'));
      return { data: [{ capturedAt: new Date(from + 1000).toISOString(), speedKmh: 1 }], meta: { hasNextPage: false } };
    });
    const r = await loadDay('o', 'v', DAY);
    const listCalls = apiFetch.mock.calls.filter(([u]) => !u.includes('/telemetry/day'));
    expect(listCalls.length).toBe(12);   // 2 h windows over a finished day
    expect(r.pings).toHaveLength(12);
    expect(r.complete).toBe(true);

    // It remembers: the next day goes straight to the list.
    apiFetch.mockClear();
    await loadDay('o', 'v2', DAY);
    expect(apiFetch.mock.calls.some(([u]) => u.includes('/telemetry/day'))).toBe(false);
  });

  it('does not fall back on a real failure', async () => {
    apiFetch.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    await expect(loadDay('o', 'v', DAY)).rejects.toThrow('boom');
  });
});

// ── summaries ──────────────────────────────────────────────────────────────

const MIN = 60_000;
function day(levelsL, { speed = 30, step = MIN, lat0 = -1 } = {}) {
  return levelsL.map((l, i) => ({
    t: FROM + i * step, fuelLevelMl: l * 1000, speedKmh: speed, engineOn: true,
    lat: lat0 + i * 0.001, lng: 36, engineHoursMeter: 100 + i * (step / 3_600_000),
  }));
}

describe('fuelFromLevel', () => {
  it('reads use off the ends, so slosh does not add up', () => {
    // Falls 200 -> 180 with ±3 L of noise on every reading
    const lv = Array.from({ length: 60 }, (_, i) => 200 - i / 3 + (i % 2 ? 3 : -3));
    const { usedL, refilledL } = fuelFromLevel(day(lv), 400);
    expect(refilledL).toBe(0);
    expect(usedL).toBeGreaterThan(12);   // true use ~19.7 L; the ends carry the ±3 L noise
    expect(usedL).toBeLessThan(25);
  });

  it('adds a refill back in', () => {
    const lv = [...Array(20).fill(100), ...Array(20).fill(300), ...Array(20).fill(290)];
    const { usedL, refilledL } = fuelFromLevel(day(lv), 400);
    expect(refilledL).toBeCloseTo(200, 0);
    expect(usedL).toBeCloseTo(10, 0);
  });

  it('says nothing from too few readings', () => {
    expect(fuelFromLevel(day([100, 90]), 400).usedL).toBeNull();
  });
});

describe('summariseDay', () => {
  it('charts litres when the tank size is unknown', () => {
    const s = summariseDay(day(Array(12).fill(120)), null);
    expect(s.unit).toBe('L');
    expect(s.series[0].v).toBe(120);
  });

  it('charts percent when it is known', () => {
    const s = summariseDay(day(Array(12).fill(100)), 400);
    expect(s.unit).toBe('%');
    expect(s.series[0].v).toBe(25);
    expect(s.series[0].l).toBe(100);   // the crosshair reads litres either way
  });

  it('fills distance, moving time, engine hours and the first move', () => {
    const s = summariseDay(day(Array(11).fill(100)), 400);
    expect(s.distanceKm).toBeCloseTo(1.11, 1);   // 10 hops of 0.001°
    expect(s.movingMin).toBe(10);
    expect(s.engineHoursToday).toBeCloseTo(10 / 60, 3);
    expect(s.firstMove.t).toBe(FROM);
    expect(s.usedSource).toBe('level');
  });

  it('prefers the consumption counter where there is one', () => {
    const p = day(Array(12).fill(100)).map((x, i) => ({ ...x, fuelUsedMl: 5000 + i * 1000 }));
    const s = summariseDay(p, 400);
    expect(s.usedL).toBe(11);
    expect(s.usedSource).toBe('counter');
  });

  it('drops a hop that would need more than 200 km/h', () => {
    const p = day(Array(3).fill(100));
    p[2] = { ...p[2], lat: 0 };   // ~110 km in a minute
    expect(summariseDay(p, 400).distanceKm).toBeCloseTo(0.11, 1);
  });

  it('is empty, not zero, with no pings', () => {
    const s = summariseDay([], 400);
    expect(s.distanceKm).toBeNull();
    expect(s.usedL).toBeNull();
  });
});

describe('journeySoFar', () => {
  it('starts at the first move and counts the ground covered since', () => {
    // Parked for three readings, then off north at 0.001° a minute
    const pings = day(Array(11).fill(100)).map((p, i) => (i < 3 ? { ...p, speedKmh: 0, lat: -1 + 3 * 0.001 } : p));
    const j = journeySoFar(pings);
    expect(j.start).toEqual({ t: FROM + 3 * MIN, lat: pings[3].lat, lng: 36 });
    expect(j.km).toBeCloseTo(0.78, 1);   // 7 hops of 0.001°
  });

  it('has no start and no distance on a day the unit stood still', () => {
    expect(journeySoFar(day(Array(6).fill(100), { speed: 0 }))).toEqual({ start: null, km: 0, burn: null });
  });
});


describe('movingSpans', () => {
  const at = (min, speedKmh) => ({ t: min * 60_000, speedKmh });
  it('joins touching moving readings and breaks at a stop or a long silence', () => {
    const spans = movingSpans([at(0, 30), at(1, 40), at(2, 0), at(5, 20), at(6, 25), at(30, 25)]);
    expect(spans).toEqual([{ start: 0, end: 120_000 }, { start: 300_000, end: 360_000 }]);
  });
});

describe('burnRate', () => {
  const sum = (o) => ({ usedL: 40, engineHoursToday: null, engineOnMin: null, distanceKm: null, ...o });

  it('is litres per engine hour off the meter, with litres per km once it has driven', () => {
    const b = burnRate(sum({ engineHoursToday: 4, engineOnMin: 300, distanceKm: 120 }));
    expect(b.lPerH).toBeCloseTo(10);
    expect(b.lPerKm).toBeCloseTo(1 / 3);
    expect(b.hoursFrom).toBe('meter');
  });

  it('falls back to the time the engine was on when the meter did not tick', () => {
    const b = burnRate(sum({ engineOnMin: 240 }));
    expect(b.lPerH).toBeCloseTo(10);
    expect(b.lPerKm).toBeNull();
    expect(b.hoursFrom).toBe('engine');
  });

  it('says nothing on a day too thin to support a rate', () => {
    expect(burnRate(sum({ engineOnMin: 10, distanceKm: 2 }))).toBeNull();
    expect(burnRate(sum({ usedL: null, engineHoursToday: 5 }))).toBeNull();
    expect(burnRate(sum({ usedL: 0.4, engineHoursToday: 5 }))).toBeNull();
  });
});

describe('burnAgainst', () => {
  const burn = { lPerH: 12, lPerKm: 0.5, usedL: 48 };

  it('is null for a unit the register does not rate', () => {
    expect(burnAgainst(burn, null)).toBeNull();
  });

  it('reads an HOURS unit in L/h: more litres an hour is over', () => {
    const v = burnAgainst(burn, { value: 10, basis: 'HOURS' });
    expect(v).toMatchObject({ unit: 'L/h', digits: 1, std: 10, today: 12, high: true });
    expect(v.over).toBeCloseTo(0.2);
    expect(overWords(v.over)).toBe('20% over standard');
  });

  it('reads a DISTANCE unit in L/km, the register\'s km/L turned round: more litres a km is over', () => {
    const v = burnAgainst(burn, { value: 2.5, basis: 'DISTANCE' });
    expect(v).toMatchObject({ unit: 'L/km', digits: 2, today: 0.5 });
    expect(v.std).toBeCloseTo(0.4);
    expect(v.over).toBeCloseTo(0.25);
    expect(burnAgainst({ ...burn, lPerKm: 1 / 3 }, { value: 2.5, basis: 'DISTANCE' }).high).toBe(false);
  });

  it('keeps the standard when today cannot be measured yet', () => {
    expect(burnAgainst(null, { value: 10, basis: 'HOURS' })).toMatchObject({ std: 10, today: null, over: null, high: false });
  });
});
